import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DOC_ID = process.argv[2] || '1FneHDKLLJQpUjmAm3CkvUx0O_9O3mBtAyrp4Wq82QIs';

const HOME = os.homedir();
const CREDS_PATH = path.join(HOME, '.gdrive-mcp', 'credentials.json');
const KEYS_PATH = path.join(HOME, '.gdrive-mcp', 'gcp-oauth.keys.json');

const keys = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8')).installed;
const tokens = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));

async function getAccessToken() {
  if (tokens.access_token && tokens.expiry_date && Date.now() < tokens.expiry_date - 60_000) {
    return tokens.access_token;
  }
  const body = new URLSearchParams({
    client_id: keys.client_id,
    client_secret: keys.client_secret,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  const fresh = await res.json();
  const merged = {
    ...tokens,
    access_token: fresh.access_token,
    expiry_date: Date.now() + fresh.expires_in * 1000,
  };
  fs.writeFileSync(CREDS_PATH, JSON.stringify(merged, null, 2));
  return merged.access_token;
}

async function docsGet(token) {
  const res = await fetch(`https://docs.googleapis.com/v1/documents/${DOC_ID}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function extractText(doc) {
  const out = [];
  const body = doc.body;
  if (!body?.content) return '';
  for (const el of body.content) {
    if (el.paragraph) {
      for (const pe of el.paragraph.elements || []) {
        if (pe.textRun?.content) out.push(pe.textRun.content);
        else if (pe.pageBreak) out.push('\n');
        else if (pe.horizontalRule) out.push('\n---\n');
      }
    } else if (el.table) {
      for (const row of el.table.tableRows || []) {
        const cellTexts = [];
        for (const cell of row.tableCells || []) {
          const cellOut = [];
          for (const cc of cell.content || []) {
            if (cc.paragraph) {
              for (const pe of cc.paragraph.elements || []) {
                if (pe.textRun?.content) cellOut.push(pe.textRun.content);
              }
            }
          }
          cellTexts.push(cellOut.join('').trim());
        }
        out.push(cellTexts.join(' | ') + '\n');
      }
    }
  }
  return out.join('');
}

const token = await getAccessToken();
const doc = await docsGet(token);
const text = extractText(doc);
process.stdout.write(text);
