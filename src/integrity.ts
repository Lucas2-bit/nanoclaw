import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// createRequire is needed because the project is "type": "module" and
// dist-hash.cjs is CommonJS. The require itself is deferred (see
// loadComputeDistContentHash below) so a missing/corrupt dist-hash.cjs
// cannot throw at module load and kill the boot process — integrity.js is
// statically imported from src/index.ts, so any throw here would precede
// the boot try/catch and cause a silent outage. Algorithm parity with
// scripts/gen-build-info.cjs is enforced by both call sites going through
// the same CJS module.
const requireCjs = createRequire(import.meta.url);

type ComputeDistContentHash = (distDir: string) => string | null;

let _computeDistContentHash: ComputeDistContentHash | null = null;
let _computeDistContentHashLoaded = false;

// Lazy, fail-soft loader. Caches both success and failure so repeated calls
// don't keep retrying a require() that already failed. On any throw we fall
// back to a shim that returns null, degrading content-hash checks to the
// "content-hash-unavailable" advisory rather than crashing.
function loadComputeDistContentHash(): ComputeDistContentHash {
  if (_computeDistContentHashLoaded && _computeDistContentHash) {
    return _computeDistContentHash;
  }
  _computeDistContentHashLoaded = true;
  try {
    const mod = requireCjs('../scripts/dist-hash.cjs') as {
      computeDistContentHash?: ComputeDistContentHash;
    };
    if (typeof mod.computeDistContentHash === 'function') {
      _computeDistContentHash = mod.computeDistContentHash;
    } else {
      _computeDistContentHash = () => null;
    }
  } catch (e) {
    console.warn(
      `integrity: failed to load dist-hash.cjs (${
        e instanceof Error ? e.message : String(e)
      }) — content-hash checks will be advisory`,
    );
    _computeDistContentHash = () => null;
  }
  return _computeDistContentHash;
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
// integrity.ts lives in src/ (dev) or dist/ (prod); both are direct children
// of the project root.
const DEFAULT_PROJECT_ROOT = path.resolve(MODULE_DIR, '..');

export type IntegritySeverity = 'drift' | 'advisory';

export interface IntegrityReason {
  code: string;
  severity: IntegritySeverity;
  message: string;
}

export interface IntegrityDetails {
  buildSha?: string | null;
  headSha?: string | null;
  dirty?: boolean | null;
  branch?: string | null;
  builtAt?: string | null;
  expectedContentHash?: string | null;
  actualContentHash?: string | null;
}

export interface IntegrityResult {
  ok: boolean;
  reasons: IntegrityReason[];
  details: IntegrityDetails;
}

export interface CheckOptions {
  projectRoot?: string;
}

// Test-only seam: vitest can stub onEnter() to throw, which proves the outer
// catch returns ok:true with a "check-error" advisory. Production code never
// touches this — the if-check is a single property read per call.
export const __testHooks: { onEnter?: () => void } = {};

interface BuildInfo {
  gitSha?: string;
  gitShaShort?: string;
  branch?: string | null;
  builtAt?: string;
  dirty?: boolean | null;
  packageVersion?: string | null;
  contentHash?: string | null;
}

function readHeadSha(projectRoot: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

function walkMtimes(dir: string, suffix: string): number[] {
  const result: number[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      result.push(...walkMtimes(full, suffix));
    } else if (e.isFile() && full.endsWith(suffix)) {
      try {
        result.push(fs.statSync(full).mtimeMs);
      } catch {
        /* skip unreadable file */
      }
    }
  }
  return result;
}

export function checkDistIntegrity(opts: CheckOptions = {}): IntegrityResult {
  const reasons: IntegrityReason[] = [];
  const details: IntegrityDetails = {};
  try {
    if (__testHooks.onEnter) __testHooks.onEnter();
    const projectRoot = opts.projectRoot ?? DEFAULT_PROJECT_ROOT;
    const distDir = path.join(projectRoot, 'dist');
    const buildInfoPath = path.join(distDir, 'build-info.json');

    // 1. build-info presence & shape
    let buildInfo: BuildInfo | null = null;
    try {
      const raw = fs.readFileSync(buildInfoPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') buildInfo = parsed as BuildInfo;
      else throw new Error('build-info is not an object');
    } catch {
      reasons.push({
        code: 'no-provenance',
        severity: 'drift',
        message: 'dist/build-info.json missing or unparseable',
      });
    }

    if (buildInfo) {
      details.buildSha = buildInfo.gitSha ?? null;
      details.dirty =
        typeof buildInfo.dirty === 'boolean' ? buildInfo.dirty : null;
      details.branch = buildInfo.branch ?? null;
      details.builtAt = buildInfo.builtAt ?? null;
      details.expectedContentHash = buildInfo.contentHash ?? null;

      // 2. built-from-dirty-tree
      if (buildInfo.dirty === true) {
        reasons.push({
          code: 'built-dirty',
          severity: 'drift',
          message: 'dist was built from a dirty working tree',
        });
      }
    }

    // 3. current HEAD
    const headSha = readHeadSha(opts.projectRoot ?? DEFAULT_PROJECT_ROOT);
    details.headSha = headSha;
    if (!headSha) {
      reasons.push({
        code: 'head-unknown',
        severity: 'advisory',
        message: 'git rev-parse HEAD failed',
      });
    }

    // 4. sha-mismatch (only when both sides known and the build itself was
    // clean — a dirty build already produced its own drift reason).
    if (
      buildInfo &&
      typeof buildInfo.gitSha === 'string' &&
      buildInfo.gitSha !== 'unknown' &&
      headSha &&
      buildInfo.gitSha !== headSha &&
      buildInfo.dirty !== true
    ) {
      reasons.push({
        code: 'sha-mismatch',
        severity: 'drift',
        message: `dist built from ${buildInfo.gitSha.slice(0, 7)}, HEAD is ${headSha.slice(0, 7)}`,
      });
    }

    // 5. recompute content hash & compare. Either side being null (build-info
    // had no contentHash, or computeDistContentHash returned null — including
    // the shim case when the CJS module failed to load) degrades to advisory,
    // never drift, never throw.
    if (buildInfo) {
      if (typeof buildInfo.contentHash !== 'string') {
        reasons.push({
          code: 'content-hash-unavailable',
          severity: 'advisory',
          message: 'build-info has no contentHash to compare against',
        });
      } else {
        let actualHash: string | null = null;
        try {
          const compute = loadComputeDistContentHash();
          actualHash = compute(distDir);
        } catch {
          actualHash = null;
        }
        details.actualContentHash = actualHash;
        if (actualHash === null) {
          reasons.push({
            code: 'content-hash-unavailable',
            severity: 'advisory',
            message: 'could not recompute dist content hash',
          });
        } else if (actualHash !== buildInfo.contentHash) {
          reasons.push({
            code: 'content-mismatch',
            severity: 'drift',
            message: `dist contentHash ${actualHash.slice(0, 12)} != expected ${String(
              buildInfo.contentHash,
            ).slice(0, 12)}`,
          });
        }
      }
    }

    // 6. mtime check — advisory only. Catches "you edited src but forgot to
    // rebuild" without the hash mismatch (e.g. comments-only changes that
    // didn't change a compiled .js but did touch a .ts).
    try {
      const srcDir = path.join(opts.projectRoot ?? DEFAULT_PROJECT_ROOT, 'src');
      const srcTimes = walkMtimes(srcDir, '.ts');
      const distTimes = walkMtimes(distDir, '.js');
      if (srcTimes.length > 0 && distTimes.length > 0) {
        const newestSrc = Math.max(...srcTimes);
        const oldestDist = Math.min(...distTimes);
        if (newestSrc > oldestDist) {
          reasons.push({
            code: 'src-newer-than-dist',
            severity: 'advisory',
            message: 'a source file is newer than the oldest compiled output',
          });
        }
      }
    } catch {
      /* advisory only — silent */
    }
  } catch (err) {
    // Absolute backstop. We must never let the integrity check itself crash
    // the host process. Surface as advisory so callers know we couldn't
    // actually decide.
    return {
      ok: true,
      reasons: [
        {
          code: 'check-error',
          severity: 'advisory',
          message: `integrity check threw: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      details,
    };
  }

  const ok = !reasons.some((r) => r.severity === 'drift');
  return { ok, reasons, details };
}

export function formatIntegrityMessage(result: IntegrityResult): string {
  const lines = [`dist integrity ${result.ok ? 'advisory' : 'drift'}`];
  for (const r of result.reasons) {
    lines.push(`- [${r.severity}] ${r.code}: ${r.message}`);
  }
  lines.push(`details: ${JSON.stringify(result.details)}`);
  return lines.join('\n');
}
