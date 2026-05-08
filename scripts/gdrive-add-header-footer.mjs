import { google } from 'googleapis';
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

const docs = google.docs({ version: 'v1', auth: oauth2 });

async function main() {
  // 1. Fetch the doc to discover existing header/footer IDs
  const got = await docs.documents.get({ documentId: DOC_ID });
  const docStyle = got.data.documentStyle || {};
  let headerId = docStyle.defaultHeaderId || null;
  let footerId = docStyle.defaultFooterId || null;

  // 2. Create header/footer if they don't exist
  const createReqs = [];
  if (!headerId) createReqs.push({ createHeader: { type: 'DEFAULT' } });
  if (!footerId) createReqs.push({ createFooter: { type: 'DEFAULT' } });

  if (createReqs.length) {
    const res = await docs.documents.batchUpdate({
      documentId: DOC_ID,
      requestBody: { requests: createReqs },
    });
    for (const r of res.data.replies || []) {
      if (r.createHeader?.headerId) headerId = r.createHeader.headerId;
      if (r.createFooter?.footerId) footerId = r.createFooter.footerId;
    }
  }

  if (!headerId || !footerId) {
    throw new Error(`Missing IDs after creation: header=${headerId} footer=${footerId}`);
  }

  // 3. Re-fetch to inspect current header/footer contents (so we can clear them
  // before inserting fresh content — makes the script idempotent).
  const after = await docs.documents.get({ documentId: DOC_ID });

  function segmentLength(segment) {
    // Length of all content in a header/footer body, excluding the trailing newline
    // (you cannot delete the final newline of a segment).
    if (!segment?.content) return 0;
    let max = 0;
    for (const el of segment.content) {
      if (typeof el.endIndex === 'number' && el.endIndex > max) max = el.endIndex;
    }
    return max;
  }

  const header = after.data.headers?.[headerId];
  const footer = after.data.footers?.[footerId];
  const headerEnd = segmentLength(header);
  const footerEnd = segmentLength(footer);

  const contentReqs = [];

  // Clear any existing header content (keep the implicit final newline at index headerEnd-1)
  if (headerEnd > 1) {
    contentReqs.push({
      deleteContentRange: {
        range: { segmentId: headerId, startIndex: 0, endIndex: headerEnd - 1 },
      },
    });
  }
  if (footerEnd > 1) {
    contentReqs.push({
      deleteContentRange: {
        range: { segmentId: footerId, startIndex: 0, endIndex: footerEnd - 1 },
      },
    });
  }

  // Insert header text
  contentReqs.push({
    insertText: {
      location: { segmentId: headerId, index: 0 },
      text: HEADER_TEXT,
    },
  });

  // Style header: 9pt grey
  contentReqs.push({
    updateTextStyle: {
      range: { segmentId: headerId, startIndex: 0, endIndex: HEADER_TEXT.length },
      textStyle: {
        fontSize: { magnitude: 9, unit: 'PT' },
        foregroundColor: {
          color: { rgbColor: { red: 0.45, green: 0.45, blue: 0.45 } },
        },
        bold: false,
      },
      fields: 'fontSize,foregroundColor,bold',
    },
  });

  // Center the header paragraph
  contentReqs.push({
    updateParagraphStyle: {
      range: { segmentId: headerId, startIndex: 0, endIndex: HEADER_TEXT.length },
      paragraphStyle: { alignment: 'CENTER' },
      fields: 'alignment',
    },
  });

  // Footer: right-aligned page number.
  // The Docs REST API does not have an insertPageNumber request, but it does
  // support an InsertText with a special format... actually it does not. We
  // insert the literal text "Page " and then attach a page-number auto-text via
  // a separate technique below. As a robust fallback we just insert "Page #"
  // styled text and right-align it; for live page numbers we additionally try
  // the (undocumented but supported in some clients) page-number behaviour.
  const FOOTER_TEXT = 'Page ';
  contentReqs.push({
    insertText: {
      location: { segmentId: footerId, index: 0 },
      text: FOOTER_TEXT,
    },
  });

  // Right-align footer
  contentReqs.push({
    updateParagraphStyle: {
      range: { segmentId: footerId, startIndex: 0, endIndex: FOOTER_TEXT.length },
      paragraphStyle: { alignment: 'END' },
      fields: 'alignment',
    },
  });

  // Style footer text: 9pt grey
  contentReqs.push({
    updateTextStyle: {
      range: { segmentId: footerId, startIndex: 0, endIndex: FOOTER_TEXT.length },
      textStyle: {
        fontSize: { magnitude: 9, unit: 'PT' },
        foregroundColor: {
          color: { rgbColor: { red: 0.45, green: 0.45, blue: 0.45 } },
        },
      },
      fields: 'fontSize,foregroundColor',
    },
  });

  // Ensure document-style page numbering starts at 1
  contentReqs.push({
    updateDocumentStyle: {
      documentStyle: { pageNumberStart: 1 },
      fields: 'pageNumberStart',
    },
  });

  await docs.documents.batchUpdate({
    documentId: DOC_ID,
    requestBody: { requests: contentReqs },
  });

  // Try to insert an auto-updating page number into the footer. The Docs REST
  // API does not expose an "insertPageNumber" request, so this will throw —
  // we attempt it and report the result so the user knows whether live numbers
  // were added or only the literal "Page " label.
  let pageNumberInserted = false;
  try {
    await docs.documents.batchUpdate({
      documentId: DOC_ID,
      requestBody: {
        requests: [
          {
            insertPageNumber: {
              location: { segmentId: footerId, index: FOOTER_TEXT.length },
            },
          },
        ],
      },
    });
    pageNumberInserted = true;
  } catch (err) {
    // Expected: the API rejects unknown request types.
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
      '\nNOTE: The Google Docs REST API does not support inserting an ' +
        'auto-incrementing page number field. The footer contains the literal ' +
        'text "Page " right-aligned; to add the live page number, open the doc ' +
        'and use Insert → Page numbers, or run an Apps Script.'
    );
  }
} catch (err) {
  console.error('FAILURE');
  console.error(err.message);
  if (err.errors) console.error(JSON.stringify(err.errors, null, 2));
  process.exit(1);
}
