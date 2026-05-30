/**
 * Claude Code task server — lets containers invoke the Claude CLI on the host.
 *
 * POST /claude-task  { prompt: string, timeout?: number }
 *   -> { ok: true, output: string }
 *   -> { ok: false, error: string }
 *
 * Single-concurrency: returns 429 if a task is already running.
 * Binds to 127.0.0.1 only (containers reach via host.docker.internal).
 */
import { createServer, Server } from 'http';
import { spawn } from 'child_process';

import { logger } from './logger.js';

const DEFAULT_TIMEOUT = 300_000; // 5 minutes
const MAX_TIMEOUT = 600_000; // 10 minutes

let busy = false;

function runClaude(
  prompt: string,
  timeout: number,
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--dangerously-skip-permissions'];
    const child = spawn('claude', args, {
      cwd: process.cwd(),
      timeout,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        resolve({ ok: false, error: `Timed out after ${timeout}ms` });
      }
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve({ ok: true, output: stdout.trim() });
      } else {
        resolve({
          ok: false,
          error: stderr.trim() || `Exit code ${code}`,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: err.message });
    });
  });
}

export function startClaudeTaskServer(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      res.setHeader('Connection', 'close');

      // Only POST /claude-task
      if (req.method !== 'POST' || req.url !== '/claude-task') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Not found' }));
        return;
      }

      // Single concurrency
      if (busy) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ ok: false, error: 'A task is already running' }),
        );
        return;
      }

      // Read body
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        let body: { prompt?: string; timeout?: number };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
          return;
        }

        if (!body.prompt || typeof body.prompt !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ ok: false, error: 'Missing prompt string' }),
          );
          return;
        }

        const timeout = Math.min(
          Math.max(body.timeout || DEFAULT_TIMEOUT, 1000),
          MAX_TIMEOUT,
        );

        busy = true;
        logger.info(
          { promptLength: body.prompt.length, timeout },
          'Claude task started',
        );

        try {
          const result = await runClaude(body.prompt, timeout);
          res.writeHead(result.ok ? 200 : 500, {
            'Content-Type': 'application/json',
          });
          res.end(JSON.stringify(result));
          logger.info(
            {
              ok: result.ok,
              outputLength: result.ok ? result.output.length : 0,
            },
            'Claude task completed',
          );
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
          logger.error({ err }, 'Claude task error');
        } finally {
          busy = false;
        }
      });
    });

    server.keepAliveTimeout = 0;

    server.on('error', (err: NodeJS.ErrnoException) => {
      logger.error({ err, port, host }, 'Claude task server failed to bind');
      reject(err);
    });

    server.listen(port, host, () => {
      logger.info({ port, host }, 'Claude task server started');
      resolve(server);
    });
  });
}
