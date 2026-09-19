/**
 * Unit tests for WALArchiver.
 *
 * Exercises the archive layout (shard scoping, restore-point subdirectories),
 * idempotent re-archive, atomic copy, and defensive rejection of path
 * traversal via shard/restore-point identifiers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WALArchiver } from '../backup/WALArchiver';

describe('WALArchiver', () => {
  let root: string;
  let srcDir: string;
  let archiver: WALArchiver;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wal-archive-'));
    srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wal-src-'));
    archiver = new WALArchiver({ directory: root });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(srcDir, { recursive: true, force: true });
  });

  it('defaults the archive directory to ./wal_archive', () => {
    const a = new WALArchiver();
    expect(a.archiveDirectory).toBe(path.resolve('wal_archive'));
  });

  it('archives a WAL file into a shard-scoped segment directory', async () => {
    const seed = '000000010000000000000001';
    const src = path.join(srcDir, seed);
    await fs.writeFile(src, 'wal-bytes');

    const result = await archiver.archiveWAL('shard-1', src);

    const expected = path.join(root, 'shard-1', 'segments', seed);
    expect(result.destination).toBe(expected);
    expect(result.existed).toBe(false);
    expect(await fs.readFile(expected, 'utf8')).toBe('wal-bytes');
  });

  it('uses the restore point name as the subdirectory when provided', async () => {
    const src = path.join(srcDir, '000000010000000000000002');
    await fs.writeFile(src, 'x');
    const result = await archiver.archiveWAL('shard-1', src, 'before-upgrade');
    expect(result.destination).toBe(path.join(root, 'shard-1', 'before-upgrade', '000000010000000000000002'));
    expect(await fs.readFile(result.destination, 'utf8')).toBe('x');
  });

  it('is idempotent when the destination already matches', async () => {
    const src = path.join(srcDir, '000000010000000000000003');
    await fs.writeFile(src, 'same-bytes');
    const first = await archiver.archiveWAL('s', src);
    expect(first.existed).toBe(false);

    const second = await archiver.archiveWAL('s', src);
    expect(second.existed).toBe(true);
    expect(second.destination).toBe(first.destination);
  });

  it('re-archives when the destination size differs', async () => {
    const src = path.join(srcDir, '000000010000000000000004');
    await fs.writeFile(src, 'v1-short');
    const first = await archiver.archiveWAL('s', src);

    // Overwrite the source with different-sized content.
    await fs.writeFile(src, 'v2-a-bit-longer-content');
    const second = await archiver.archiveWAL('s', src);

    expect(second.existed).toBe(false);
    expect(await fs.readFile(second.destination, 'utf8')).toBe('v2-a-bit-longer-content');
    expect(first.destination).toBe(second.destination);
  });

  it('rejects a missing source file', async () => {
    await expect(archiver.archiveWAL('s', path.join(srcDir, 'does-not-exist'))).rejects.toThrow(
      /does not exist/,
    );
  });

  it('rejects an empty shard identifier', async () => {
    const src = path.join(srcDir, '000000010000000000000005');
    await fs.writeFile(src, 'x');
    await expect(archiver.archiveWAL('', src)).rejects.toThrow(/shard/i);
  });

  it('rejects a shard identifier containing a path separator', async () => {
    const src = path.join(srcDir, '000000010000000000000006');
    await fs.writeFile(src, 'x');
    await expect(archiver.archiveWAL('../evil', src)).rejects.toThrow(/shard/i);
  });

  it('rejects a restore point containing a path separator', async () => {
    const src = path.join(srcDir, '000000010000000000000007');
    await fs.writeFile(src, 'x');
    await expect(archiver.archiveWAL('s', src, '../escape')).rejects.toThrow(/restore point/i);
  });

  it('rejects a WAL path with no basename', async () => {
    await expect(archiver.archiveWAL('s', '/')).rejects.toThrow(/invalid wal path/i);
  });
});

describe('WALArchiver — copy failure cleanup', () => {
  let root: string;
  let srcDir: string;
  let archiver: WALArchiver;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wal-archive-fail-'));
    srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wal-src-fail-'));
    archiver = new WALArchiver({ directory: root });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(srcDir, { recursive: true, force: true });
  });

  it('cleans up the temporary file and rethrows when copy fails', async () => {
    const seed = '000000010000000000000099';
    const src = path.join(srcDir, seed);
    await fs.writeFile(src, 'data-to-archive');

    const spy = vi.spyOn(fs, 'copyFile').mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(archiver.archiveWAL('shard-1', src)).rejects.toThrow('disk full');
    } finally {
      spy.mockRestore();
    }

    // The destination must not exist, and no stray temp file remains.
    const entries = await fs.readdir(path.join(root, 'shard-1', 'segments')).catch(() => []);
    expect(entries).toEqual([]);
  });
});
