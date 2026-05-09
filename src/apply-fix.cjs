// Stale Session Self-Healing Patch
// Applies 4 edits to index.ts to fix recurring stale session bug
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'index.ts');
let src = fs.readFileSync(filePath, 'utf8');
const originalLength = src.length;

// EDIT 1: Add GHOST_MAX_BYTES constant after the last import or early constant
// Find the line with "const IDLE_TIMEOUT" or similar early constant and add after it
// Actually, find the first "function" declaration and add before it
const firstFunctionMatch = src.match(/^(function\s)/m);
if (!firstFunctionMatch) {
  console.error('Could not find first function declaration');
  process.exit(1);
}
// More targeted: add before pruneStaleSessionIds
if (src.includes('GHOST_MAX_BYTES')) {
  console.log('EDIT 1: GHOST_MAX_BYTES already exists, skipping');
} else {
  src = src.replace(
    'function pruneStaleSessionIds(): void {',
    'const GHOST_MAX_BYTES = 1024;\n\nfunction pruneStaleSessionIds(): void {'
  );
  console.log('EDIT 1: Added GHOST_MAX_BYTES constant');
}

// EDIT 2: Add pruneOrphanSessionFiles function after pruneStaleSessionIds
if (src.includes('pruneOrphanSessionFiles')) {
  console.log('EDIT 2: pruneOrphanSessionFiles already exists, skipping');
} else {
  const pruneOrphanFn = `
function pruneOrphanSessionFiles(): void {
  const sessionsDir = path.join(DATA_DIR, 'sessions');
  if (!fs.existsSync(sessionsDir)) return;

  const knownSessionIds = new Set(Object.values(sessions));
  let removed = 0;
  let archived = 0;

  let groupFolders: string[];
  try {
    groupFolders = fs.readdirSync(sessionsDir).filter((f) => {
      try {
        return fs.statSync(path.join(sessionsDir, f)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return;
  }

  for (const groupFolder of groupFolders) {
    const projectDir = path.join(
      sessionsDir,
      groupFolder,
      '.claude',
      'projects',
      '-workspace-group',
    );
    if (!fs.existsSync(projectDir)) continue;

    let files: string[];
    try {
      files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const sessionId = file.replace(/\\.jsonl$/, '');
      if (knownSessionIds.has(sessionId)) continue;

      const filePath = path.join(projectDir, file);
      let sizeBytes: number;
      try {
        sizeBytes = fs.statSync(filePath).size;
      } catch {
        continue;
      }

      if (sizeBytes <= GHOST_MAX_BYTES) {
        try {
          fs.unlinkSync(filePath);
          removed++;
          logger.info(
            { groupFolder, sessionId, sizeBytes },
            'Removed ghost session file (orphaned, under 1 KB)',
          );
        } catch (err) {
          logger.warn(
            { err, groupFolder, sessionId },
            'Failed to remove ghost session file',
          );
        }
      } else {
        const archiveDir = path.join(DATA_DIR, 'session-archive', groupFolder);
        try {
          fs.mkdirSync(archiveDir, { recursive: true });
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const archiveName = \`orphan_\${sessionId}_\${timestamp}.jsonl\`;
          fs.renameSync(filePath, path.join(archiveDir, archiveName));
          archived++;
          logger.warn(
            { groupFolder, sessionId, sizeBytes, archiveName },
            'Archived orphan session file (not in DB, over 1 KB)',
          );
        } catch (err) {
          logger.warn(
            { err, groupFolder, sessionId },
            'Failed to archive orphan session file',
          );
        }
      }
    }
  }

  if (removed > 0 || archived > 0) {
    logger.info(
      { removed, archived },
      'Orphan session cleanup complete',
    );
  }
}

`;

  // Insert after the closing of pruneStaleSessionIds function
  // Find the pattern: end of pruneStaleSessionIds followed by registerGroup
  const insertPoint = src.indexOf('function registerGroup(');
  if (insertPoint === -1) {
    console.error('Could not find registerGroup function');
    process.exit(1);
  }
  src = src.slice(0, insertPoint) + pruneOrphanFn + src.slice(insertPoint);
  console.log('EDIT 2: Added pruneOrphanSessionFiles function');
}

// EDIT 3: Runtime validation - change const to let and add validation block
if (src.includes('Stale session detected at runtime')) {
  console.log('EDIT 3: Runtime validation already exists, skipping');
} else {
  const oldLine = '  const sessionId = sessions[group.folder];';
  const newBlock = `  let sessionId = sessions[group.folder];

  // Runtime validation: verify session JSONL exists before passing to container.
  // pruneStaleSessionIds() only runs at startup -- if a file is archived or deleted
  // mid-run, the in-memory map goes stale and containers fail with
  // "No conversation found with session ID". This catches it at invocation time.
  if (sessionId) {
    const sessionFilePath = path.join(
      DATA_DIR,
      'sessions',
      group.folder,
      '.claude',
      'projects',
      '-workspace-group',
      \`\${sessionId}.jsonl\`,
    );
    if (!fs.existsSync(sessionFilePath)) {
      logger.warn(
        { groupFolder: group.folder, sessionId, expectedPath: sessionFilePath },
        'Stale session detected at runtime -- clearing before container launch',
      );
      deleteSession(group.folder);
      delete sessions[group.folder];
      sessionId = undefined;
    }
  }`;

  if (!src.includes(oldLine)) {
    console.error('Could not find "const sessionId = sessions[group.folder];" for EDIT 3');
    process.exit(1);
  }
  src = src.replace(oldLine, newBlock);
  console.log('EDIT 3: Added runtime validation before container launch');
}

// EDIT 4: Add pruneOrphanSessionFiles() call at startup
if (src.includes('pruneOrphanSessionFiles();')) {
  console.log('EDIT 4: Startup call already exists, skipping');
} else {
  src = src.replace(
    "  pruneStaleSessionIds();\n  logger.info('Stale sessions pruned');",
    "  pruneStaleSessionIds();\n  pruneOrphanSessionFiles();\n  logger.info('Stale sessions pruned');"
  );
  console.log('EDIT 4: Added pruneOrphanSessionFiles() startup call');
}

// Write the patched file
fs.writeFileSync(filePath, src, 'utf8');
console.log(`\nPatch applied. File grew from ${originalLength} to ${src.length} bytes.`);
console.log('Run: cd /Users/lucascarroll/nanoclaw && npm run build');
