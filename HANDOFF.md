# NanoClaw / Ulterior — Claude Desktop Handoff Pack

Written 2026-07-08 after the WP1 Step 3 rollback. Attach this file to a fresh Claude Desktop chat along with the four source files listed in section 5.

---

## 1) Situation primer (paste this at the top of any Claude Desktop chat)

**Who Lucas is:** CRO at Stanley Robotics. Wife Angela, sons Alexander and Oliver — both non-verbal, both with SAFETY-CRITICAL allergies (Oliver: eggs, tree nuts, peanuts, erythromycin, amoxicillin, coconut; Alexander: sesame, celery, G6PD deficiency). Family safety = first filter on every decision.

**What Ulterior is:** Lucas's COO/Chief of Staff agent, always-on, `is_main=true`. Single point of contact between Lucas and a network of specialist agents. Runs on **NanoClaw** — a Node.js orchestrator on Lucas's Mac that spawns per-message Docker containers, each running Claude Agent SDK. Channels: WhatsApp (primary), Telegram (fallback), Gmail. Ulterior's CLAUDE.md is immutable infrastructure.

**Architecture — host side:**
- `~/nanoclaw/src/index.ts` — orchestrator, message loop
- `~/nanoclaw/src/container-runner.ts` — builds docker-run args, mount list, env pass-through
- `~/nanoclaw/src/router.ts` — outbound routing (`routeOutbound` is the choke point)
- `~/nanoclaw/src/task-scheduler.ts` — cron / once / interval scheduled tasks
- `~/nanoclaw/ecosystem.config.cjs` — pm2 config (nanoclaw + watchdog processes)
- `~/nanoclaw/store/ulterior.db` — operational DB (guardrails, task_queue, memory, etc)
- `~/nanoclaw/store/messages.db` — nanoclaw DB (registered_groups, messages, scheduled_tasks)

**Architecture — container side (copied to `~/nanoclaw/data/sessions/<group>/agent-runner-src/` on spawn):**
- `container/agent-runner/src/index.ts` — SDK query() setup; PreCompact + PreToolUse hooks wired here (lines ~514 and ~688)
- `container/agent-runner/src/guardrail-hook.ts` — the enforce/dryrun guardrail hook
- `container/Dockerfile` — image build, node:22-slim + chromium + node deps

**pm2 layout:** three apps — `dashboard`, `nanoclaw`, `watchdog`. `nanoclaw` is the orchestrator. Containers spawn from `nanoclaw-agent:latest` image.

---

## 2) What was shipped in WP1 Step 3 (three commits on `main`)

- `b4fc7be` — PreToolUse guardrail hook + Option A pattern narrowing (send_message allowed via internal path, external channels still gated)
- `5784a88` — drop hardcoded del/net verb tables in `bashCommandMatches` (was causing curl to be falsely blocked as `sys_no_delete_files`)
- `73ffacd` — enforce flip: `container-runner.ts` env pass-through + `ecosystem.config.cjs` sets `GUARDRAIL_HOOK_MODE=enforce`

Deterministic 5-case tests on the built image passed under both dryrun and enforce.

**BUT — the fixes never actually reached running containers.** See section 4 for root cause.

---

## 3) Current live state as of 2026-07-08 07:30 CDT (post-rollback)

- **enforce mode ROLLED BACK to dryrun** — `ecosystem.config.cjs` has `GUARDRAIL_HOOK_MODE: "dryrun"` (uncommitted; `.bak-preroll` preserved next to it)
- HEAD: `73ffacd` (unchanged)
- nanoclaw live node PID at rollback: 37091
- Confirmed live env from process itself: `GUARDRAIL_HOOK_MODE=dryrun` (verified via `ps -E`, not the config file)
- Per-group agent-runner-src caches at `~/nanoclaw/data/sessions/{whatsapp_main,telegram_main}/agent-runner-src/` **still contain the pre-Option-A buggy hook** — this is why enforce was catching legitimate sends
- No live nanoclaw containers currently with `enforce` env

Ulterior's WhatsApp/Telegram sends work again (dryrun logs `[WOULD-BLOCK]` but doesn't deny).

---

## 4) THE CRITICAL GOTCHA (load-bearing — read before touching anything)

