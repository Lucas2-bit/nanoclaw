import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __testHooks,
  checkDistIntegrity,
  type IntegrityResult,
} from './integrity.js';

interface BuildInfoFixture {
  gitSha?: string;
  branch?: string | null;
  builtAt?: string;
  dirty?: boolean | null;
  packageVersion?: string | null;
  contentHash?: string | null;
}

function mkTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'integrity-test-'));
}

function writeDistJs(root: string, files: Record<string, string>): void {
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dist, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, 'utf-8');
  }
}

// Recompute the same algorithm scripts/dist-hash.cjs uses so tests can write
// build-info with a matching hash. If integrity ever changes its algorithm,
// this helper must change in lockstep — and the test failure will say so.
function computeHash(distDir: string): string {
  const collected: string[] = [];
  (function walk(dir: string): void {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && full.endsWith('.js'))
        collected.push(path.relative(distDir, full));
    }
  })(distDir);
  collected.sort();
  const hash = crypto.createHash('sha256');
  for (const rel of collected) {
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(distDir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function writeBuildInfo(root: string, info: BuildInfoFixture): void {
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(
    path.join(dist, 'build-info.json'),
    JSON.stringify(info),
    'utf-8',
  );
}

// Initialize a git repo with a single commit so HEAD resolves to a known sha.
function initRepo(root: string): string {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: root,
  });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
  fs.writeFileSync(path.join(root, 'README'), 'hi', 'utf-8');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root })
    .toString()
    .trim();
}

describe('checkDistIntegrity', () => {
  let root: string;

  beforeEach(() => {
    root = mkTmpRoot();
  });

  afterEach(() => {
    delete __testHooks.onEnter;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('flags drift when build-info is missing', () => {
    // dist exists but no build-info
    writeDistJs(root, { 'a.js': 'export const x = 1;\n' });
    const r = checkDistIntegrity({ projectRoot: root });
    expect(r.ok).toBe(false);
    expect(r.reasons.find((x) => x.code === 'no-provenance')).toBeTruthy();
  });

  it('flags drift when build-info.dirty is true', () => {
    writeDistJs(root, { 'a.js': 'x;\n' });
    const distDir = path.join(root, 'dist');
    writeBuildInfo(root, {
      gitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      dirty: true,
      contentHash: computeHash(distDir),
    });
    const r = checkDistIntegrity({ projectRoot: root });
    expect(r.ok).toBe(false);
    expect(r.reasons.find((x) => x.code === 'built-dirty')).toBeTruthy();
  });

  it('flags drift on sha-mismatch (clean build, HEAD differs)', () => {
    const headSha = initRepo(root);
    writeDistJs(root, { 'a.js': 'y;\n' });
    const distDir = path.join(root, 'dist');
    writeBuildInfo(root, {
      gitSha: 'a'.repeat(40),
      dirty: false,
      contentHash: computeHash(distDir),
    });
    const r = checkDistIntegrity({ projectRoot: root });
    expect(r.ok).toBe(false);
    expect(r.reasons.find((x) => x.code === 'sha-mismatch')).toBeTruthy();
    expect(r.details.headSha).toBe(headSha);
  });

  it('flags drift on content-mismatch', () => {
    writeDistJs(root, { 'a.js': 'original;\n' });
    const distDir = path.join(root, 'dist');
    const correctHash = computeHash(distDir);
    // Tamper with dist after stamping
    writeBuildInfo(root, {
      gitSha: 'a'.repeat(40),
      dirty: false,
      contentHash: correctHash,
    });
    fs.writeFileSync(path.join(distDir, 'a.js'), 'tampered;\n', 'utf-8');
    const r = checkDistIntegrity({ projectRoot: root });
    expect(r.ok).toBe(false);
    expect(r.reasons.find((x) => x.code === 'content-mismatch')).toBeTruthy();
  });

  it('keeps ok=true for advisory: head-unknown (no git repo)', () => {
    writeDistJs(root, { 'a.js': 'z;\n' });
    const distDir = path.join(root, 'dist');
    writeBuildInfo(root, {
      gitSha: 'a'.repeat(40),
      dirty: false,
      contentHash: computeHash(distDir),
    });
    const r = checkDistIntegrity({ projectRoot: root });
    // No git repo in tmp -> head-unknown advisory, but no drift, so ok stays true.
    // (sha-mismatch requires headSha, so it won't fire either.)
    expect(r.reasons.find((x) => x.code === 'head-unknown')).toBeTruthy();
    expect(r.ok).toBe(true);
  });

  it('keeps ok=true for advisory: src-newer-than-dist', () => {
    // Build dist first (older mtimes), then src files (newer mtimes).
    writeDistJs(root, { 'a.js': 'q;\n' });
    const distDir = path.join(root, 'dist');
    const oldTime = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(path.join(distDir, 'a.js'), oldTime, oldTime);
    writeBuildInfo(root, {
      gitSha: 'a'.repeat(40),
      dirty: false,
      contentHash: computeHash(distDir),
    });
    // build-info.json mtime needs to be old too, otherwise the dist newest
    // baseline shifts — but the check uses .js files only, so we're safe.
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'q;\n', 'utf-8');
    const r = checkDistIntegrity({ projectRoot: root });
    expect(r.reasons.find((x) => x.code === 'src-newer-than-dist')).toBeTruthy();
    expect(r.ok).toBe(true);
  });

  it('never throws when the body would throw — returns ok:true with check-error advisory', () => {
    __testHooks.onEnter = () => {
      throw new Error('synthetic');
    };
    let r: IntegrityResult | undefined;
    expect(() => {
      r = checkDistIntegrity({ projectRoot: root });
    }).not.toThrow();
    expect(r!.ok).toBe(true);
    const advisory = r!.reasons.find((x) => x.code === 'check-error');
    expect(advisory).toBeTruthy();
    expect(advisory!.severity).toBe('advisory');
  });
});
