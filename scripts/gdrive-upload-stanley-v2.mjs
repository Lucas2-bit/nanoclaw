import { google } from 'googleapis';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FOLDER_ID = '1Ss_fG3CjV8-5wlKnINFvtT9jxlM9zGPr';
const FILE_PATH = '/Users/lucascarroll/nanoclaw/groups/telegram_main/legal/stanley-separation-agreement-v2.md';

const HOME = os.homedir();
const CREDS_PATH = path.join(HOME, '.gdrive-mcp', 'credentials.json');
const KEYS_PATH = path.join(HOME, '.gdrive-mcp', 'gcp-oauth.keys.json');

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

const name = path.basename(FILE_PATH);
const res = await drive.files.create({
  requestBody: { name, parents: [FOLDER_ID] },
  media: { mimeType: 'text/markdown', body: fs.createReadStream(FILE_PATH) },
  fields: 'id',
  supportsAllDrives: true,
});

console.log(res.data.id);