**Container-side source is mounted from a per-group CACHE dir, not from the image.** The image's `/app/src` is overridden by a bind mount from `~/nanoclaw/data/sessions/<group>/agent-runner-src/`. The container's `entrypoint.sh` recompiles that MOUNTED source, not the image-baked source. So:

- Rebuilding the container image (`./container/build.sh`) alone does NOT update what containers actually execute.
- The image contains the current source, but that source only reaches a container if the per-group cache is stale.

**The cache-invalidation logic is BROKEN.** In `~/nanoclaw/src/container-runner.ts` lines ~278–289:

```ts
const srcIndex = path.join(agentRunnerSrc, 'index.ts');
const cachedIndex = path.join(groupAgentRunnerDir, 'index.ts');
const needsCopy =
  !fs.existsSync(groupAgentRunnerDir) ||
  !fs.existsSync(cachedIndex) ||
  (fs.existsSync(srcIndex) &&
    fs.statSync(srcIndex).mtimeMs > fs.statSync(cachedIndex).mtimeMs);
if (needsCopy) {
  fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
}
```

Two stacked bugs:

1. **`fs.cpSync` does NOT preserve source mtimes** — destination gets "now". After the first copy, cache is FOREVER newer than source. `needsCopy` becomes permanently `false`.
2. **Only `index.ts` is checked** — even if cpSync preserved mtimes, editing `guardrail-hook.ts` alone (leaving `index.ts` untouched) would never trigger re-copy.

**Evidence from 2026-07-08 07:30 CDT:**
```
container/agent-runner/src/index.ts                              mtime Jul 7 12:17
data/sessions/whatsapp_main/agent-runner-src/index.ts            mtime Jul 7 12:35
data/sessions/telegram_main/agent-runner-src/index.ts            mtime Jul 7 13:35
```

Cache mtimes are permanently ahead of source. Every subsequent spawn skipped the re-copy. Every hook fix I committed (Option A narrowing in b4fc7be, drop del/net in 5784a88) landed on disk and in the image, but production containers kept running the original first-copy version.

---

## 5) Files to attach to Claude Desktop

Attach these four (paperclip is cheaper on tokens than pasting):

- `~/nanoclaw/container/agent-runner/src/guardrail-hook.ts` — the hook itself
- `~/nanoclaw/container/agent-runner/src/index.ts` — hook wire-in at ~L514 and ~L688
- `~/nanoclaw/src/container-runner.ts` — has the broken needsCopy logic + env pass-through
- `~/nanoclaw/ecosystem.config.cjs` — where GUARDRAIL_HOOK_MODE is set

Plus this HANDOFF.md.

---

## 6) Diagnostic commands (copy-paste ready)

Run these on request; paste output back to Claude Desktop verbatim.

### State snapshot
```bash
cd ~/nanoclaw
git status --short && echo "HEAD: $(git rev-parse HEAD)"
cat dist/build-info.json
pm2 list | grep -E "nanoclaw|watchdog"
docker ps --format 'table {{.Names}}\t{{.Status}}'
```

### Live env verification (NOT the config file — the actual running process)
```bash
NP=$(pgrep -f "node.*dist/index.js" | head -1)
echo "node pid: $NP"
ps -E -p $NP 2>&1 | tr ' ' '\n' | grep "^GUARDRAIL_HOOK_MODE="
```

### Live container env
```bash
for c in $(docker ps -q --filter "name=nanoclaw-"); do
  echo "--- $(docker inspect -f '{{.Name}}' $c) ---"
  docker inspect $c --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -iE "GUARDRAIL"
done
```

### What is ACTUALLY running in production (not the image — the mounted cache)
```bash
# The four signature checks that catch stale-cache production drift:
grep -c "send_message\*"      ~/nanoclaw/data/sessions/whatsapp_main/agent-runner-src/guardrail-hook.ts
grep -c "const del ="          ~/nanoclaw/data/sessions/whatsapp_main/agent-runner-src/guardrail-hook.ts
grep -c "const net ="          ~/nanoclaw/data/sessions/whatsapp_main/agent-runner-src/guardrail-hook.ts
grep "patterns:"               ~/nanoclaw/data/sessions/whatsapp_main/agent-runner-src/guardrail-hook.ts
# All three counts should be 0. patterns: line should show narrow ['send_email*', 'mcp__gmail__send*'].
```

