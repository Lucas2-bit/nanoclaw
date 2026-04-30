/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * Telemetry: extracts token usage from SSE streams and non-streaming
 * responses on /messages endpoints. Logs to provider-router telemetry.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import { Transform, TransformCallback } from 'stream';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  extractModelFromRequest,
  processResponse,
  type TokenUsage,
  logTelemetry,
  type TelemetryEntry,
} from './provider-router.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // Disable keep-alive on individual responses so connections close
      // immediately after each request. This ensures the port is released
      // promptly on shutdown and prevents EADDRINUSE on restart.
      res.setHeader('Connection', 'close');
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const startTime = Date.now();
        const requestPath = req.url || '';
        const isMessagesEndpoint = requestPath.includes('/messages');

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            const contentType = (upRes.headers['content-type'] || '') as string;
            const isSSE = contentType.includes('text/event-stream');
            const statusCode = upRes.statusCode || 0;

            res.writeHead(statusCode, upRes.headers);

            if (
              isMessagesEndpoint &&
              isSSE &&
              statusCode >= 200 &&
              statusCode < 300
            ) {
              // SSE stream: tee to extract usage from message_start and message_delta events
              let inputTokens = 0;
              let outputTokens = 0;
              let cacheCreationTokens = 0;
              let cacheReadTokens = 0;
              let sseBuffer = '';

              const tee = new Transform({
                transform(
                  chunk: Buffer,
                  _encoding: BufferEncoding,
                  callback: TransformCallback,
                ) {
                  // Pass chunk through to client immediately
                  this.push(chunk);

                  // Parse SSE events for usage data
                  sseBuffer += chunk.toString('utf-8');
                  const lines = sseBuffer.split('\n');
                  // Keep the last incomplete line in the buffer
                  sseBuffer = lines.pop() || '';

                  for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;
                    try {
                      const event = JSON.parse(data);
                      if (
                        event.type === 'message_start' &&
                        event.message?.usage
                      ) {
                        inputTokens = event.message.usage.input_tokens || 0;
                        cacheCreationTokens =
                          event.message.usage.cache_creation_input_tokens || 0;
                        cacheReadTokens =
                          event.message.usage.cache_read_input_tokens || 0;
                      } else if (
                        event.type === 'message_delta' &&
                        event.usage
                      ) {
                        outputTokens = event.usage.output_tokens || 0;
                      }
                    } catch {
                      // Not valid JSON - skip
                    }
                  }

                  callback();
                },
                flush(callback: TransformCallback) {
                  // Stream complete - log telemetry
                  if (inputTokens > 0 || outputTokens > 0) {
                    const model = extractModelFromRequest(body) || 'unknown';
                    const pricing: Record<
                      string,
                      {
                        input: number;
                        output: number;
                        cache_write: number;
                        cache_read: number;
                      }
                    > = {
                      'claude-opus-4-6': {
                        input: 15.0,
                        output: 75.0,
                        cache_write: 18.75,
                        cache_read: 1.5,
                      },
                      'claude-sonnet-4-6': {
                        input: 3.0,
                        output: 15.0,
                        cache_write: 3.75,
                        cache_read: 0.3,
                      },
                      'claude-haiku-4-5-20251001': {
                        input: 0.8,
                        output: 4.0,
                        cache_write: 1.0,
                        cache_read: 0.08,
                      },
                    };
                    const p = pricing[model] || {
                      input: 3.0,
                      output: 15.0,
                      cache_write: 3.75,
                      cache_read: 0.3,
                    };
                    const perM = 1_000_000;
                    const cost =
                      (inputTokens * p.input +
                        outputTokens * p.output +
                        cacheCreationTokens * p.cache_write +
                        cacheReadTokens * p.cache_read) /
                      perM;

                    const entry: TelemetryEntry = {
                      ts: new Date().toISOString(),
                      model,
                      provider: 'anthropic',
                      input_tokens: inputTokens,
                      output_tokens: outputTokens,
                      cache_creation_tokens: cacheCreationTokens,
                      cache_read_tokens: cacheReadTokens,
                      cost_usd: cost,
                      latency_ms: Date.now() - startTime,
                      request_path: requestPath,
                      status_code: statusCode,
                    };
                    logTelemetry(entry).catch(() => {});
                  }
                  callback();
                },
              });

              tee.on('data', (chunk: Buffer) => res.write(chunk));
              tee.on('end', () => res.end());
              tee.on('error', () => res.end());
              upRes.pipe(tee);
            } else if (
              isMessagesEndpoint &&
              !isSSE &&
              statusCode >= 200 &&
              statusCode < 300
            ) {
              // Non-streaming response: buffer, extract usage, forward
              const responseChunks: Buffer[] = [];
              upRes.on('data', (chunk: Buffer) => {
                responseChunks.push(chunk);
                res.write(chunk);
              });
              upRes.on('end', () => {
                const responseBody = Buffer.concat(responseChunks);
                processResponse(
                  body,
                  responseBody,
                  statusCode,
                  requestPath,
                  startTime,
                );
                res.end();
              });
            } else {
              // Non-messages endpoint or error: pass through unchanged
              upRes.pipe(res);
            }
          },
        );

        upstream.on('socket', (socket) => {
          socket.setKeepAlive(true, 30000); // ping every 30s to keep connection alive
        });
        upstream.setTimeout(300000); // 5-min inactivity ceiling before giving up

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    // keepAliveTimeout=0 tells Node to close idle keep-alive connections
    // immediately rather than holding the socket open. Combined with the
    // per-response 'Connection: close' header above, this ensures the port
    // is released as soon as the server stops accepting new connections.
    server.keepAliveTimeout = 0;

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    let retryCount = 0;
    const MAX_RETRIES = 5;
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && retryCount < MAX_RETRIES) {
        retryCount++;
        logger.warn(
          { port, attempt: retryCount, maxRetries: MAX_RETRIES },
          'Credential proxy: port in use, retrying in 2s...',
        );
        setTimeout(() => {
          server.close();
          server.listen(port, host, () => {
            logger.info(
              { port, host, authMode, attempt: retryCount },
              'Credential proxy started (retry)',
            );
            resolve(server);
          });
        }, 2000);
      } else {
        reject(err);
      }
    });
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
