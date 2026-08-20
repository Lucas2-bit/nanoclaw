# Spec: restore auto-compact so bloating sessions shrink instead of being destroyed

Status: DRAFT — awaiting adversarial review before implementation
Date: 2026-08-20

## The gap

The current size ladder has no gentle step. Every response to a bloating session
is destructive:

```
300 KB  WARN      -> log a warning (nothing else)
600 KB  CRITICAL  -> archive + reset      (all context destroyed)
1024 KB HARD      -> archive + reset      (all context destroyed)
2048 KB ABORT     -> kill run, then archive
```

So Ulterior either carries a bloated session or loses its entire working
context. There is no path that reduces size while preserving continuity.

## Why it is missing (git archaeology, not assumption)

Auto-compact **was** implemented and working. In `90c21f3` the CRITICAL branch
read:

```ts
} else if (sizeBytes >= CRITICAL_THRESHOLD_BYTES) {
  // Soft threshold: try to compact (may fail if session is already heavy)
  logger.warn(..., 'session-monitor: session approaching hard ceiling — triggering auto-compact');
  if (onCompact) {
    const lastTriggered = lastCompactAt.get(group.folder) ?? 0;
    if (Date.now() - lastTriggered >= COMPACT_COOLDOWN_MS) { ... onCompact(group.folder); }
  }
}
```

On 2026-04-29/30 (`3ea3f56`, `1faffe7`) that was replaced with archive, and the
comment that survives today explains why:

> `// Archive immediately — compaction at this size causes API timeouts.`

That was a correct fix for a real problem: compacting a 600 KB session timed
out. But it removed the **only** compaction step, leaving the destructive-only
ladder above. `onCompact`, `lastCompactAt` and `COMPACT_COOLDOWN_MS` have been
dead ever since — which is why "auto-compact never fired".

**The fix is therefore not to restore compaction where it was, but to move it
earlier, where it is still cheap enough to succeed.**

## Everything needed already exists and is verified

Traced end-to-end in the current tree — no new plumbing required:

| piece | where | state |
|---|---|---|
| `/compact` recognised as a session command | `session-commands.ts:14` | works |
| silent auto-compact mode (no user-facing output) | `session-commands.ts:105,166` | works — keyed on `sender_name === 'system'` |
| pre-compact messages processed first, so user messages are not starved | `session-commands.ts:118` | works |
| injection of a synthetic `/compact` as `is_from_me` | `index.ts:1799-1838` | wired, never called |
| duplicate-injection guard | `hasPendingCompact` (`db.ts:451`, used `index.ts:1813`) | works |
| cooldown constant | `COMPACT_COOLDOWN_MS` 60 min | defined, unused |
| SDK emits a NEW session id on compact | `agent-runner:706` `slashSessionId` | works |
| container returns it | `agent-runner:732` `newSessionId` | works |
| host persists it | `index.ts:1105,1146` `setSession(...)`, guarded `status !== 'error'` | works |

That last chain is the load-bearing one: **compaction produces a new session
file, so file size genuinely resets.** A failed compact is not persisted, so it
cannot leave the group pointing at a broken session.

## Adversarial review finding: raw file size is the wrong metric

The `.jsonl` is an append-only transcript. When a compaction happens, a
`compact_boundary` record is written and everything after it is the effective
conversation — the prior history is summarised, not replayed. So file size
overstates context whenever a boundary exists.

Measured on archived sessions (total vs bytes after the last boundary):

```
 675 KB ->  104 KB   (85% reduction)
 923 KB ->  390 KB   (58%)
 813 KB ->  243 KB   (70%)
2075 KB ->   60 KB   (97%)
5440 KB ->   14 KB   (99.7%)
7200 KB ->   21 KB   (99.7%)
```

Two conclusions:

1. **Compaction works, and works well** — 58–99.7% reduction. This validates
   the whole approach.
2. **Raw size is a poor proxy for context once a boundary exists.** A 7200 KB
   file with 21 KB after its boundary is a *healthy* session. Under the current
   (and today's newly shipped) logic it would be archived at CRITICAL/HARD, and
   its run killed at ABORT — destroying good work for no reason. Of the 8
   largest archived sessions, 5 have no boundary (size ≈ context, genuinely
   bloated) but 3 do, so this is not an edge case.

**Therefore all size thresholds should measure `effectiveBytes` = bytes after
the last `compact_boundary`** (falling back to total size when no boundary
exists). This both makes the compact trigger correct and removes a
false-positive class from the abort ceiling shipped earlier today.

Caveat, stated as inference not proof: I cannot inspect SDK internals to prove
`--resume` starts from the boundary rather than replaying the whole file. The
evidence is strong though — sessions continued running and growing *after* a
boundary at 7176 KB, which would be impossible if 7 MB were being replayed into
context.

### F0. Effective-size helper

```ts
/**
 * Bytes after the last compact_boundary — the session's effective context.
 * Falls back to total size when the session has never been compacted.
 * Result cached by (path, size, mtimeMs) so an unchanged file is scanned once.
 */
function effectiveSessionBytes(filePath: string, stat: fs.Stats): number
```

Only computed for files already past `WARN_THRESHOLD_BYTES`, so small sessions
cost nothing but a `statSync`. A cache miss costs one sequential read; at 60 s
ticks over two groups this is negligible on local disk.

## Fix

### F1. New threshold

```ts
/**
 * Size at which we inject a silent /compact. Deliberately well below
 * CRITICAL: compaction at 600 KB was found to time out (see the 2026-04-29
 * change that replaced compact-at-CRITICAL with archive), so the only way to
 * get a working compaction step back is to run it while the session is still
 * small enough to summarise.
 */
const COMPACT_THRESHOLD_BYTES = parseInt(
  process.env.SESSION_COMPACT_THRESHOLD_BYTES || String(WARN_THRESHOLD_BYTES),
  10,
);
```

Defaults to `WARN_THRESHOLD_BYTES` (300 KB) — i.e. "compact at the point where
we currently only log a warning". Separate env knob so it can be tuned without
touching the warn log level.

**Empirical support for 300 KB.** The measured boundaries above show compaction
actually *succeeding* with 531 KB and 570 KB of pre-boundary content (the
923 KB and 675 KB sessions). So compaction is not simply broken above some
small size, and 300 KB sits comfortably below anything observed failing.

This also qualifies the 2026-04-29 "compaction at this size causes API
timeouts" note: those successful compactions were SDK-internal (context already
in memory), whereas an injected `/compact` must first resume and load the
session file. The two are not equivalent, so the original finding is not
contradicted — but it does mean 300 KB has real margin rather than being a
guess.

