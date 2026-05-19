import { google } from 'googleapis';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const CREDS_PATH = path.join(HOME, '.gdrive-mcp', 'credentials.json');
const KEYS_PATH = path.join(HOME, '.gdrive-mcp', 'gcp-oauth.keys.json');

const FILE_PATH = '/Users/lucascarroll/nanoclaw/groups/telegram_main/ventures/parago/video-production/output/parago-v2-final.mp4';

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

// 1. Search for an existing "Parago" folder (not trashed)
const searchRes = await drive.files.list({
  q: "mimeType = 'application/vnd.google-apps.folder' and name = 'Parago' and trashed = false",
  fields: 'files(id, name, parents, owners(emailAddress), modifiedTime)',
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
});

console.error('Parago folders found:', JSON.stringify(searchRes.data.files, null, 2));

let folderId;
if (searchRes.data.files && searchRes.data.files.length > 0) {
  // Pick the most recently modified one
  const sorted = [...searchRes.data.files].sort((a, b) =>
    (b.modifiedTime || '').localeCompare(a.modifiedTime || '')
  );
  folderId = sorted[0].id;
  console.error(`Using existing Parago folder: ${folderId}`);
} else {
  const createRes = await drive.files.create({
    requestBody: { name: 'Parago', mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id, name',
  });
  folderId = createRes.data.id;
  console.error(`Created new Parago folder: ${folderId}`);
}

// 2. Upload the file
const name = path.basename(FILE_PATH);
const uploadRes = await drive.files.create({
  requestBody: { name, parents: [folderId] },
  media: { mimeType: 'video/mp4', body: fs.createReadStream(FILE_PATH) },
  fields: 'id, name, webViewLink',
  supportsAllDrives: true,
});

console.error(`Uploaded: ${uploadRes.data.name}  ${uploadRes.data.id}`);

// 3. Grant anyone-with-link reader access
await drive.permissions.create({
  fileId: uploadRes.data.id,
  requestBody: { role: 'reader', type: 'anyone' },
  supportsAllDrives: true,
});

// 4. Get fresh webViewLink (after permission)
const final = await drive.files.get({
  fileId: uploadRes.data.id,
  fields: 'id, name, webViewLink, webContentLink',
  supportsAllDrives: true,
});

console.log(JSON.stringify({
  folderId,
  fileId: final.data.id,
  name: final.data.name,
  webViewLink: final.data.webViewLink,
  webContentLink: final.data.webContentLink,
}, null, 2));
