#!/usr/bin/env node
// Writes dist/build-info.json after `tsc` runs (wired as `postbuild`).
// MUST NEVER THROW — boot, watchdog, and runtime integrity check all read
// this file and a missing/garbled stamp is itself a signal, not a crash.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { computeDistContentHash } = require('./dist-hash.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');
const OUT_PATH = path.join(DIST_DIR, 'build-info.json');

function safeGit(args) {
  try {
    return execFileSync('git', args, {
      cwd: PROJECT_ROOT,
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function readPackageVersion() {
  try {
    const raw = fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw);
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function main() {
  const gitSha = safeGit(['rev-parse', 'HEAD']);
  const branch = safeGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const porcelain = safeGit(['status', '--porcelain']);

  // dirty is bool only when git succeeded; null when we couldn't ask.
  const dirty = porcelain === null ? null : porcelain.length > 0;

  // contentHash: null if dist/ doesn't exist yet (e.g. first build before tsc
  // emitted anything in this hook's invocation order — postbuild runs after,
  // but be defensive).
  const contentHash = fs.existsSync(DIST_DIR)
    ? computeDistContentHash(DIST_DIR)
    : null;

  const info = {
    gitSha: gitSha || 'unknown',
    gitShaShort: gitSha ? gitSha.slice(0, 7) : 'unknown',
    branch: branch || null,
    builtAt: new Date().toISOString(),
    dirty,
    packageVersion: readPackageVersion(),
    contentHash,
  };

  try {
    fs.mkdirSync(DIST_DIR, { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(info, null, 2) + '\n', 'utf-8');
  } catch (err) {
    // Last-ditch: print to stderr but exit 0. We do NOT want to fail `npm run
    // build` because the stamp couldn't be written.
    process.stderr.write(
      `gen-build-info: failed to write ${OUT_PATH}: ${err && err.message}\n`,
    );
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `gen-build-info: unexpected error (ignored): ${err && err.message}\n`,
  );
}
