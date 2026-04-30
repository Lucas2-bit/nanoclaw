/**
 * Claude task server — lets containers (e.g. Ulterior) invoke Claude Code CLI
 * on the host without raw shell access. Containers POST a prompt to
 * http://host.docker.internal:3002/claude-task and get the result back.
 *
 * One request runs at a time. Callers receive 429 if a task is already active.
 * Default timeout: 5 minutes.
 */
import { spawn } from 'child_process';
import { createServer, Server } from 'http';

import { logger } from './logger.js';

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

let busy = false;

export function startClaudeTaskServer(
  port: number,
  host: string,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      res.setHeader('Connection', 'close');
      res.setHeader('Content-Type', 'application/json');

      if (req.method !== 'POST' || req.url !== '/claude-task') {
        res.writeHead(404);
        res.end(JSON.stringify({ ok: false, error: 'Not found' }));
        return;
      }

      if (busy) {
        res.writeHead(429);
        res.end(
          JSON.stringify({ ok: false, error: 'A task is already running' }),
        );
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let body: { prompt?: string; timeout?: number };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
          return;
        }

        if (!body.prompt || typeof body.prompt !== 'string') {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'Missing prompt' }));
          return;
        }

        const timeoutMs =
          typeof body.timeout === 'number' && body.timeout > 0
            ? body.timeout
            : DEFAULT_TIMEOUT_MS;

        busy = true;
        logger.info(
          { promptLength: body.prompt.length },
          'Claude task started',
        );

        runClaudeTask(body.prompt, timeoutMs)
          .then((output) => {
            logger.info(
              { outputLength: output.length },
              'Claude task completed',
            );
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true, output }));
          })
          .catch((err: Error) => {
            logger.error({ err }, 'Claude task error');
            res.writeHead(500);
            res.end(JSON.stringify({ ok: false, error: err.message }));
          })
          .finally(() => {
            busy = false;
          });
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host }, 'Claude task server started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

function runClaudeTask(prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'claude',
      ['-p', prompt, '--dangerously-skip-permissions'],
      {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    proc.stdout.on('data', (d: Buffer) => stdout.push(d));
    proc.stderr.on('data', (d: Buffer) => stderr.push(d));

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Claude task timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString().trim();
      if (code === 0) {
        resolve(out);
      } else {
        const errOut = Buffer.concat(stderr).toString().trim();
        reject(new Error(`claude exited ${code}: ${errOut || out}`));
      }
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.stdin.end();
  });
}