### F2. New action in the pure decision function

Add `{ kind: 'compact' }` to `SessionAction`. Revised ladder inside
`decideSessionAction`, with the existing stale-archive behaviour preserved:

```
size >= ABORT   && inFlight        -> abort (or defer if throttled)
size >= HARD                       -> inFlight ? defer : archive/hard
size >= CRITICAL                   -> inFlight ? defer : archive/critical
size >= WARN:
    stale (> 24 h)                 -> archive/stale        [unchanged]
    else compactAllowed            -> compact              [NEW]
    else                           -> warn                 [unchanged]
size <  WARN                       -> none
```

`compactAllowed` is computed by the caller (cooldown), keeping the decision
pure — same pattern as `abortAllowed`.

**No in-flight check for compact.** Unlike archive, compaction is not
destructive and does not touch the file directly: it enqueues a message. The
queue serialises it against the running container naturally, and
`session-commands.ts:118` processes any pending user messages before the
command so nothing is starved.

### F3. Cooldown

Reuse the existing `COMPACT_COOLDOWN_MS` (60 min) and `lastCompactAt` map,
which are already declared for exactly this purpose. At 300 KB with a 60-min
cooldown the worst case is one extra container run per hour per group.

### F4. Wire the call site

`checkSessionFileSizes` gains a `case 'compact'` that invokes the existing
`onCompact` callback (already threaded from `index.ts`) and records the
cooldown. The `void onCompact` no-op line added earlier today is removed, and
the "vestigial" note in the docstring is corrected.

## Tests

Extends `src/session-monitor.test.ts` (22 cases today), all against the pure
function — no fs, no db, no clock:

- at WARN, fresh, compact allowed -> `compact`
- at WARN, fresh, cooldown active -> `warn` (never a silent no-op)
- at WARN, stale -> `archive/stale` (stale still wins over compact)
- one byte below WARN -> `none`
- at CRITICAL -> still archive/defer, never compact (guards the 2026-04-29 fix)
- at HARD and ABORT -> unchanged
- monotonicity property extended to include `compact` between `warn` and
  `defer` in severity

Plus cooldown unit tests mirroring the abort throttle tests
(`isCompactAllowed` / `recordCompact`).

### F5. Retarget existing thresholds onto effectiveBytes

`decideSessionAction` takes `effectiveBytes` in place of `sizeBytes`. All four
existing thresholds then measure effective context rather than transcript
length. Consequences to be explicit about:

- A large-but-compacted session stops being archived or aborted. That is the
  point, and it is a **behaviour change to code shipped hours ago** — the abort
  ceiling becomes considerably harder to reach, because 2 MB of *post-boundary*
  content is a genuinely enormous live context.
- A never-compacted session behaves exactly as today (no boundary -> effective
  == total), so the 5-of-8 genuinely bloated cases are unaffected.
- The abort ceiling therefore changes from "fires on any 2 MB file" to "fires
  only when 2 MB of live context has accumulated since the last compaction".
  Given F1 now compacts at 300 KB, reaching 2 MB effective should become rare —
  which is the desired outcome, not a regression. If it never fires again, the
  compact step is doing its job.

Raw total size is still logged alongside effective size so the distinction is
visible in the alert stream rather than hidden.

## Risks

1. **Compaction still fails or times out at 300 KB.** Then the session keeps
   growing and CRITICAL archives it — exactly today's behaviour, so this is a
   strict improvement with an unchanged backstop. Worth logging distinctly so
   repeated failures are visible rather than silent.
2. **Extra container runs cost tokens.** Bounded at 1/hour/group by the
   cooldown. A compact run is short (summarise + exit).
3. **Compaction loses detail Ulterior needed.** That is inherent to
   compaction, but strictly better than the current alternative at 600 KB,
   which discards the session outright.
4. **Injected `/compact` sits behind a long run.** It waits in the queue; if the
   session crosses CRITICAL first, archive wins and the queued compact becomes a
   no-op on a fresh session. Acceptable — `hasPendingCompact` prevents pile-up.
5. **Interaction with the abort ceiling shipped today.** Independent: compact
   fires at 300 KB with no in-flight condition, abort at 2 MB only when
   in-flight. They cannot both apply to the same tick.

## Out of scope

- Changing CRITICAL back to compact. The 2026-04-29 timeout finding stands.
- Tuning `WARN_THRESHOLD_BYTES` itself.
- `escalateModel`/`shouldEscalate` dead code (declined separately).
