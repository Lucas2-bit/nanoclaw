// container/agent-runner/src/guardrail-hook.ts
// WP1 Step 3 — PreToolUse guardrail hook (DRY-RUN first, log-only).

import { createRequire } from 'node:module';
import type {
  HookCallback,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

const require = createRequire(import.meta.url);

type Mode = 'dryrun' | 'enforce';

interface Rule {
  id: string;
  patterns: string[];
  failClosed: boolean;
}

const STATIC_FAIL_CLOSED: Rule[] = [
  {
    id: 'sys_no_delete_files',
    patterns: ['file_delete*', 'rm', 'unlink', 'shred'],
    failClosed: true,
  },
  {
    id: 'sys_no_external_comms',
    // NOTE: intentionally excludes `send_message*` and `mcp__nanoclaw__send_message`.
    // Those match Ulterior's own outbound path to Lucas (WhatsApp/Telegram routing),
    // which is a legitimate internal reply, not an external communication.
    // This rule targets true-external channels (email, external Gmail sends).
    patterns: ['send_email*', 'mcp__gmail__send*'],
    failClosed: true,
  },
  {
    id: 'sys_no_financial',
    patterns: ['payment*', 'transfer*', 'purchase*', 'subscribe*'],
    failClosed: true,
  },
];

const DB_PATH = '/workspace/store/ulterior.db';
const CACHE_TTL_MS = 60_000;

let cache: { rules: Rule[]; at: number } | null = null;

function loadRules(log: (m: string) => void): Rule[] {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.rules;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    const rows = db
      .prepare(
        "SELECT id, tool_pattern, fail_closed FROM guardrails " +
          "WHERE active=1 AND enforcement='block' AND tool_pattern IS NOT NULL AND tool_pattern != ''",
      )
      .all() as { id: string; tool_pattern: string; fail_closed: number }[];
    db.close();
    const rules: Rule[] = rows.map((r) => ({
      id: r.id,
      patterns: r.tool_pattern
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean),
      failClosed: r.fail_closed === 1,
    }));
    cache = { rules, at: now };
    return rules;
  } catch (err) {
    log(
      `[guardrail] DB unreadable, using STATIC_FAIL_CLOSED: ${(err as Error).message}`,
    );
    return STATIC_FAIL_CLOSED;
  }
}

function nameMatch(pattern: string, value: string): boolean {
  const v = value.toLowerCase();
  const p = pattern.toLowerCase();
  return p.endsWith('*') ? v.includes(p.slice(0, -1)) : v === p || v.includes(p);
}

function bashCommandMatches(
  patterns: string[],
  command: string,
): string | null {
  // Match ONLY against the rule's own patterns — no hardcoded verb tables.
  // Hardcoded tables become a second source of truth that drifts from the DB
  // (root cause of the sys_no_delete_files/bash:curl false positive that
  // would have caused a self-outage on enforce flip — DEC-20260707-005).
  // A pattern qualifies as a bash-verb match only if it's a simple token
  // (no underscore, no wildcards other than trailing *). Tool-name patterns
  // like `send_email*` or `mcp__gmail__send*` intentionally fail this check
  // and never match bash commands — they only match via nameMatch.
  const c = command.toLowerCase();
  for (const p of patterns) {
    const bare = p.replace(/\*$/, '').toLowerCase();
    if (!bare || bare.includes('_')) continue;
    if (new RegExp(`(^|[;&|\\s])${bare}(\\s|$)`).test(c)) {
      return `bash:${bare}`;
    }
  }
  return null;
}

export function createGuardrailHook(
  log: (m: string) => void,
  mode: Mode = (process.env.GUARDRAIL_HOOK_MODE as Mode) || 'dryrun',
): HookCallback {
  return async (input, _toolUseId, _context) => {
    try {
      const pre = input as PreToolUseHookInput;
      const toolName = pre.tool_name ?? '';
      const rules = loadRules(log);

      let hit: { id: string; how: string } | null = null;
      if (toolName === 'Bash') {
        const command = String(
          (pre.tool_input as { command?: unknown })?.command ?? '',
        );
        for (const r of rules) {
          const how = bashCommandMatches(r.patterns, command);
          if (how) {
            hit = { id: r.id, how };
            break;
          }
        }
      } else {
        for (const r of rules) {
          if (r.patterns.some((p) => nameMatch(p, toolName))) {
            hit = { id: r.id, how: `name:${toolName}` };
            break;
          }
        }
      }

      if (!hit) {
        log(`[guardrail][audit] allow tool=${toolName} mode=${mode}`);
        return {};
      }
      if (mode === 'enforce') {
        log(
          `[guardrail][BLOCK] rule=${hit.id} match=${hit.how} tool=${toolName}`,
        );
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Blocked by guardrail ${hit.id} (${hit.how}).`,
          },
        };
      }
      log(
        `[guardrail][WOULD-BLOCK] rule=${hit.id} match=${hit.how} tool=${toolName} mode=dryrun`,
      );
      return {};
    } catch (err) {
      try {
        const pre = input as PreToolUseHookInput;
        const toolName = pre.tool_name ?? '';
        const command =
          toolName === 'Bash'
            ? String((pre.tool_input as { command?: unknown })?.command ?? '')
            : '';
        let hit: string | null = null;
        for (const r of STATIC_FAIL_CLOSED) {
          if (toolName === 'Bash') {
            const h = bashCommandMatches(r.patterns, command);
            if (h) {
              hit = r.id;
              break;
            }
          } else if (r.patterns.some((p) => nameMatch(p, toolName))) {
            hit = r.id;
            break;
          }
        }
        log(
          `[guardrail][ERROR] ${(err as Error).message} — fail-closed hit=${hit ?? 'none'} mode=${mode}`,
        );
        if (hit && mode === 'enforce') {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: `Blocked by fail-closed fallback (${hit}) after hook error.`,
            },
          };
        }
      } catch (err2) {
        log(`[guardrail][ERROR-FATAL] ${(err2 as Error).message}`);
      }
      return {};
    }
  };
}