### Current guardrails table
```bash
sqlite3 -readonly ~/nanoclaw/store/ulterior.db \
  "SELECT id, tool_pattern, fail_closed, updated_at FROM guardrails
     WHERE tool_pattern IS NOT NULL AND tool_pattern != '' ORDER BY id;"
```

### Recent hook activity from pm2 log
```bash
tail -c 100000 ~/.pm2/logs/nanoclaw-out.log \
  | grep -aoE "\[guardrail\]\[(BLOCK|WOULD-BLOCK|audit|ERROR)\][^\\]{0,180}" \
  | tail -30
```

### Count mode= usage across the whole log
```bash
grep -aoE "mode=(\w+)" ~/.pm2/logs/nanoclaw-out.log | sort | uniq -c
# Any mode=enforce lines = enforce actually fired in a real container.
# All mode=dryrun = enforce never took effect (or currently on dryrun).
```

---

## 7) Force a real re-deploy (the correct sequence given the cache bug)

Until `container-runner.ts` is fixed, ANY edit to `container/agent-runner/src/*` must be followed by cache invalidation. Otherwise your changes never reach production.

```bash
cd ~/nanoclaw

# 1. Wipe per-group caches (safest — hits the !exists branch of needsCopy)
rm -rf ~/nanoclaw/data/sessions/*/agent-runner-src

# 2. Rebuild image (still needed — baked source is the copy target)
./container/build.sh

# 3. Rebuild host dist if src/ changed too
npm run build

# 4. Delete + start (guarantees fresh env, no pm2 cache carry-over)
pm2 delete nanoclaw
pm2 start ecosystem.config.cjs --only nanoclaw

# 5. Kill any live containers so they respawn with the fresh cache
for c in $(docker ps -q --filter "name=nanoclaw-"); do docker kill $c; done

# 6. Verify runtime signature (NOT the image)
grep "patterns:" ~/nanoclaw/data/sessions/whatsapp_main/agent-runner-src/guardrail-hook.ts

# 7. Verify live env
NP=$(pgrep -f "node.*dist/index.js" | head -1)
ps -E -p $NP | tr ' ' '\n' | grep "^GUARDRAIL_HOOK_MODE="
```

---

## 8) The bug fix that closes this loop for good (deferred; ~1 line)

Change `container-runner.ts` line 287 from:
```ts
fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
```
to:
```ts
fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true, preserveTimestamps: true });
```

Optional harder version — walk all source files, compare newest source mtime to newest cache mtime:
```ts
function newestMtime(dir: string): number {
  let latest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isFile()) latest = Math.max(latest, fs.statSync(p).mtimeMs);
    else if (entry.isDirectory()) latest = Math.max(latest, newestMtime(p));
  }
  return latest;
}
const needsCopy =
  !fs.existsSync(groupAgentRunnerDir) ||
  !fs.existsSync(cachedIndex) ||
  newestMtime(agentRunnerSrc) > newestMtime(groupAgentRunnerDir);
```

Preferred: `preserveTimestamps: true`. Minimal diff, no new walker.

After fixing: wipe caches once, rebuild, restart, verify — future edits will re-invalidate correctly.

---

## 9) Rollback rope (already used once — 2026-07-08 07:22 CDT)

To roll enforce off without touching code:
```bash
sed -i '' 's/GUARDRAIL_HOOK_MODE: "enforce"/GUARDRAIL_HOOK_MODE: "dryrun"/' ~/nanoclaw/ecosystem.config.cjs
pm2 delete nanoclaw
pm2 start ~/nanoclaw/ecosystem.config.cjs --only nanoclaw
NP=$(pgrep -f "node.*dist/index.js" | head -1)
ps -E -p $NP | tr ' ' '\n' | grep "^GUARDRAIL_HOOK_MODE="   # confirm dryrun
```

**Do NOT trust `pm2 restart nanoclaw --update-env`** for this — it can retain cached env. Use `pm2 delete + start` from the ecosystem path to guarantee a fresh env dictionary.

