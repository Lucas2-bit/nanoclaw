#!/usr/bin/env node
// scripts/scan-secrets.cjs — secret-scanner used in two contexts:
//   * `--staged` mode: invoked from .husky/pre-commit; scans ONLY the files
//     in `git diff --cached --name-only`, so the developer can't ship a
//     credential they just typed.
//   * default mode: invoked by `npm run scan:secrets`, including from
//     scripts/deploy.sh; scans every git-tracked file in the repo.
//
// The core matching logic lives in scanContent() and is exported so the
// vitest suite can exercise it directly without spawning a process. The
// CJS entry point at the bottom wraps that function with the file-walk
// + git-plumbing concerns the scanner needs in production.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Paths we never scan, even if git tracks something inside (it shouldn't).
// dist/ and node_modules/ have legitimate token-shaped strings in third-
// party code; .git/ contains pack data that produces nonsense matches.
const HARD_EXCLUDE_DIRS = new Set(['node_modules', 'dist', '.git']);

const ALLOW_MARKER = 'secret-scan:allow';

// Patterns. Each entry: { name, regex, flags? }. The names are stable; the
// hook prints them in failure output so a developer can quickly understand
// which class of secret was flagged without having to read the source.
const PATTERNS = [
  { name: 'aws-akia', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'private-key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'google-api', regex: /AIza[0-9A-Za-z_\-]{35}/ },
  { name: 'slack-token', regex: /xox[baprs]-[0-9A-Za-z-]+/ },
  {
    name: 'generic-assignment',
    regex:
      /(secret|token|api[_-]?key|password)\s*[:=]\s*['"][^'"]{12,}['"]/i,
  },
];

// Mask a matched value so the failure output doesn't echo the secret. We
// keep first 4 + last 2 chars when long enough; short matches are fully
// masked.
function maskMatch(s) {
  if (typeof s !== 'string') return '***';
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}${'*'.repeat(Math.max(4, s.length - 6))}${s.slice(-2)}`;
}

// CORE: scan a text body, return an array of hits.
// Each hit: { line: 1-based, pattern: <name>, masked: <masked-match> }.
// Lines containing the ALLOW_MARKER are skipped entirely — that includes
// the secret itself and any inline comment on the same line.
function scanContent(text) {
  const hits = [];
  if (typeof text !== 'string' || text.length === 0) return hits;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(ALLOW_MARKER)) continue;
    for (const p of PATTERNS) {
      const m = line.match(p.regex);
      if (m) {
        hits.push({
          line: i + 1,
          pattern: p.name,
          masked: maskMatch(m[0]),
        });
      }
    }
  }
  return hits;
}

// Load .secretscanignore as a list of path-glob-ish prefixes (we keep it
// simple: a non-empty, non-comment line is matched against the relative
// path either as exact equality or as a prefix ending in '/').
function loadIgnore(repoRoot) {
  const file = path.join(repoRoot, '.secretscanignore');
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const raw of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    out.push(line);
  }
  return out;
}

function isIgnoredPath(relPath, ignoreEntries) {
  // Hard-exclude any path inside a HARD_EXCLUDE_DIRS segment.
  const segments = relPath.split('/');
  if (segments.some((s) => HARD_EXCLUDE_DIRS.has(s))) return true;
  for (const entry of ignoreEntries) {
    if (entry === relPath) return true;
    if (entry.endsWith('/') && relPath.startsWith(entry)) return true;
    // Allow trailing-slash-less prefix entries to match directory contents.
    if (relPath.startsWith(entry + '/')) return true;
  }
  return false;
}

function listGitFiles(repoRoot, staged) {
  const args = staged
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACMRT']
    : ['ls-files'];
  let out;
  try {
    out = execFileSync('git', args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  } catch {
    return [];
  }
  return out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Read a file as utf-8; return null if binary-ish or unreadable. We treat
// any file with a NUL byte in the first 8 KiB as binary and skip it.
function readTextOrNull(absPath) {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return null;
    // Cap at 4 MiB so a giant blob can't stall the hook.
    if (stat.size > 4 * 1024 * 1024) return null;
    const buf = fs.readFileSync(absPath);
    const probe = buf.subarray(0, Math.min(8192, buf.length));
    if (probe.includes(0)) return null;
    return buf.toString('utf-8');
  } catch {
    return null;
  }
}

// Read the STAGED blob for a repo-relative path via `git show :<rel>`. In
// --staged mode we must scan what's about to be committed, not the worktree
// (the developer may have already edited the file after `git add`).
function readStagedBlobOrNull(repoRoot, rel) {
  try {
    return execFileSync('git', ['show', ':' + rel], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

function runCli(argv) {
  const staged = argv.includes('--staged');
  const repoRoot = path.resolve(__dirname, '..');
  const ignoreEntries = loadIgnore(repoRoot);
  const files = listGitFiles(repoRoot, staged);

  let totalHits = 0;
  for (const rel of files) {
    if (isIgnoredPath(rel, ignoreEntries)) continue;
    const abs = path.join(repoRoot, rel);
    const text = staged
      ? readStagedBlobOrNull(repoRoot, rel)
      : readTextOrNull(abs);
    if (text === null) continue;
    const hits = scanContent(text);
    for (const h of hits) {
      // Print file:line pattern=<name> masked=<...>; the line is enough
      // for the developer to find the offending content without leaking
      // the secret to logs or CI output.
      process.stderr.write(
        `${rel}:${h.line} pattern=${h.pattern} masked=${h.masked}\n`,
      );
      totalHits++;
    }
  }

  if (totalHits > 0) {
    process.stderr.write(
      `scan-secrets: ${totalHits} hit(s) across ${files.length} candidate file(s). Mode=${
        staged ? 'staged' : 'tracked'
      }. To allow a specific line, append the marker '${ALLOW_MARKER}' on that line.\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `scan-secrets: clean (${files.length} file(s) scanned, mode=${
      staged ? 'staged' : 'tracked'
    })\n`,
  );
  process.exit(0);
}

module.exports = {
  PATTERNS,
  ALLOW_MARKER,
  scanContent,
  maskMatch,
  loadIgnore,
  isIgnoredPath,
};

// Only execute the CLI when this file is run directly, so the test file
// can `require()` it without triggering the process.exit() calls.
if (require.main === module) {
  runCli(process.argv.slice(2));
}
