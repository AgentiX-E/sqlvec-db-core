import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LargeObjectManager } from '../storage/LargeObjectManager';

const INV_READ = 0x20000;
const INV_WRITE = 0x40000;

describe('LargeObjectManager', () => {
  let basePath: string;
  let loom: LargeObjectManager;

  beforeEach(() => {
    basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-test-'));
    loom = new LargeObjectManager(basePath);
  });

  afterEach(() => {
    try {
      loom.closeAll();
    } catch {
      /* already closed */
    }
    fs.rmSync(basePath, { recursive: true, force: true });
  });

  it('creates the large_objects.db file and __large_objects table on init', () => {
    expect(fs.existsSync(path.join(basePath, 'large_objects.db'))).toBe(true);
  });

  describe('create', () => {
    it('auto-assigns OID 1 for the first object', () => {
      expect(loom.create()).toBe(1);
    });

    it('auto-assigns the next OID after an existing object', () => {
      expect(loom.create()).toBe(1);
      expect(loom.create()).toBe(2);
      expect(loom.create()).toBe(3);
    });

    it('creates a specific OID when requested', () => {
      expect(loom.create(42)).toBe(42);
      expect(loom.exists(42)).toBe(true);
    });

    it('throws when the requested OID already exists', () => {
      loom.create(7);
      expect(() => loom.create(7)).toThrow('already exists');
    });

    it('auto-assigns an OID higher than every existing one', () => {
      loom.create(100);
      expect(loom.create()).toBe(101);
    });
  });

  describe('open / read / seek', () => {
    it('throws when opening a non-existent OID', () => {
      expect(() => loom.open(999, INV_READ)).toThrow('does not exist');
    });

    it('reads data from the current position', () => {
      const oid = loom.create();
      const fd = loom.open(oid, INV_READ | INV_WRITE);
      loom.write(fd, Buffer.from('hello world'));
      loom.close(fd); // flush to database before re-reading

      const fd2 = loom.open(oid, INV_READ);
      expect(loom.read(fd2, 5).toString()).toBe('hello');
      expect(loom.read(fd2, 6).toString()).toBe(' world');
      loom.close(fd2);
    });

    it('returns a shorter buffer at EOF', () => {
      const oid = loom.create();
      const fd = loom.open(oid, INV_WRITE);
      loom.write(fd, Buffer.from('abc'));
      loom.seek(fd, 0, 0);
      loom.close(fd);

      const rfd = loom.open(oid, INV_READ);
      loom.seek(rfd, 2, 0);
      expect(loom.read(rfd, 100).toString()).toBe('c');
      loom.close(rfd);
    });

    it('does not regress position when reading past EOF', () => {
      const oid = loom.create();
      const fd = loom.open(oid, INV_WRITE);
      loom.write(fd, Buffer.from('abc'));
      loom.close(fd);

      const rfd = loom.open(oid, INV_READ);
      loom.seek(rfd, 10, 0); // past EOF
      expect(loom.read(rfd, 5).length).toBe(0);
      // position must remain at 10, not regress to data.length (3)
      expect(loom.seek(rfd, 0, 1)).toBe(10);
      loom.close(rfd);
    });

    it('throws for an invalid descriptor', () => {
      expect(() => loom.read(999, 10)).toThrow('invalid large object descriptor');
      expect(() => loom.seek(999, 0, 0)).toThrow('invalid large object descriptor');
      expect(() => loom.write(999, Buffer.from('x'))).toThrow('invalid large object descriptor');
      expect(() => loom.close(999)).toThrow('invalid large object descriptor');
      expect(() => loom.truncate(999, 0)).toThrow('invalid large object descriptor');
    });

    it('supports SEEK_CUR and SEEK_END seek modes', () => {
      const oid = loom.create();
      const fd = loom.open(oid, INV_WRITE);
      loom.write(fd, Buffer.from('abcdef'));
      loom.close(fd);

      const rfd = loom.open(oid, INV_READ);
      expect(loom.seek(rfd, 1, 0)).toBe(1);
      expect(loom.seek(rfd, 2, 1)).toBe(3); // SEEK_CUR
      expect(loom.seek(rfd, -1, 2)).toBe(5); // SEEK_END
      loom.close(rfd);
    });

    it('throws for an invalid whence', () => {
      const oid = loom.create();
      const fd = loom.open(oid, INV_READ);
      expect(() => loom.seek(fd, 0, 99)).toThrow('invalid whence');
      loom.close(fd);
    });

    it('throws for a negative seek position', () => {
      const oid = loom.create();
      const fd = loom.open(oid, INV_READ);
      expect(() => loom.seek(fd, -5, 0)).toThrow('negative seek position');
      loom.close(fd);
    });
  });

  describe('write', () => {
    it('throws when writing to a read-only descriptor', () => {
      const oid = loom.create();
      const fd = loom.open(oid, INV_READ);
      expect(() => loom.write(fd, Buffer.from('x'))).toThrow('not opened for write');
      loom.close(fd);
    });

    it('overwrites and extends data in place', () => {
      const oid = loom.create();
      const fd = loom.open(oid, INV_WRITE);
      loom.write(fd, Buffer.from('hello'));
      expect(loom.write(fd, Buffer.from(' world'))).toBe(6);
      expect(loom.seek(fd, 0, 0)).toBe(0);
      loom.close(fd);

      const rfd = loom.open(oid, INV_READ);
      expect(loom.read(rfd, 20).toString()).toBe('hello world');
      loom.close(rfd);
    });

    it('extends the buffer with zero-padding when writing past the end', () => {
      const oid = loom.create();
      const fd = loom.open(oid, INV_WRITE);
      loom.write(fd, Buffer.from('ab'));
      loom.seek(fd, 5, 0);
      loom.write(fd, Buffer.from('XY'));
      loom.close(fd);

      const rfd = loom.open(oid, INV_READ);
      expect(loom.read(rfd, 20).toString()).toBe('ab\u0000\u0000\u0000XY');
      loom.close(rfd);
    });
  });

  describe('truncate', () => {
    it('shrinks data when len < current size', () => {
      const oid = loom.create();
      const fd = loom.open(oid, INV_WRITE);
      loom.write(fd, Buffer.from('hello world'));
      loom.truncate(fd, 5);
      loom.close(fd);

      const rfd = loom.open(oid, INV_READ);
      expect(loom.read(rfd, 20).toString()).toBe('hello');
      loom.close(rfd);
    });

    it('extends data with zeros when len > current size', () => {
      const oid = loom.create();
      const fd = loom.open(oid, INV_WRITE);
      loom.write(fd, Buffer.from('ab'));
      loom.truncate(fd, 5);
      loom.close(fd);

      const rfd = loom.open(oid, INV_READ);
      expect(loom.read(rfd, 20).toString()).toBe('ab\u0000\u0000\u0000');
      loom.close(rfd);
    });

    it('resets position when it exceeds the new length', () => {
      const oid = loom.create();
      const fd = loom.open(oid, INV_WRITE);
      loom.write(fd, Buffer.from('hello world'));
      loom.seek(fd, 20, 0);
      loom.truncate(fd, 3);
      expect(loom.seek(fd, 0, 1)).toBe(3);
      loom.close(fd);
    });
  });

  describe('unlink / exists / size', () => {
    it('unlinks an object and closes its open FDs', () => {
      const oid = loom.create();
      const fd = loom.open(oid, INV_READ);
      loom.unlink(oid);
      expect(loom.exists(oid)).toBe(false);
      // FD is now invalid
      expect(() => loom.read(fd, 1)).toThrow('invalid large object descriptor');
    });

    it('throws when unlinking a non-existent OID', () => {
      expect(() => loom.unlink(999)).toThrow('does not exist');
    });

    it('reports size, defaulting to 0 for unknown OIDs', () => {
      expect(loom.size(999)).toBe(0);
      const oid = loom.create();
      const fd = loom.open(oid, INV_WRITE);
      loom.write(fd, Buffer.from('12345'));
      loom.close(fd);
      expect(loom.size(oid)).toBe(5);
    });
  });

  describe('export / import', () => {
    it('exports an object to a file', () => {
      const oid = loom.create();
      const fd = loom.open(oid, INV_WRITE);
      loom.write(fd, Buffer.from('export me'));
      loom.close(fd);

      const target = path.join(basePath, 'exported.bin');
      loom.export(oid, target);
      expect(fs.readFileSync(target, 'utf8')).toBe('export me');
    });

    it('throws when exporting a non-existent OID', () => {
      expect(() => loom.export(999, path.join(basePath, 'x.bin'))).toThrow('does not exist');
    });

    it('imports a file as a new large object', () => {
      const src = path.join(basePath, 'source.txt');
      fs.writeFileSync(src, 'file contents here');
      const oid = loom.import(src);
      expect(loom.size(oid)).toBe('file contents here'.length);

      const fd = loom.open(oid, INV_READ);
      expect(loom.read(fd, 100).toString()).toBe('file contents here');
      loom.close(fd);
    });
  });

  describe('closeAll', () => {
    it('flushes and closes the database', () => {
      const oid = loom.create();
      const fd = loom.open(oid, INV_WRITE);
      loom.write(fd, Buffer.from('persisted'));
      loom.closeAll();

      // Re-open the manager on the same path to verify persistence.
      const loom2 = new LargeObjectManager(basePath);
      expect(loom2.size(oid)).toBe('persisted'.length);
      loom2.closeAll();
    });
  });

  it('writes in-place without extending when the buffer fits', () => {
    const oid = loom.create();
    const fd = loom.open(oid, INV_WRITE);
    loom.write(fd, Buffer.from('hello'));
    loom.seek(fd, 1, 0);
    loom.write(fd, Buffer.from('XY')); // overwrite 'el' with 'XY' in place
    loom.close(fd);

    const rfd = loom.open(oid, INV_READ);
    expect(loom.read(rfd, 20).toString()).toBe('hXYlo');
    loom.close(rfd);
  });

  it('retains the oid→fd mapping until the last fd on that oid is closed', () => {
    const oid = loom.create();
    const fd1 = loom.open(oid, INV_READ);
    const fd2 = loom.open(oid, INV_READ);
    loom.close(fd1); // fdSet.size 2 -> 1, mapping retained
    // fd2 still valid
    expect(loom.read(fd2, 0).length).toBe(0);
    loom.close(fd2);
  });

  it('creates the base directory when it does not exist', () => {
    const nested = path.join(os.tmpdir(), 'lo-nested-' + Date.now(), 'sub', 'dir');
    const m = new LargeObjectManager(nested);
    expect(fs.existsSync(path.join(nested, 'large_objects.db'))).toBe(true);
    m.closeAll();
    fs.rmSync(path.join(os.tmpdir(), 'lo-nested-' + Date.now()), { recursive: true, force: true });
  });
});
