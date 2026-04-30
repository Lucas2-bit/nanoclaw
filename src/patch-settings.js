// Patch container-runner.ts to read per-group config.json env overrides
const fs = require('fs');
const file = '/Users/lucascarroll/nanoclaw/src/container-runner.ts';
let src = fs.readFileSync(file, 'utf8');

// Patch 1: Insert config-reading block between the existsSync check and writeFileSync
const old1 = `  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(`;

const new1 = `  if (!fs.existsSync(settingsFile)) {
    // Read per-group env overrides from groups/<folder>/config.json
    const groupConfigFile = path.join(GROUPS_DIR, group.folder, 'config.json');
    let groupEnvOverrides: Record<string, string> = {};
    if (fs.existsSync(groupConfigFile)) {
      try {
        const groupConfig = JSON.parse(fs.readFileSync(groupConfigFile, 'utf8'));
        if (groupConfig.env && typeof groupConfig.env === 'object') {
          groupEnvOverrides = groupConfig.env as Record<string, string>;
        }
      } catch {
        // Ignore malformed config
      }
    }
    fs.writeFileSync(`;

// Patch 2: Spread overrides into the env block (after DISABLE_AUTO_MEMORY)
const old2 = `            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
          mcpServers: {`;

const new2 = `            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
            ...groupEnvOverrides,
          },
          mcpServers: {`;

if (!src.includes(old1)) { console.error('ERROR: Patch 1 anchor not found'); process.exit(1); }
if (!src.includes(old2)) { console.error('ERROR: Patch 2 anchor not found'); process.exit(1); }

src = src.replace(old1, new1).replace(old2, new2);
fs.writeFileSync(file, src);
console.log('Patched successfully');
