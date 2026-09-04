/**
 * The pure half of the personal-ledger backup: what goes in the envelope, what
 * comes back out of it, and what a restore would actually write.
 *
 * The interesting cases are all about *not* losing something — a field this
 * build does not understand, a record the person deleted on purpose, a file
 * written by a newer app.
 */

import { describe, expect, it } from 'vitest';

import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  backupAad,
  buildBody,
  buildFile,
  parseBody,
  parseFile,
  planRestore,
  BackupFormatError,
  BackupOpenError,
  type SourceRecord,
} from '../src/lib/backup/payload';

const OWNER = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-05T10:00:00.000Z');

function row(id: string, over: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id,
    record_kind: 'txn',
    data: { amount: '1200', currency: 'INR', date: '2026-09-01' },
    created_at: '2026-09-01T00:00:00.000Z',
    deleted_at: null,
    ...over,
  };
}

describe('building a backup body', () => {
  it('keeps every record, in a stable order whatever the mirror gives', () => {
    const a = buildBody(OWNER, [row('c'), row('a'), row('b')], NOW);
    const b = buildBody(OWNER, [row('b'), row('c'), row('a')], NOW);
    expect(a.records.map((record) => record.id)).toEqual(['a', 'b', 'c']);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('carries the data blob through untouched, fields we do not know included', () => {
    const data = { amount: '900', currency: 'INR', somethingFuture: { nested: true } };
    const body = buildBody(OWNER, [row('a', { data })], NOW);
    expect(body.records[0]?.data).toEqual(data);
  });

  it('stamps the owner and the moment', () => {
    const body = buildBody(OWNER, [], NOW);
    expect(body.ownerId).toBe(OWNER);
    expect(body.createdAt).toBe(NOW.toISOString());
  });
});

describe('the envelope', () => {
  it('says almost nothing in the clear — no counts, no dates of spending', () => {
    const body = buildBody(OWNER, [row('a'), row('b')], NOW);
    const file = buildFile('v1:sealed', body.createdAt);
    const text = JSON.stringify(file);
    expect(text).not.toContain(OWNER);
    expect(text).not.toContain('1200');
    expect(text).not.toContain('2026-09-01');
  });

  it('round-trips through parseFile', () => {
    const file = buildFile('v1:sealed', NOW.toISOString());
    expect(parseFile(JSON.stringify(file))).toEqual(file);
  });

  it('rejects a file that is not ours', () => {
    expect(() => parseFile(JSON.stringify({ format: 'something.else', version: 1 }))).toThrow(
      BackupFormatError,
    );
    expect(() => parseFile('not json at all')).toThrow(BackupFormatError);
  });

  it('refuses a version newer than this build rather than guessing at it', () => {
    const future = JSON.stringify({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION + 1,
      alg: 'xchacha20poly1305',
      createdAt: NOW.toISOString(),
      sealed: 'v1:whatever',
    });
    expect(() => parseFile(future)).toThrow(BackupFormatError);
  });

  it('refuses an algorithm it does not implement', () => {
    const wrong = JSON.stringify({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      alg: 'rot13',
      createdAt: NOW.toISOString(),
      sealed: 'v1:whatever',
    });
    expect(() => parseFile(wrong)).toThrow(BackupFormatError);
  });
});

describe('the associated data', () => {
  it('names the format, the version and the owner, so a file cannot be swapped', () => {
    expect(backupAad(OWNER)).toBe(`${BACKUP_FORMAT}:v${BACKUP_VERSION}:${OWNER}`);
    expect(backupAad('other')).not.toBe(backupAad(OWNER));
  });
});

describe('reading a body back', () => {
  it('round-trips', () => {
    const body = buildBody(OWNER, [row('a'), row('b')], NOW);
    expect(parseBody(JSON.stringify(body), OWNER)).toEqual(body);
  });

  it('refuses a body belonging to another account', () => {
    const body = buildBody(OWNER, [row('a')], NOW);
    expect(() => parseBody(JSON.stringify(body), 'somebody-else')).toThrow(BackupOpenError);
  });

  it('drops a malformed record rather than restoring one with no id', () => {
    const body = {
      ownerId: OWNER,
      createdAt: NOW.toISOString(),
      records: [
        { id: '', kind: 'txn', data: {}, createdAt: '', deletedAt: null },
        { id: 'a', kind: '', data: {}, createdAt: '', deletedAt: null },
        { id: 'b', kind: 'txn', data: null, createdAt: '', deletedAt: null },
        { id: 'c', kind: 'txn', data: {}, createdAt: '', deletedAt: null },
      ],
    };
    expect(parseBody(JSON.stringify(body), OWNER).records.map((r) => r.id)).toEqual(['c']);
  });

  it('throws on a body that is not JSON at all', () => {
    expect(() => parseBody('{{', OWNER)).toThrow(BackupOpenError);
  });
});

describe('planning a restore', () => {
  const body = {
    records: [
      { id: 'a', kind: 'txn', data: {}, createdAt: '', deletedAt: null },
      { id: 'b', kind: 'loan', data: {}, createdAt: '', deletedAt: null },
      { id: 'c', kind: 'txn', data: {}, createdAt: '', deletedAt: '2026-09-02T00:00:00.000Z' },
    ],
  };

  it('brings back only what this device is missing', () => {
    const plan = planRestore(new Set(['a']), body);
    expect(plan.restore.map((r) => r.id)).toEqual(['b']);
    expect(plan.alreadyHere).toBe(1);
  });

  it('never resurrects a record deleted on this device', () => {
    // 'b' was deleted here; its id is in localIds even though it is not live.
    const plan = planRestore(new Set(['a', 'b']), body);
    expect(plan.restore).toHaveLength(0);
  });

  it('never re-applies a tombstone from the backup', () => {
    const plan = planRestore(new Set(), body);
    expect(plan.restore.map((r) => r.id)).toEqual(['a', 'b']);
    expect(plan.deleted).toBe(1);
  });

  it('is idempotent: running it against its own result writes nothing more', () => {
    const first = planRestore(new Set(), body);
    const after = new Set(first.restore.map((record) => record.id));
    expect(planRestore(after, body).restore).toHaveLength(0);
  });

  it('restores everything onto a fresh install', () => {
    const plan = planRestore(new Set(), { records: [body.records[0]!, body.records[1]!] });
    expect(plan.restore).toHaveLength(2);
    expect(plan.alreadyHere).toBe(0);
  });
});
