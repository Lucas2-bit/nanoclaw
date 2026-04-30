#!/usr/bin/env node
// backup-gdrive-upload.js
// Uploads local backup files to a "Nanoclaw Backups" folder on Google Drive.
// Uses OAuth credentials from ~/.gdrive-mcp/credentials.json
//
// Usage: node backup-gdrive-upload.js <file1> [file2] ...
// Place this file at: ~/nanoclaw/backup-gdrive-upload.js

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const { google } = require(path.join(__dirname, 'node_modules/googleapis'));

const CREDENTIALS_PATH = path.join(process.env.HOME, '.gdrive-mcp/credentials.json');
const OAUTH_KEYS_PATH = path.join(process.env.HOME, '.gdrive-mcp/gcp-oauth.keys.json');
const DRIVE_FOLDER_NAME = 'Nanoclaw Backups';

async function getAuthClient() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const keys = JSON.parse(fs.readFileSync(OAUTH_KEYS_PATH, 'utf8'));
  const { client_id, client_secret } = keys.web || keys.installed;

  const oauth2Client = new google.auth.OAuth2(client_id, client_secret);
  oauth2Client.setCredentials(credentials);

  // Save refreshed tokens if they change
  oauth2Client.on('tokens', (tokens) => {
    const current = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const updated = { ...current, ...tokens };
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(updated, null, 2));
  });

  return oauth2Client;
}

async function getOrCreateFolder(drive, folderName) {
  const res = await drive.files.list({
    q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
  });

  if (res.data.files.length > 0) {
    return res.data.files[0].id;
  }

  const folder = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id',
  });

  console.log(`Created Google Drive folder: ${folderName} (${folder.data.id})`);
  return folder.data.id;
}

async function uploadFile(drive, folderId, filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    console.log(`Skipping — file not found: ${filePath}`);
    return;
  }

  const fileName = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: {
      mimeType: 'application/octet-stream',
      body: fs.createReadStream(filePath),
    },
    fields: 'id, name, size',
  });

  console.log(`Uploaded: ${fileName} (${fileSize} bytes) → Drive ID: ${res.data.id}`);
}

async function pruneOldBackups(drive, folderId, patternPrefix, keepDays = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - keepDays);

  const res = await drive.files.list({
    q: `'${folderId}' in parents and name contains '${patternPrefix}' and trashed=false`,
    fields: 'files(id, name, createdTime)',
    orderBy: 'createdTime',
  });

  for (const file of res.data.files) {
    if (new Date(file.createdTime) < cutoff) {
      await drive.files.delete({ fileId: file.id });
      console.log(`Pruned old backup from Drive: ${file.name}`);
    }
  }
}

async function main() {
  const filesToUpload = process.argv.slice(2).filter(Boolean);

  if (filesToUpload.length === 0) {
    console.error('No files specified');
    process.exit(1);
  }

  const auth = await getAuthClient();
  const drive = google.drive({ version: 'v3', auth });

  const folderId = await getOrCreateFolder(drive, DRIVE_FOLDER_NAME);

  for (const filePath of filesToUpload) {
    await uploadFile(drive, folderId, filePath);
  }

  // Prune Drive copies older than 30 days
  await pruneOldBackups(drive, folderId, 'messages_');
  await pruneOldBackups(drive, folderId, 'ulterior_');

  console.log('Google Drive sync complete');
}

main().catch((err) => {
  console.error('Google Drive upload error:', err.message);
  process.exit(1);
});
