#!/bin/bash
# NanoClaw Stability Fixes - May 2, 2026
# Fix 1: Stale session ID pruning on startup
# Fix 2: Cursor advance only after confirmed response
# Fix 3: Cron watchdog dedup (run cleanup-cron.sh separately)
set -e

SRC="/Users/lucascarroll/nanoclaw/src"

echo "=== Applying NanoClaw Stability Fixes ==="

# --- Fix 1a: Add deleteSession to db.ts ---
echo "1a. Adding deleteSession() to db.ts..."
if ! grep -q "export function deleteSession" "$SRC/db.ts"; then
  node -e "
const fs = require('fs');
let f = fs.readFileSync('$SRC/db.ts', 'utf8');
const marker = 'export function getAllSessions(): Record<string, string> {';
const idx = f.indexOf(marker);
if (idx === -1) { console.error('Could not find getAllSessions'); process.exit(1); }
// Find the closing brace of getAllSessions
let braceCount = 0;
let i = f.indexOf('{', idx);
for (; i < f.length; i++) {
  if (f[i] === '{') braceCount++;
  if (f[i] === '}') braceCount--;
  if (braceCount === 0) break;
}
const insertPoint = i + 1;
const newFn = \"\n\nexport function deleteSession(groupFolder: string): void {\n  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);\n}\";
f = f.slice(0, insertPoint) + newFn + f.slice(insertPoint);
fs.writeFileSync('$SRC/db.ts', f);
console.log('   Added deleteSession()');
"
else
  echo "   deleteSession() already exists, skipping"
fi

# --- Fix 1b: Add imports and pruneStaleSessionIds to index.ts ---
echo "1b. Adding stale session pruning to index.ts..."

node -e "
const fs = require('fs');
let f = fs.readFileSync('$SRC/index.ts', 'utf8');
let changed = false;

// Add deleteSession to imports
if (!f.includes('deleteSession')) {
  f = f.replace('getAllSessions,', 'getAllSessions,\n  deleteSession,');
  console.log('   Added deleteSession import');
  changed = true;
}

// Add DATA_DIR to config imports
if (!f.includes(\"import {\\n  ASSISTANT_NAME,\\n  DATA_DIR,\") && !f.match(/ASSISTANT_NAME,\n\s+DATA_DIR,/)) {
  f = f.replace('ASSISTANT_NAME,\n', 'ASSISTANT_NAME,\n  DATA_DIR,\n');
  console.log('   Added DATA_DIR import');
  changed = true;
}

// Add pruneStaleSessionIds function after saveState
if (!f.includes('pruneStaleSessionIds')) {
  const saveStateEnd = 'setRouterState(\\'last_agent_timestamp\\', JSON.stringify(lastAgentTimestamp));\n}';
  const ssIdx = f.indexOf(saveStateEnd);
  if (ssIdx === -1) { console.error('Could not find saveState end'); process.exit(1); }
  const insertAt = ssIdx + saveStateEnd.length;

  const newFn = \`

/**
 * Validate that every session in the DB has a corresponding JSONL file on disk.
 * Remove stale entries that point to archived or deleted session files.
 * This prevents \"No conversation found with session ID\" errors at container startup.
 */
function pruneStaleSessionIds(): void {
  let pruned = 0;
  for (const [groupFolder, sessionId] of Object.entries(sessions)) {
    const sessionFilePath = path.join(
      DATA_DIR,
      'sessions',
      groupFolder,
      '.claude',
      'projects',
      '-workspace-group',
      \\\`\\\${sessionId}.jsonl\\\`,
    );
    if (!fs.existsSync(sessionFilePath)) {
      logger.warn(
        { groupFolder, sessionId, expectedPath: sessionFilePath },
        'Stale session ID: JSONL file missing, removing DB entry',
      );
      deleteSession(groupFolder);
      delete sessions[groupFolder];
      pruned++;
    }
  }
  if (pruned > 0) {
    logger.info({ pruned }, 'Pruned stale session IDs on startup');
  }
}\`;

  f = f.slice(0, insertAt) + newFn + f.slice(insertAt);
  console.log('   Added pruneStaleSessionIds()');
  changed = true;
}

// Call pruneStaleSessionIds after loadState in main()
if (!f.includes('pruneStaleSessionIds()')) {
  f = f.replace(
    'loadState();\n\n  restoreRemoteControl',
    'loadState();\n  pruneStaleSessionIds();\n\n  restoreRemoteControl'
  );
  console.log('   Added pruneStaleSessionIds() call in main()');
  changed = true;
}

if (changed) fs.writeFileSync('$SRC/index.ts', f);
"

# --- Fix 2: Cursor advance only after confirmed response ---
echo "2. Fixing cursor advance timing..."

node -e "
const fs = require('fs');
let f = fs.readFileSync('$SRC/index.ts', 'utf8');
let changed = false;

// Fix 2a: Remove saveState after pre-advance cursor
// Pattern: after the for-loop that sets lastAgentTimestamp, remove the saveState() call
const preAdvance = /(\s+lastAgentTimestamp\[jid\] = lastTs;\n\s+\}\n)\s+saveState\(\);\n/;
if (preAdvance.test(f)) {
  f = f.replace(preAdvance, '\$1');
  console.log('   Removed premature saveState() after cursor pre-advance');
  changed = true;
}

// Fix 2b: Add saveState after confirmed output sent
if (!f.includes('// Persist cursor now that output was confirmed')) {
  f = f.replace(
    'outputSentToUser = true;\n',
    'outputSentToUser = true;\n          // Persist cursor now that output was confirmed sent to user\n          saveState();\n'
  );
  console.log('   Added saveState() after confirmed output sent');
  changed = true;
}

// Fix 2c: Add saveState on successful completion without output
if (!f.includes('Agent completed successfully')) {
  f = f.replace(
    /(\s+return false;\n\s+\}\n\n)\s+(return true;\n\})/,
    '\$1  // Agent completed successfully. Persist cursor if not already saved.\n  if (!outputSentToUser) {\n    saveState();\n  }\n\n  \$2'
  );
  console.log('   Added saveState() on successful completion');
  changed = true;
}

// Fix 2d: Remove saveState from pipe path
const pipePattern = /(messagesToSend\[messagesToSend\.length - 1\]\.timestamp;\n)\s+saveState\(\);\n/;
if (pipePattern.test(f)) {
  f = f.replace(pipePattern, '\$1');
  console.log('   Removed premature saveState() from pipe path');
  changed = true;
}

if (changed) fs.writeFileSync('$SRC/index.ts', f);
"

echo ""
echo "=== All code fixes applied ==="
echo "Next steps:"
echo "  1. Build: cd /Users/lucascarroll/nanoclaw && npm run build"
echo "  2. Clean cron: bash /Users/lucascarroll/nanoclaw/src/cleanup-cron.sh"
echo "  3. Restart: pm2 restart nanoclaw"
