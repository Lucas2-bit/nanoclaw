# Spec: give the session hard ceiling teeth + remove dead escalation code

Status: DRAFT — awaiting adversarial review before implementation
Date: 2026-08-20

## Evidence base

All figures measured on this host, not assumed.

**The "hard ceiling" does not bound anything.**

```
HARD_CEILING_BYTES = 1 * 1024 * 1024        (session-monitor.ts:71)
CRITICAL_THRESHOLD_BYTES = 600 * 1024       (session-monitor.ts:14)

sizeKB observed in defer log lines, current nanoclaw process:
  whatsapp_main   268 defers   5 blocks   longest  90min   603..3770 KB
  telegram_main   407 defers   9 blocks   longest 146min   600..3168 KB

archived sessions: 1515 total | 658 over CRITICAL | 141 over HARD
largest ever archived: 17300 KB  (16.9x the "hard" ceiling)
```

**There is no leak, and no missing staleness hatch.** Both `state.active = false`
assignments sit in `finally` blocks (`group-queue.ts:762`, `:809`), so the flag
always clears. Defer blocks are bounded per run:

- whatsapp's 5 blocks cap at exactly 90 min = `QUEUE_HARD_TIMEOUT` (config.ts:59)
- telegram's 2 over-90 blocks are consistent with scheduled tasks, which get
  `TASK_HARD_TIMEOUT` = 3x = 270 min (config.ts:67)

So the defect is **not** that the reset is blocked forever. It is that the defer
response is *identical regardless of size*: a 3.7 MB session gets the same
`retry next tick` as a 610 KB one, and 90–270 minutes is long enough for a
session to grow several times past the ceiling that is supposed to stop it.

A multi-MB session is the direct cause of the degraded behaviour observed
(repetition, dropped context) — the agent is running at or past its usable
context window.

## Fix A — abort ceiling

### A1. New threshold (`session-monitor.ts`)

```ts
/**
 * Size at which we stop deferring and forcibly abort the in-flight run.
 * HARD_CEILING is only enforceable when no run is active; a run may hold the
 * folder for up to TASK_HARD_TIMEOUT (270 min), during which the session has
 * been measured growing to 3.7 MB. Past this point the agent's output is
 * already degraded, so preserving the in-flight reply is worth less than
 * reclaiming the context.
 */
const ABORT_CEILING_BYTES = parseInt(
  process.env.SESSION_ABORT_CEILING_BYTES || String(2 * 1024 * 1024), 10,
);
```

Default 2 MB = 2x HARD_CEILING. This is a judgement call, not a derived value —
stating the trade-off rather than asserting a number:

| choice | effect |
|---|---|
| abort at 1 MB (== HARD_CEILING) | consistent with the constant's name; but kills any in-flight run the moment it crosses the ceiling, including runs that would have finished seconds later |
| **abort at 2 MB (chosen)** | one doubling of headroom past the declared ceiling; catches the observed 3.1–3.7 MB cases; a run that crosses 1 MB and finishes normally is never disturbed |
| abort at 4 MB | too permissive — 3.7 MB was already producing degraded output |

Env-overridable, so this can be retuned from `ecosystem.config.cjs` without a
rebuild if the alert stream shows it firing too eagerly or too late.

### A2. New queue method (`group-queue.ts`)

```ts
abortActiveRun(groupJid: string, reason: string): boolean
```

**Corrected after review.** An external kill does NOT land on the timeout
branch. `stopContainer` runs `docker stop -t 1`, the container exits,
`container.on('close')` **resolves** the run promise (`container-runner.ts:608`),
so `withHardTimeout` returns `done` (or `error` if parsing throws). That means:

| path a kill produces | what it already does | line |
|---|---|---|
| `ok === false` | `scheduleRetry` only — **no requeue** | `:754` |
| `catch` | `scheduleRetry` only — **no requeue** | `:760` |

Consequences for this method:

- **It must NOT call `scheduleRetry`.** Both downstream paths already do; a
  third call would double-schedule. (My first draft had this wrong.)
- **It MUST call `requeueFn`.** Neither downstream path rolls the cursor back,
  so without an explicit requeue the in-flight user message is silently
  dropped and never answered. This is the opposite of the reason the first
  draft gave.

Final behaviour:

- **message** (`state.isTaskContainer === false`): capture
  `priorGeneration = state.generation`, `state.generation++`,
  `this.requeueFn?.(groupJid, priorGeneration)` — the same ordering as
  `:705-707`, so the RISK-013 chunk 5a `(jid, generation)` dedup slot still
  matches the dying invocation — **then** kill. No `scheduleRetry`.
