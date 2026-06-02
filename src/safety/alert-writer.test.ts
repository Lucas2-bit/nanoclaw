import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DATA_DIR } from '../config.js';
import { writeAlertFile } from './alert-writer.js';

const ALERTS_DIR = path.join(DATA_DIR, 'alerts');

// Drop only files written by these tests; never anything else in the dir.
function readNewest(prefix: string): { name: string; body: string } | null {
  const entries = fs
    .readdirSync(ALERTS_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.startsWith(`${prefix}-`))
    .map((d) => d.name)
    .sort();
  const name = entries[entries.length - 1];
  if (!name) return null;
  return {
    name,
    body: fs.readFileSync(path.join(ALERTS_DIR, name), 'utf-8'),
  };
}

function cleanup(prefix: string): void {
  try {
    const entries = fs
      .readdirSync(ALERTS_DIR, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.startsWith(`${prefix}-`));
    for (const e of entries) fs.unlinkSync(path.join(ALERTS_DIR, e.name));
  } catch {
    /* dir may not exist */
  }
}

describe('writeAlertFile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes a file under DATA_DIR/alerts with the given prefix and exact text', () => {
    const prefix = `test-aw-${process.pid}`;
    cleanup(prefix);
    const body = 'hello\nworld\n';
    writeAlertFile(body, prefix);
    const found = readNewest(prefix);
    expect(found).not.toBeNull();
    expect(found!.name.startsWith(`${prefix}-`)).toBe(true);
    expect(found!.name.endsWith('.txt')).toBe(true);
    expect(found!.body).toBe(body);
    cleanup(prefix);
  });

  it('defaults the prefix to "alert"', () => {
    const prefix = 'alert';
    // Snapshot the dir contents before so we can find the new one without
    // colliding with concurrent producers.
    const before = new Set(
      fs.existsSync(ALERTS_DIR)
        ? fs
            .readdirSync(ALERTS_DIR, { withFileTypes: true })
            .filter((d) => d.isFile())
            .map((d) => d.name)
        : [],
    );
    writeAlertFile('body', undefined);
    const after = fs
      .readdirSync(ALERTS_DIR, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.startsWith(`${prefix}-`))
      .map((d) => d.name);
    const newOne = after.find((n) => !before.has(n));
    expect(newOne).toBeTruthy();
    if (newOne) fs.unlinkSync(path.join(ALERTS_DIR, newOne));
  });

  it('never throws when the underlying fs calls fail', () => {
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
      throw new Error('disk on fire');
    });
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk still on fire');
    });
    expect(() => writeAlertFile('payload', 'test-aw-throw')).not.toThrow();
  });
});
