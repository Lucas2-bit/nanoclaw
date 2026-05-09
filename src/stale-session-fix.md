# Stale Session Self-Healing Fix — Apply to /Users/lucascarroll/nanoclaw/src/index.ts

This fix addresses a bug that has recurred 8 times. Four edits needed.

## EDIT 1: Add constant (near top of file, with other constants)

```typescript
const GHOST_MAX_BYTES = 1024;
```

## EDIT 2: Add pruneOrphanSessionFiles function

Insert AFTER the closing brace of pruneStaleSessionIds() (around line 255) and BEFORE registerGroup (around line 257):

```typescript
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
      const sessionId = file.replace(/\.jsonl$/, '');
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
          const archiveName = `orphan_${sessionId}_${timestamp}.jsonl`;
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
```

## EDIT 3: Runtime validation before container launch

At line 575, change const to let and add validation block:
```typescript
  let sessionId = sessions[group.folder];

  // Runtime validation: verify session JSONL exists before passing to container.
  if (sessionId) {
    const sessionFilePath = path.join(
      DATA_DIR,
      'sessions',
      group.folder,
      '.claude',
      'projects',
      '-workspace-group',
      `${sessionId}.jsonl`,
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
  }
```

## EDIT 4: Add startup call

After line 873 (pruneStaleSessionIds();), add:
```typescript
  pruneOrphanSessionFiles();
```

## After all edits: run npm run build to verify it compiles cleanly.