- **task** (`isTaskContainer === true`): kill only, no requeue — matches the
  existing task timeout branch (`:800-801`).
- Returns `false` and does nothing when the group is not active.
- **Does not touch `state.active` / `activeCount` / folder lock.** The caller's
  `finally` remains the single cleanup site — the contract documented on
  `handleHangTimeout` (`:326-328`).

Kill uses the same best-effort ladder as `handleHangTimeout`:
`stopContainer(containerName)` then `process.kill('SIGKILL')` fallback.

### A3. Monitor branch (`session-monitor.ts`, before the HARD_CEILING branch)

```
if (sizeBytes >= ABORT_CEILING_BYTES && isFolderInFlight?.(folder)) {
    onAbortRun?.(folder, `session ${sizeKB}KB exceeded abort ceiling`);
    writeAlertFile(...);            // never silent
    continue;                        // archive happens next tick
}
```

**The archive deliberately does not happen in the same tick as the abort.** The
container may still be flushing to the `.jsonl`; renaming it mid-write risks a
truncated archive. After the kill, the caller's `finally` clears `active`, and
the next 60 s tick takes the existing HARD_CEILING path with no run in flight.
One tick of latency is a cheap price for not corrupting the archive.

### A4. Wiring (`index.ts`)

New optional `onAbortRun` param on `startSessionMonitor`, resolved
folder -> JIDs with the same loop shape as the existing in-flight predicate
(`:1850-1856`):

```ts
(groupFolder, reason) => {
  for (const [jid, g] of Object.entries(registeredGroups)) {
    if (g.folder !== groupFolder) continue;
    if (queue.abortActiveRun(resolvePrimaryJid(jid), reason)) break;
  }
}
```

Also route an ops alert via `routeOpsAlert` so an abort is always visible.

### A5. Abort cooldown and cap (added after review)

`docker stop -t 1` plus container teardown is not instantaneous, and the
monitor ticks every 60 s. Without throttling, a tick can observe
`oversized && still in-flight` and abort again, spamming alerts. Worse, if a
single run inherently produces >2 MB of tool output — telegram was measured
growing 744 KB in 35 minutes, so a 2 MB single run is plausible — abort ->
fresh session -> regrow -> abort becomes a thrash loop.

Reuse the cooldown pattern already in this file (`lastCompactAt`, `:34`):

```ts
const ABORT_COOLDOWN_MS = 5 * 60 * 1000;   // don't re-abort a folder inside 5 min
const ABORT_MAX_PER_HOUR = 3;              // then stop aborting, alert only
const lastAbortAt = new Map<string, number>();
const abortsThisHour = new Map<string, number[]>();  // timestamps, pruned
```

Once a folder exceeds `ABORT_MAX_PER_HOUR`, stop aborting and emit a single
distinct alert ("abort cap reached — session oversized and not self-clearing").
Escalating to a human beats an invisible kill loop.

### Why size-based, not defer-count-based

A 700 KB session deferred for 90 minutes is fine and self-resolves — a
defer-count trigger would fire on healthy behaviour. The harm is growth past a
usable context size, so size is the correct trigger.

## Fix B — delete dead escalation code (OPTIONAL, separate commit)

**Review note: this is cosmetic and should not be bundled with Fix A.** It has
zero functional benefit, and it touches `model-selector.ts` — the file changed
hours ago for the routing work, which is the highest-traffic path in the system.
Bundling a no-benefit edit into a behavioural fix widens the blast radius of a
rollback for no reason. Do it as its own commit, or skip it.

`escalateModel` (`model-selector.ts:454`) and `shouldEscalate` (`:470`) are
never called from anywhere: `src/`, `dist/`, `container/`, `scripts/`, tests.
No alternative implementation exists under another name. `RoutingLog.escalated`
is hardcoded `false` at its only construction site (`buildRoutingLog`).

Two options considered:

1. **Wire up** — adds a retry-on-weak-response path that re-runs work on a
   larger model. That is a live behaviour and cost change (Opus is 2.5x on
   output) that nobody has asked for and no evidence supports. Rejected.
2. **Delete** — removes ~35 lines of misleading surface. Chosen.

Delete both functions and `ESCALATION_MAP`. **Keep** the `RoutingLog.escalated`
field: it is part of the on-disk `routing-decisions.jsonl` schema and historic
entries carry it. Document it as reserved/always-false rather than breaking
readers.

This whole incident began with code and comments disagreeing (`config.py`
documenting `system/com.mcp-bridge` while the code used `gui/<uid>`). Dead
functions that look like a working feature are the same failure mode.

