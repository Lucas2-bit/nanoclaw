import { google } from 'googleapis';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FOLDER_ID = '1kAst1YidfjojsoIMS1h2MSqnKfu9G_Ir';
const HOME = os.homedir();
const CREDS_PATH = path.join(HOME, '.gdrive-mcp', 'credentials.json');
const KEYS_PATH = path.join(HOME, '.gdrive-mcp', 'gcp-oauth.keys.json');

const BASE = '/Users/lucascarroll/nanoclaw/groups/telegram_main/ventures/parago';
const FILES = [
  `${BASE}/investor-materials/engagement-brief-v2.html`,
  `${BASE}/investor-materials/one-pager-v2.html`,
  `${BASE}/investor-materials/faq-sheet-v2.html`,
  `${BASE}/FUNDRAISE_STRATEGY_v1.md`,
  `${BASE}/BUSINESS_PLAN_3YR_DRAFT_v1.md`,
  `${BASE}/DEMO_SCRIPT_v1.md`,
  `${BASE}/INVESTOR_GTM_PLAYBOOK_v1.md`,
];

const keys = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8')).installed;
const tokens = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));

const oauth2 = new google.auth.OAuth2(
  keys.client_id,
  keys.client_secret,
  keys.redirect_uris?.[0]
);
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
  return 'application/octet-stream';
}

const results = [];
for (const filePath of FILES) {
  const name = path.basename(filePath);
  const mimeType = mimeFor(filePath);
  try {
    const res = await drive.files.create({
      requestBody: { name, parents: [FOLDER_ID] },
      media: { mimeType, body: fs.createReadStream(filePath) },
      fields: 'id, name',
      supportsAllDrives: true,
    });
    results.push({ name: res.data.name, id: res.data.id });
    console.error(`OK  ${res.data.name}  ${res.data.id}`);
  } catch (e) {
    results.push({ name, error: e.message });
    console.error(`ERR ${name}: ${e.message}`);
  }
}

console.log(JSON.stringify(results, null, 2));
