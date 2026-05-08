import { google } from 'googleapis';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DOC_ID = '1FneHDKLLJQpUjmAm3CkvUx0O_9O3mBtAyrp4Wq82QIs';
const FILE_PATH = '/Users/lucascarroll/nanoclaw/groups/telegram_main/legal/stanley-separation-agreement-v2.md';
const DOC_NAME = 'Separation and Release Agreement - Lucas Carroll - v2';

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

const md = fs.readFileSync(FILE_PATH, 'utf8');

// Inline formatter: **bold** -> <strong>, *italic* -> <em>, escape HTML
function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inlineFormat(s) {
  let out = escapeHtml(s);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return out;
}

const lines = md.split('\n');
const htmlParts = [];
let i = 0;
let inList = false;
let listType = null; // 'bullet' or 'subclause'

function closeList() {
  if (inList) {
    htmlParts.push(listType === 'bullet' ? '</ul>' : '</div>');
    inList = false;
    listType = null;
  }
}

while (i < lines.length) {
  const line = lines[i];
  const trimmed = line.trim();

  // Horizontal rule
  if (trimmed === '---') {
    closeList();
    htmlParts.push('<hr/>');
    i++;
    continue;
  }

  // H1 -> centered title
  if (trimmed.startsWith('# ')) {
    closeList();
    htmlParts.push(`<h1 class="doc-title">${inlineFormat(trimmed.slice(2))}</h1>`);
    i++;
    continue;
  }

  // H2 -> section header
  if (trimmed.startsWith('## ')) {
    closeList();
    const txt = trimmed.slice(3);
    const cls = /SCHEDULE/i.test(txt) ? 'schedule-header' : 'section-header';
    htmlParts.push(`<h2 class="${cls}">${inlineFormat(txt)}</h2>`);
    i++;
    continue;
  }

  // H3 -> clause heading
  if (trimmed.startsWith('### ')) {
    closeList();
    htmlParts.push(`<h3 class="clause-heading">${inlineFormat(trimmed.slice(4))}</h3>`);
    i++;
    continue;
  }

  // Sub-clause: starts with three spaces and "(a)" / "(b)" etc.
  // Pattern in source: "   (a) text..."
  const subMatch = line.match(/^\s{2,}\(([a-z])\)\s+(.+)$/);
  if (subMatch) {
    if (!inList || listType !== 'subclause') {
      closeList();
      htmlParts.push('<div class="subclause-list">');
      inList = true;
      listType = 'subclause';
    }
    htmlParts.push(
      `<p class="subclause"><span class="subclause-marker">(${subMatch[1]})</span> ${inlineFormat(subMatch[2])}</p>`
    );
    i++;
    continue;
  }

  // Numbered clause: "1.1.", "2.3.", "10.2." etc.
  const numMatch = trimmed.match(/^(\d+\.\d+)\.\s+(.+)$/);
  if (numMatch) {
    closeList();
    htmlParts.push(
      `<p class="numbered-clause"><span class="clause-number">${numMatch[1]}</span> ${inlineFormat(numMatch[2])}</p>`
    );
    i++;
    continue;
  }

  // Recital lettered (A. B. C. D.)
  const recitalMatch = trimmed.match(/^([A-Z])\.\s+(.+)$/);
  if (recitalMatch) {
    closeList();
    htmlParts.push(
      `<p class="recital"><span class="recital-letter">${recitalMatch[1]}.</span> ${inlineFormat(recitalMatch[2])}</p>`
    );
    i++;
    continue;
  }

  // Bullet list item
  if (trimmed.startsWith('- ')) {
    if (!inList || listType !== 'bullet') {
      closeList();
      htmlParts.push('<ul class="party-list">');
      inList = true;
      listType = 'bullet';
    }
    htmlParts.push(`<li>${inlineFormat(trimmed.slice(2))}</li>`);
    i++;
    continue;
  }

  // Blank line
  if (trimmed === '') {
    if (inList && listType === 'bullet') {
      closeList();
    }
    i++;
    continue;
  }

  // Italic-only paragraph (e.g. closing note)
  if (/^\*[^*].*\*$/.test(trimmed)) {
    closeList();
    htmlParts.push(`<p class="note">${inlineFormat(trimmed)}</p>`);
    i++;
    continue;
  }

  // Signature lines with underscores
  if (/____/.test(trimmed)) {
    closeList();
    htmlParts.push(`<p class="signature-line">${inlineFormat(trimmed)}</p>`);
    i++;
    continue;
  }

  // Default paragraph
  closeList();
  htmlParts.push(`<p>${inlineFormat(trimmed)}</p>`);
  i++;
}
closeList();

const body = htmlParts.join('\n');

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<title>${DOC_NAME}</title>
<style>
  @page { margin: 1in; }
  body {
    font-family: 'Times New Roman', Georgia, serif;
    font-size: 12pt;
    line-height: 1.5;
    color: #000;
  }
  h1.doc-title {
    text-align: center;
    font-weight: bold;
    font-size: 16pt;
    margin: 0 0 24pt 0;
    text-transform: uppercase;
    letter-spacing: 1px;
  }
  h2.section-header {
    text-align: center;
    font-weight: bold;
    font-size: 14pt;
    margin: 18pt 0 12pt 0;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  h2.schedule-header {
    text-align: center;
    font-weight: bold;
    font-size: 14pt;
    margin: 24pt 0 12pt 0;
    text-transform: uppercase;
  }
  h3.clause-heading {
    font-weight: bold;
    font-size: 12pt;
    margin: 18pt 0 8pt 0;
  }
  p {
    margin: 0 0 10pt 0;
    text-align: justify;
  }
  p.numbered-clause {
    margin: 0 0 10pt 0;
    text-align: justify;
    text-indent: 0;
  }
  span.clause-number {
    font-weight: bold;
    margin-right: 6pt;
  }
  div.subclause-list {
    margin: 0 0 10pt 0;
    padding-left: 36pt;
  }
  p.subclause {
    margin: 0 0 8pt 0;
    text-align: justify;
  }
  span.subclause-marker {
    font-weight: bold;
    margin-right: 4pt;
  }
  p.recital {
    margin: 0 0 10pt 0;
    text-align: justify;
    padding-left: 18pt;
    text-indent: -18pt;
  }
  span.recital-letter {
    font-weight: bold;
    margin-right: 8pt;
  }
  ul.party-list {
    margin: 0 0 12pt 0;
    padding-left: 24pt;
  }
  ul.party-list li {
    margin: 0 0 4pt 0;
  }
  hr {
    border: none;
    border-top: 1px solid #000;
    margin: 18pt 0;
  }
  p.signature-line {
    font-family: 'Courier New', monospace;
    margin: 6pt 0;
  }
  p.note {
    font-style: italic;
    text-align: center;
    margin: 18pt 0 0 0;
    font-size: 11pt;
  }
  strong { font-weight: bold; }
</style>
</head>
<body>
${body}
</body>
</html>`;

const res = await drive.files.update({
  fileId: DOC_ID,
  requestBody: {
    name: DOC_NAME,
    mimeType: 'application/vnd.google-apps.document',
  },
  media: {
    mimeType: 'text/html',
    body: html,
  },
  fields: 'id,webViewLink,modifiedTime',
  supportsAllDrives: true,
});

const docId = res.data.id;
console.log(JSON.stringify({
  status: 'success',
  id: docId,
  modifiedTime: res.data.modifiedTime,
  editLink: `https://docs.google.com/document/d/${docId}/edit`,
  webViewLink: res.data.webViewLink,
}, null, 2));
