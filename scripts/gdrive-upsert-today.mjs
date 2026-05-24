import { google } from 'googleapis';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const CREDS_PATH = path.join(HOME, '.gdrive-mcp', 'credentials.json');
const KEYS_PATH = path.join(HOME, '.gdrive-mcp', 'gcp-oauth.keys.json');

const ALTEGO_FOLDER = '1G0rCGFiKMYwCe0fwCw0DzKqbUtvBkTQw';

const UPLOADS = [
  { file: '/Users/lucascarroll/nanoclaw/groups/telegram_main/ventures/parago/RESTORATION_PLAN.md', folder: ALTEGO_FOLDER },
  { file: '/Users/lucascarroll/nanoclaw/groups/telegram_main/ventures/parago/specs/UI_REDESIGN_SPEC_v1.md', folder: ALTEGO_FOLDER },
  { file: '/Users/lucascarroll/nanoclaw/groups/telegram_main/ventures/parago/specs/UI_REDESIGN_SPEC_v2.md', folder: ALTEGO_FOLDER },
  { file: '/Users/lucascarroll/nanoclaw/groups/telegram_main/ventures/parago/reviews/panel-ui-review-20260522.md', folder: ALTEGO_FOLDER },
];

const keys = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8')).installed;
const tokens = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
const oauth2 = new google.auth.OAuth2(keys.client_id, keys.client_secret, keys.redirect_uris?.[0]);
oauth2.setCredentials(tokens);
oauth2.on('tokens', (t) => {
  const merged = { ...tokens, ...t };
  fs.writeFileSync(CREDS_PATH, JSON.stringify(merged, null, 2));
});

const drive = google.drive({ version: 'v3', auth: oauth2 });

function mimeFor(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.html') return 'text/html';
  if (ext === '.md') return 'text/markdown';
  if (ext === '.txt') return 'text/plain';
  if (ext === '.json') return 'application/json';
  return 'application/octet-stream';
}

async function findExisting(name, folderId) {
  const q = `name = '${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed = false`;
  const res = await drive.files.list({
    q,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    pageSize: 10,
  });
  return res.data.files || [];
}

const results = [];
for (const { file: filePath, folder } of UPLOADS) {
  const name = path.basename(filePath);
  const mimeType = mimeFor(filePath);
  if (!fs.existsSync(filePath)) {
    results.push({ name, action: 'skip', error: 'file not found' });
    console.error(`MISSING ${filePath}`);
    continue;
  }
  try {
    const existing = await findExisting(name, folder);
    let res, action;
    if (existing.length > 0) {
      const id = existing[0].id;
      res = await drive.files.update({
        fileId: id,
        media: { mimeType, body: fs.createReadStream(filePath) },
        fields: 'id, name, webViewLink, modifiedTime',
        supportsAllDrives: true,
      });
      action = 'updated';
      if (existing.length > 1) {
        console.error(`WARN  multiple matches for ${name} (${existing.length}); updated first`);
      }
    } else {
      res = await drive.files.create({
        requestBody: { name, parents: [folder] },
        media: { mimeType, body: fs.createReadStream(filePath) },
        fields: 'id, name, webViewLink, modifiedTime',
        supportsAllDrives: true,
      });
      action = 'created';
    }
    results.push({
      name: res.data.name,
      id: res.data.id,
      link: res.data.webViewLink,
      action,
      folder,
    });
    console.error(`${action.toUpperCase()}  ${res.data.name}  ${res.data.id}`);
  } catch (e) {
    results.push({ name, action: 'error', error: e.message });
    console.error(`ERR ${name}: ${e.message}`);
  }
}

console.log(JSON.stringify({
  total: results.length,
  created: results.filter(r => r.action === 'created').length,
  updated: results.filter(r => r.action === 'updated').length,
  failed: results.filter(r => r.action === 'error' || r.action === 'skip').length,
  results,
}, null, 2));
