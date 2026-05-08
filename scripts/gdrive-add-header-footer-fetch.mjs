import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DOC_ID = '1FneHDKLLJQpUjmAm3CkvUx0O_9O3mBtAyrp4Wq82QIs';
const HEADER_TEXT = 'SEPARATION AND RELEASE AGREEMENT — CONFIDENTIAL';

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

async function batchUpdate(token, requests) {
  const res = await fetch(`https://docs.googleapis.com/v1/documents/${DOC_ID}:batchUpdate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ requests }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`batchUpdate failed: ${res.status} ${text}`);
  return JSON.parse(text);
}

function segmentLength(segment) {
  if (!segment?.content) return 0;
  let max = 0;
  for (const el of segment.content) {
    if (typeof el.endIndex === 'number' && el.endIndex > max) max = el.endIndex;
  }
  return max;
}

async function main() {
  const token = await getAccessToken();

  // 1. Discover existing header/footer IDs
  const doc = await docsGet(token);
  const docStyle = doc.documentStyle || {};
  let headerId = docStyle.defaultHeaderId || null;
  let footerId = docStyle.defaultFooterId || null;

  // 2a/d. Create header/footer if missing
  const createReqs = [];
  if (!headerId) createReqs.push({ createHeader: { type: 'DEFAULT' } });
  if (!footerId) createReqs.push({ createFooter: { type: 'DEFAULT' } });

  if (createReqs.length) {
    const res = await batchUpdate(token, createReqs);
    for (const r of res.replies || []) {
      if (r.createHeader?.headerId) headerId = r.createHeader.headerId;
      if (r.createFooter?.footerId) footerId = r.createFooter.footerId;
    }
  }
  if (!headerId || !footerId) {
    throw new Error(`Missing IDs after creation: header=${headerId} footer=${footerId}`);
  }

  // Re-fetch to inspect current header/footer contents (idempotency)
  const after = await docsGet(token);
  const headerEnd = segmentLength(after.headers?.[headerId]);
  const footerEnd = segmentLength(after.footers?.[footerId]);

  const reqs = [];

  // Clear existing content (preserve final implicit newline)
  if (headerEnd > 1) {
    reqs.push({
      deleteContentRange: {
        range: { segmentId: headerId, startIndex: 0, endIndex: headerEnd - 1 },
      },
    });
  }
  if (footerEnd > 1) {
    reqs.push({
      deleteContentRange: {
        range: { segmentId: footerId, startIndex: 0, endIndex: footerEnd - 1 },
      },
    });
  }

  // 2b. Insert header text
  reqs.push({
    insertText: {
      location: { segmentId: headerId, index: 0 },
      text: HEADER_TEXT,
    },
  });

  // 2c. Format header: 9pt grey #666666, centered
  reqs.push({
    updateTextStyle: {
      range: { segmentId: headerId, startIndex: 0, endIndex: HEADER_TEXT.length },
      textStyle: {
        fontSize: { magnitude: 9, unit: 'PT' },
        foregroundColor: {
          color: { rgbColor: { red: 0x66 / 255, green: 0x66 / 255, blue: 0x66 / 255 } },
        },
      },
      fields: 'fontSize,foregroundColor',
    },
  });
  reqs.push({
    updateParagraphStyle: {
      range: { segmentId: headerId, startIndex: 0, endIndex: HEADER_TEXT.length },
      paragraphStyle: { alignment: 'CENTER' },
      fields: 'alignment',
    },
  });

  // 2e. Insert PAGE_NUMBER auto-text into the footer.
  // The Docs REST API does not support an "insertPageNumber" request — the
  // Request union does not include it. We attempt it and gracefully fall back
  // to a literal "Page " label so the footer is at least styled correctly.
  // Either way the paragraph alignment below right-aligns the footer.
  reqs.push({
    insertText: {
      location: { segmentId: footerId, index: 0 },
      text: 'Page ',
    },
  });
  reqs.push({
    updateTextStyle: {
      range: { segmentId: footerId, startIndex: 0, endIndex: 'Page '.length },
      textStyle: {
        fontSize: { magnitude: 9, unit: 'PT' },
        foregroundColor: {
          color: { rgbColor: { red: 0x66 / 255, green: 0x66 / 255, blue: 0x66 / 255 } },
        },
      },
      fields: 'fontSize,foregroundColor',
    },
  });

  // 2f. Right-align footer
  reqs.push({
    updateParagraphStyle: {
      range: { segmentId: footerId, startIndex: 0, endIndex: 'Page '.length },
      paragraphStyle: { alignment: 'END' },
      fields: 'alignment',
    },
  });

  reqs.push({
    updateDocumentStyle: {
      documentStyle: { pageNumberStart: 1 },
      fields: 'pageNumberStart',
    },
  });

  await batchUpdate(token, reqs);

  // Try the (undocumented in REST) insertPageNumber request for live numbering.
  let pageNumberInserted = false;
  try {
    await batchUpdate(token, [
      {
        insertPageNumber: {
          location: { segmentId: footerId, index: 'Page '.length },
        },
      },
    ]);
    pageNumberInserted = true;
  } catch {
    pageNumberInserted = false;
  }

  return { headerId, footerId, pageNumberInserted };
}

try {
  const result = await main();
  console.log('SUCCESS');
  console.log(JSON.stringify(result, null, 2));
  if (!result.pageNumberInserted) {
    console.log(
      '\nNOTE: The Google Docs REST API does not expose an insertPageNumber ' +
        'request. The footer contains the literal text "Page " right-aligned. ' +
        'For a live page number field, open the doc and use Insert → Page numbers.'
    );
  }
} catch (err) {
  console.error('FAILURE');
  console.error(err.message);
  process.exit(1);
}