Full-code rollback:
```bash
cd ~/nanoclaw
git revert 73ffacd 5784a88 b4fc7be    # or checkout the pre-WP1 commit
npm run build && ./container/build.sh
rm -rf ~/nanoclaw/data/sessions/*/agent-runner-src   # DO NOT SKIP — cache would win
pm2 delete nanoclaw && pm2 start ecosystem.config.cjs --only nanoclaw
```

---

## 10) RISK-013 primer (next major work, gated on enforce being genuinely fixed)

The hang/retry cost bleed. Ulterior scoped this earlier with a 2-reviewer panel. Three chunks in priority order:

1. **Outbound content-hash dedup in `router.ts:routeOutbound`** — kills user-visible duplicate spam. Small change: LRU cache of `(jid, hash) -> ts`, drop repeats within ~30s TTL. Choke point is `channel.sendMessage(jid, text)` at `router.ts` line 44.
2. **Cap retries + alert instead of silent re-runs** — stops the cost-multiplier loop. Nanoclaw currently retries with backoff indefinitely until circuit-breaker opens.
3. **Shorter hang timeout (5–10 min from 90 min) + compact-or-fresh-session on retry** — root cause. Retrying with the same bloated session just re-hangs.

**Do NOT go with a "skip retry if already sent" flag** — Ulterior's panel converged that flag-timing races make it unsafe (either still-duplicating or silent-drop).

---

## 11) Suggested first prompt for Claude Desktop

> I'm handing off from Claude Code after a WP1 Step 3 rollback. The critical fact:
> multiple hook fixes appeared to land in production but never actually reached
> running containers. Root cause: NanoClaw's per-group source cache at
> `~/nanoclaw/data/sessions/*/agent-runner-src/` is invalidated based on
> `index.ts` mtime, and `fs.cpSync` doesn't preserve source mtimes — so after the
> first copy, the cache is permanently newer than source and needsCopy is always
> false. Rebuilding the image doesn't help because the image is overridden by a
> mounted bind of that stale cache.
>
> Current live state: rolled back to dryrun. Per-group caches still contain the
> pre-fix buggy hook. `ecosystem.config.cjs` change uncommitted. No live enforce
> containers. Full context in the attached HANDOFF.md and source files.
>
> Task order:
> 1. Design the minimal `container-runner.ts` fix (I recommend
>    `preserveTimestamps: true` on the cpSync call — it's one arg).
> 2. Give me the exact sequence: cache wipe, image rebuild, host build, pm2
>    delete+start, container kill, runtime signature verify.
> 3. Give me a runtime signature check I can grep on the actual mounted source
>    (NOT the image) to prove the fix reached production.
> 4. Only after those are green: guide me through re-flipping enforce, with the
>    same runtime-signature verify method.
> 5. Then RISK-013 chunks 1 → 2 → 3.

---

## 12) Workflow tips for Claude Desktop

- Claude Desktop can't run commands or read files directly. You are the executor. Run the diagnostic bash blocks (section 6), paste output back verbatim.
- Attach source files via the paperclip icon rather than pasting long code — saves tokens.
- Use **Projects** in Claude Desktop for continuity — attach this HANDOFF.md and the four source files ONCE, reference across many chats.
- When Claude Desktop proposes a diff, ask it for the exact `Edit`, `sed`, or `awk` command you can run in Terminal, not just the diff text.
- For destructive ops (kill container, restart nanoclaw, rebuild), always ask for the atomic-deploy sequence AND confirm before running. Pattern learned from May-31 SEV-1.
- If Claude Desktop lacks context, paste from `~/nanoclaw/CLAUDE.md`, `~/nanoclaw/groups/telegram_main/CLAUDE.md`, or the relevant DEC-log entries.
- Verify EVERY claimed fix by grepping the mounted per-group cache, NOT the image. This is the lesson from yesterday's noise.

---

## 13) Related memory (my Claude Code auto-memory, not carried into Desktop)

Three files at `~/.claude/projects/-Users-lucascarroll/memory/`:
- `ulterior_system.md` — architecture
- `ulterior_known_issues.md` — recurring failure modes (long-task queue block, session-monitor defer loop, nanoclaw restart climb, dist drift)
- `ulterior_stuck_task_recovery.md` — how to unjam a container stuck resuming a long session

Worth re-reading if Ulterior stops responding or a container hangs.