## Tests

**Revised after review — the original plan was not implementable.**
`checkSessionFileSizes` is not unit-testable as written: `sessionDir()`
hardcodes `os.homedir()/nanoclaw/data/sessions/...` (`:41-51`), and the
function also depends on module-level `DATA_DIR` (config.js) and
`getAllSessions`/`setSession` (db.js, real SQLite). Existing tests in this repo
use real temp dirs via `mkdtempSync` (e.g. `integrity.test.ts:25`) rather than
fs mocks, so there is no established mocking harness to lean on.

Rather than bolt heavy mocks onto untestable code, **extract the decision as a
pure function** and test that:

```ts
export type SessionAction =
  | { kind: 'none' }
  | { kind: 'warn' }
  | { kind: 'archive'; reason: 'stale' | 'critical' | 'hard' }
  | { kind: 'defer'; reason: 'critical' | 'hard' }
  | { kind: 'abort' };

export function decideSessionAction(args: {
  sizeBytes: number;
  mtimeMs: number;
  now: number;
  inFlight: boolean;
  abortAllowed: boolean;   // cooldown + cap already applied by caller
}): SessionAction
```

`checkSessionFileSizes` becomes a thin IO shell that calls this and executes the
returned action. The pure function gets full table-driven coverage with no fs,
no db, no clock:

- below WARN -> `none`
- WARN zone, fresh -> `warn`; WARN zone + age > 24 h -> `archive/stale`
- CRITICAL, idle -> `archive/critical`; CRITICAL, in flight -> `defer/critical`
- HARD, idle -> `archive/hard`; HARD, in flight -> `defer/hard`
- **>= ABORT, in flight, abortAllowed -> `abort`**
- **>= ABORT, in flight, cooldown/cap exhausted -> `defer/hard`** (not abort)
- **>= ABORT, idle -> `archive/hard`** (abort is only for the in-flight case)
- exact boundary values for all four thresholds (off-by-one guard)

`src/group-queue.test.ts` (14 existing cases must stay green) additions:

- `abortActiveRun` on an idle group returns false, no side effects
- message run: `requeueFn` receives the **pre-increment** generation, and
  generation increments by exactly 1
- message run: `scheduleRetry` is **not** called by this method
- task run: `requeueFn` not called
- `state.active` untouched by the method itself

`src/group-queue.test.ts` (14 existing cases must stay green) additions:

- `abortActiveRun` on an idle group returns false, no side effects
- message run: requeueFn receives the pre-increment generation, generation
  increments by exactly 1
- task run: requeueFn NOT called
- `state.active` untouched by the method itself

## Assumptions validated during review

These were load-bearing and unverified in the first draft. Both now checked
against source:

1. **A killed container settles the run promise.** Yes —
   `container.on('close', ...)` resolves (`container-runner.ts:608`), and
   `stopContainer` is `docker stop -t 1` (`container-runtime.ts:57`). Had this
   been false, the abort would have killed the container while leaving
   `state.active` true forever, and Fix A would have achieved nothing. This was
   the single biggest risk to the whole design.
2. **`isTaskContainer` is a valid message/task discriminator at abort time.**
   Set at `:781`, cleared at `:810`, both inside the task path.

## Risks

1. **Aborting destroys real in-flight work.** Mitigated: only at >= 2 MB, where
   output is already degraded, and messages are requeued so the reply is
   regenerated. Tasks are not requeued — same as today's task timeout, but now
   reachable by size. Accepted, and alerted so it is never silent.
2. **The requeue/generation sequence is RISK-013-critical.** Getting the
   ordering wrong could resurrect the duplicate-reply bug. Mitigated by reusing
   the exact sequence and asserting the pre-increment value in tests.
3. **Abort-then-archive spans two ticks.** If the process dies between them the
   session stays oversized until the next boot's monitor tick. Acceptable: same
   exposure as today.
4. **A pathological group could abort repeatedly.** If the fresh session also
   crosses 2 MB inside one run, it aborts again. Bounded by the fact that a
   fresh session starts near zero; worth watching in the alert stream.

## Out of scope

- Ulterior's delegation behaviour. My earlier claim that it "stopped
  delegating" did not survive review: delegation has been 0–9% across all
  sampled sessions (not a regression), `delegation-log.jsonl` is an unreliable
  record (13 lifetime entries vs 12 Agent calls in five sessions alone), and
  sessions *with* delegation are **larger**, not smaller — so delegation is not
  the lever on context size.
- Lowering `TASK_HARD_TIMEOUT`. Separate decision with its own trade-offs.
