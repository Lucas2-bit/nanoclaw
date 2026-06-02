// Exercises the core matching function exported by scripts/scan-secrets.cjs.
// We intentionally test the function, NOT the process: spawning node to
// exercise the CLI would couple the suite to git state and produce flaky
// results on contributor machines. createRequire is needed because vitest
// runs in ESM mode and scan-secrets is CJS.
//
// Every planted secret in this file is constructed at runtime via string
// concatenation so the source itself contains NO contiguous pattern match
// (otherwise `npm run scan:secrets` would flag this file). The lines that
// could still match in source (e.g. the inline allow-marker example, the
// slack token literal) carry `secret-scan:allow` belt-and-braces.

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const requireCjs = createRequire(import.meta.url);
const { scanContent, ALLOW_MARKER } = requireCjs('./scan-secrets.cjs') as {
  scanContent: (
    text: string,
  ) => Array<{ line: number; pattern: string; masked: string }>;
  ALLOW_MARKER: string;
};

describe('scanContent', () => {
  it('detects a planted AWS access key', () => {
    const planted = 'AKIA' + 'EXAMPLEKEYBADBAD0';
    const hits = scanContent(planted);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].pattern).toBe('aws-akia');
    // Make sure the original secret was masked in the reported output.
    expect(hits[0].masked).not.toContain('EXAMPLEKEYBADBAD');
  });

  it('detects a planted generic secret assignment', () => {
    const long = 'h'.repeat(20);
    const planted = 'password' + ' = ' + "'" + long + "'";
    const hits = scanContent(planted);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.pattern)).toContain('generic-assignment');
  });

  it('detects a planted google-api key', () => {
    const planted = 'AIza' + 'A'.repeat(35);
    const hits = scanContent(planted);
    expect(hits.map((h) => h.pattern)).toContain('google-api');
  });

  it('detects a planted slack token', () => {
    const planted = 'xox' + 'b-1234-abcdEFGH1234';
    const hits = scanContent(planted);
    expect(hits.map((h) => h.pattern)).toContain('slack-token');
  });

  it('detects a private-key header', () => {
    const planted = '-----' + 'BEGIN RSA PRIVATE KEY' + '-----';
    const hits = scanContent(planted);
    expect(hits.map((h) => h.pattern)).toContain('private-key');
  });

  it('suppresses a hit when the line contains the allow marker', () => {
    const allowed = 'AKIA' + 'B'.repeat(16) + ' // ' + ALLOW_MARKER;
    const hits = scanContent(allowed);
    expect(hits).toEqual([]);
  });

  it('returns no hits on clean text', () => {
    const clean =
      'function add(a, b) {\n  // perfectly innocuous source code\n  return a + b;\n}\n';
    expect(scanContent(clean)).toEqual([]);
  });

  it('returns no hits on empty input', () => {
    expect(scanContent('')).toEqual([]);
  });

  it('reports the correct 1-based line number', () => {
    const long = 'x'.repeat(20);
    const planted = 'password' + ' = ' + "'" + long + "'";
    const text = ['line one is fine', planted, 'line three'].join('\n');
    const hits = scanContent(text);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].line).toBe(2);
  });
});
