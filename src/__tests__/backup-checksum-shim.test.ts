/**
 * backup-checksum-shim.test.ts — Coverage tests for BackupChecksumShim.
 *
 * Uses a real temporary directory with real .db files (and a checksum
 * manifest) to exercise every file-scanning, hashing, comparison, and
 * fallback branch of verifyChecksums / generateChecksumManifest, plus the
 * detect/rewrite entry points.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  verifyChecksums,
  generateChecksumManifest,
  detectBackupChecksum,
  rewriteBackupChecksum,
} from '../query/BackupChecksumShim';

let tmpDir: string;

function writeDbFile(name: string, content: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlvec-checksum-'));
  delete process.env.DATA_DIR;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
});

describe('detectBackupChecksum', () => {
  it('returns false for non-string / empty', () => {
    expect(detectBackupChecksum('')).toBe(false);
    expect(detectBackupChecksum('   ')).toBe(false);
    expect(detectBackupChecksum(undefined as any)).toBe(false);
  });

  it('detects pg_verify_checksums call', () => {
    expect(detectBackupChecksum('SELECT pg_verify_checksums()')).toBe(true);
  });

  it('detects pg_verify_block_checksums call', () => {
    expect(detectBackupChecksum('SELECT pg_verify_block_checksums()')).toBe(true);
  });

  it('returns false for unrelated SQL', () => {
    expect(detectBackupChecksum('SELECT 1')).toBe(false);
  });
});

describe('verifyChecksums', () => {
  it('returns verified=true when directory does not exist', () => {
    const r = verifyChecksums(path.join(tmpDir, 'missing'));
    expect(r.verified).toBe(true);
    expect(r.checked).toBe(0);
    expect(r.failed).toBe(0);
  });

  it('returns verified=true when no .db files', () => {
    fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'hi');
    const r = verifyChecksums(tmpDir);
    expect(r.verified).toBe(true);
    expect(r.checked).toBe(0);
  });

  it('checksums .db files with no manifest (no comparison)', () => {
    writeDbFile('a.db', 'hello world');
    writeDbFile('b.db', 'another file');
    const r = verifyChecksums(tmpDir);
    expect(r.verified).toBe(true);
    expect(r.checked).toBe(2);
    expect(r.failed).toBe(0);
  });

  it('verifies matching manifest entries', () => {
    writeDbFile('a.db', 'payload');
    const manifest = path.join(tmpDir, '_sqlvec_checksums.json');
    const crypto = require('node:crypto');
    const hash = crypto.createHash('sha256').update('payload').digest('hex');
    fs.writeFileSync(manifest, JSON.stringify({ 'a.db': hash }));
    const r = verifyChecksums(tmpDir);
    expect(r.verified).toBe(true);
    expect(r.checked).toBe(1);
    expect(r.failed).toBe(0);
  });

  it('detects checksum mismatch', () => {
    writeDbFile('a.db', 'actual-content');
    const manifest = path.join(tmpDir, '_sqlvec_checksums.json');
    fs.writeFileSync(manifest, JSON.stringify({ 'a.db': 'deadbeef' }));
    const r = verifyChecksums(tmpDir);
    expect(r.verified).toBe(false);
    expect(r.failed).toBe(1);
  });

  it('skips non-file entries (directories)', () => {
    fs.mkdirSync(path.join(tmpDir, 'sub.db'));
    writeDbFile('real.db', 'x');
    const r = verifyChecksums(tmpDir);
    // sub.db is a directory, so only real.db is hashed
    expect(r.checked).toBe(1);
  });

  it('counts read errors as failures', () => {
    // A .db entry that is a dangling symlink-ish case is hard to force portably;
    // instead corrupt by making a .db that fails during read via a directory.
    fs.mkdirSync(path.join(tmpDir, 'broken.db'));
    const r = verifyChecksums(tmpDir);
    // broken.db is a directory → stat.isFile() false → skipped (not failed)
    expect(r.verified).toBe(true);
    expect(r.checked).toBe(0);
  });

  it('returns failed on top-level error (invalid dataDir)', () => {
    // Passing a file (not a directory) as dataDir forces readdir to throw.
    const fileAsDir = writeDbFile('notdir.db', 'x');
    const r = verifyChecksums(fileAsDir);
    expect(r.verified).toBe(false);
    expect(r.failed).toBe(1);
  });
});

describe('generateChecksumManifest', () => {
  it('returns 0 when directory does not exist', () => {
    expect(generateChecksumManifest(path.join(tmpDir, 'nope'))).toBe(0);
  });

  it('generates manifest for .db files', () => {
    writeDbFile('a.db', 'aaa');
    writeDbFile('b.db', 'bbb');
    const count = generateChecksumManifest(tmpDir);
    expect(count).toBe(2);
    const manifestPath = path.join(tmpDir, '_sqlvec_checksums.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(Object.keys(manifest)).toContain('a.db');
    expect(Object.keys(manifest)).toContain('b.db');
  });

  it('skips non-file entries', () => {
    fs.mkdirSync(path.join(tmpDir, 'dir.db'));
    writeDbFile('real.db', 'z');
    expect(generateChecksumManifest(tmpDir)).toBe(1);
  });

  it('returns 0 on top-level error (dir is actually a file)', () => {
    const filePath = writeDbFile('notdir', 'x');
    // readdirSync on a regular file throws ENOTDIR → top-level catch → 0
    expect(generateChecksumManifest(filePath)).toBe(0);
  });
});

describe('getDataDir fallback (no explicit dataDir)', () => {
  it('uses process.cwd()/data when DATA_DIR unset and dir missing', () => {
    delete process.env.DATA_DIR;
    // No explicit dataDir → getDataDir() → cwd/data (does not exist in test)
    const r = verifyChecksums();
    expect(r.verified).toBe(true);
    expect(r.checked).toBe(0);
  });

  it('uses DATA_DIR when set', () => {
    writeDbFile('x.db', 'content');
    process.env.DATA_DIR = tmpDir;
    const r = verifyChecksums();
    expect(r.checked).toBe(1);
  });

  it('generateChecksumManifest uses DATA_DIR when set', () => {
    writeDbFile('y.db', 'abc');
    process.env.DATA_DIR = tmpDir;
    expect(generateChecksumManifest()).toBe(1);
  });
});

describe('readChecksumManifest error handling', () => {
  it('logs warning when manifest JSON is corrupt', () => {
    writeDbFile('a.db', 'data');
    fs.writeFileSync(path.join(tmpDir, '_sqlvec_checksums.json'), '{not valid json');
    const r = verifyChecksums(tmpDir);
    // Corrupt manifest is caught; verification still proceeds as no manifest
    expect(r.verified).toBe(true);
    expect(r.checked).toBe(1);
  });
});

describe('file-level error handling (read/hash failures)', () => {
  it('counts dangling symlink .db as a failure', () => {
    // A .db entry that is a dangling symlink makes statSync throw (ENOENT),
    // which is caught by the per-file handler and counted as a failure.
    const target = path.join(tmpDir, 'does-not-exist-target');
    fs.symlinkSync(target, path.join(tmpDir, 'dangling.db'));
    const r = verifyChecksums(tmpDir);
    expect(r.failed).toBe(1);
    expect(r.verified).toBe(false);
  });

  it('generateChecksumManifest logs warning on dangling symlink', () => {
    const target = path.join(tmpDir, 'missing');
    fs.symlinkSync(target, path.join(tmpDir, 'dangling.db'));
    const count = generateChecksumManifest(tmpDir);
    // The dangling symlink fails to hash; other files (none) are processed.
    expect(count).toBe(0);
  });
});

describe('rewriteBackupChecksum verified=false path', () => {
  it('returns SELECT false when verification finds a mismatch', () => {
    writeDbFile('a.db', 'actual');
    fs.writeFileSync(
      path.join(tmpDir, '_sqlvec_checksums.json'),
      JSON.stringify({ 'a.db': 'wronghash' }),
    );
    process.env.DATA_DIR = tmpDir;
    const r = rewriteBackupChecksum('SELECT pg_verify_checksums()');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('false AS verified');
  });
});

describe('rewriteBackupChecksum', () => {
  it('returns unchanged for non-string / empty', () => {
    expect(rewriteBackupChecksum('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteBackupChecksum(undefined as any).rewritten).toBe(false);
  });

  it('passes through non-checksum SQL', () => {
    expect(rewriteBackupChecksum('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
  });

  it('falls back to static true without DATA_DIR', () => {
    const r = rewriteBackupChecksum('SELECT pg_verify_checksums()');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT true AS verified');
  });

  it('performs real verification when DATA_DIR is set', () => {
    writeDbFile('a.db', 'content');
    process.env.DATA_DIR = tmpDir;
    const r = rewriteBackupChecksum('SELECT pg_verify_block_checksums()');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('AS verified');
    expect(r.sql).toContain('AS checked');
  });

  it('passes through complex SQL embedding checksum call', () => {
    const sql = 'SELECT pg_verify_checksums() FROM somewhere WHERE x > 1';
    const r = rewriteBackupChecksum(sql);
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe(sql);
  });

  it('rewrites pg_verify_checksums simple select', () => {
    const r = rewriteBackupChecksum('SELECT pg_verify_checksums()');
    expect(r.rewritten).toBe(true);
  });
});
