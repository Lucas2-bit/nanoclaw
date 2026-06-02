// Shared dist content hash. Required by both scripts/gen-build-info.cjs
// (build time, CommonJS) and src/integrity.ts (runtime check, via require()).
// IMPORTANT: the algorithm here is the single source of truth — if you change
// it, both the build stamp and the integrity check must observe the new value
// or every running process will spuriously trip "content-mismatch".
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Walk dist/ collecting every .js file path (relative to distDir), sorted.
// Excludes dist/build-info.json so the hash never depends on itself.
function listDistJs(distDir) {
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && full.endsWith('.js')) {
        out.push(path.relative(distDir, full));
      }
    }
  }
  walk(distDir);
  out.sort();
  return out;
}

// Returns hex sha256 over: for each sorted relative path, "<relpath>\0<file bytes>\0".
// Returns null if distDir is missing or unreadable; the caller treats null as
// "no provenance available", not as an error.
function computeDistContentHash(distDir) {
  try {
    if (!fs.existsSync(distDir)) return null;
    const files = listDistJs(distDir);
    const hash = crypto.createHash('sha256');
    for (const rel of files) {
      hash.update(rel);
      hash.update('\0');
      hash.update(fs.readFileSync(path.join(distDir, rel)));
      hash.update('\0');
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

module.exports = { computeDistContentHash, listDistJs };
