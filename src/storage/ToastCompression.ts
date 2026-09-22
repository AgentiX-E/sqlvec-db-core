/**
 * ToastCompression — TOAST (The Oversized-Attribute Storage Technique) compression.
 *
 * PostgreSQL's TOAST handles large values (>2KB) by compressing them before
 * storage. This module provides:
 *   - LZ4 compression via `lz4-asm`
 *   - Automatic detection of TOAST-eligible columns (TEXT/BYTEA/JSON > 2KB)
 *   - Compression marker for decompression on read
 *
 * Schema convention:
 *   - Compressed values are prefixed with a 1-byte marker: 0x01 = LZ4 compressed
 *   - Uncompressed values pass through unchanged
 *
 * Dependencies:
 *   lz4-asm: npm package for LZ4 compression/decompression
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('ToastCompression');

// ── Constants ────────────────────────────────────────────────────

/** Threshold in bytes: values larger than this are compressed */
export const TOAST_TUPLE_THRESHOLD = 2048; // 2KB

/** Compression marker byte indicating LZ4 compression */
const MARKER_LZ4 = 0x01;

/** Compression marker byte indicating uncompressed data */
const MARKER_RAW = 0x00;

/** Column types eligible for TOAST compression */
export const TOAST_ELIGIBLE_TYPES = new Set(['TEXT', 'BYTEA', 'JSON', 'JSONB', 'VARCHAR', 'CHARACTER VARYING']);

// ── LZ4 Compressor ───────────────────────────────────────────────

/**
 * LZ4 compression/decompression wrapper.
 * Uses `lz4-asm` package if available, with fallback to Buffer-based no-op.
 */
export class Lz4Compressor {
  private lz4: any = null;
  private available: boolean = false;

  /**
   * @param lz4Impl Optional injection point for testing; when omitted the
   *   compressor attempts to load `lz4-asm` dynamically so the hard dependency
   *   can be absent without breaking the module's no-op fallback.
   */
  constructor(lz4Impl?: { compress: (b: Buffer) => Buffer; decompress: (b: Buffer) => Buffer }) {
    try {
      // Dynamic require to avoid hard dependency
      this.lz4 = lz4Impl ?? require('lz4-asm');
      this.available = true;
      logger.info('LZ4 compression available via lz4-asm');
    } catch {
      this.available = false;
      logger.warn('lz4-asm not available; TOAST compression will be a no-op');
    }
  }

  /**
   * Compress a buffer using LZ4.
   */
  compress(input: Buffer): Buffer {
    if (!this.available || input.length < 32) {
      return input;
    }
    try {
      return Buffer.from(this.lz4.compress(input));
    } catch (err: any) {
      logger.warn({ err: err.message }, 'LZ4 compression failed, returning raw');
      return input;
    }
  }

  /**
   * Decompress an LZ4-compressed buffer.
   */
  decompress(input: Buffer): Buffer {
    if (!this.available) {
      return input;
    }
    try {
      return Buffer.from(this.lz4.decompress(input));
    } catch (err: any) {
      logger.warn({ err: err.message }, 'LZ4 decompression failed, returning raw');
      return input;
    }
  }

  /**
   * Check if LZ4 compression is available.
   */
  isAvailable(): boolean {
    return this.available;
  }
}

// Global LZ4 compressor instance
const compressor = new Lz4Compressor();

// ── Public API ───────────────────────────────────────────────────

/**
 * Check if a column type is eligible for TOAST compression.
 */
export function isToastEligible(columnType: string): boolean {
  const upper = columnType.toUpperCase().trim();
  // Handle type modifiers like VARCHAR(255)
  const baseType = upper.replace(/\(.*\)/g, '').trim();
  return TOAST_ELIGIBLE_TYPES.has(baseType);
}

/**
 * Compress a column value if it exceeds the TOAST threshold.
 *
 * @param value - The raw column value (Buffer or string)
 * @param columnType - SQL column type (for eligibility check)
 * @returns { compressed: boolean; buffer: Buffer } - Compression result
 */
export function compressColumn(
  value: Buffer | string | null | undefined,
  columnType: string,
  compressorOverride?: Lz4Compressor,
): { compressed: boolean; buffer: Buffer } {
  const comp = compressorOverride ?? compressor;
  // Handle null/undefined
  if (value === null || value === undefined) {
    return { compressed: false, buffer: Buffer.alloc(0) };
  }

  // Convert string to Buffer if needed
  const inputBuffer = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;

  // Only compress eligible types
  if (!isToastEligible(columnType)) {
    return { compressed: false, buffer: inputBuffer };
  }

  // Skip small values
  if (inputBuffer.length < TOAST_TUPLE_THRESHOLD) {
    return { compressed: false, buffer: inputBuffer };
  }

  // Compress
  const compressed = comp.compress(inputBuffer);

  // Only use compressed if it's actually smaller
  if (compressed.length >= inputBuffer.length) {
    // Not compressible — still prepend the raw marker so a leading 0x01 byte
    // in the payload cannot be mistaken for the LZ4 marker on decompression.
    const result = Buffer.alloc(1 + inputBuffer.length);
    result[0] = MARKER_RAW;
    inputBuffer.copy(result, 1);
    return { compressed: false, buffer: result };
  }

  // Prepend compression marker
  const result = Buffer.alloc(1 + compressed.length);
  result[0] = MARKER_LZ4;
  compressed.copy(result, 1);

  logger.debug(
    { originalSize: inputBuffer.length, compressedSize: compressed.length, ratio: (compressed.length / inputBuffer.length * 100).toFixed(1) + '%' },
    'TOAST: column compressed',
  );

  return { compressed: true, buffer: result };
}

/**
 * Decompress a column value (detects compression marker).
 *
 * @param buffer - The stored buffer (possibly compressed)
 * @returns Decompressed Buffer
 */
export function decompressColumn(
  buffer: Buffer | null | undefined,
  compressorOverride?: Lz4Compressor,
): Buffer {
  const comp = compressorOverride ?? compressor;
  if (!buffer || buffer.length === 0) {
    return Buffer.alloc(0);
  }

  // Check compression markers
  if (buffer[0] === MARKER_LZ4) {
    const compressedData = buffer.subarray(1);
    return comp.decompress(compressedData);
  }
  if (buffer[0] === MARKER_RAW) {
    // Explicitly marked raw — strip the marker byte.
    return buffer.subarray(1);
  }

  // No marker — legacy/unmarked raw data, return as-is
  return buffer;
}

/**
 * Check if a buffer is TOAST-compressed.
 */
export function isToastCompressed(buffer: Buffer): boolean {
  return buffer.length > 0 && buffer[0] === MARKER_LZ4;
}

/**
 * Calculate compression ratio for a value.
 */
export function getCompressionRatio(
  value: Buffer | string,
  columnType: string,
): number {
  const { buffer } = compressColumn(value, columnType);
  const originalSize = typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value.length;

  if (originalSize === 0) return 1.0;
  return buffer.length / originalSize;
}

/**
 * Get the TOAST tuple threshold.
 */
export function getToastThreshold(): number {
  return TOAST_TUPLE_THRESHOLD;
}

/**
 * Get the LZ4 compressor availability.
 */
export function isLz4Available(): boolean {
  return compressor.isAvailable();
}
