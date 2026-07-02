declare module 'buffer-crc32' {
  /**
   * Compute CRC32C checksum.
   * @param data - Input buffer
   * @returns 4-byte Buffer containing the CRC32C value
   */
  function crc32(data: Buffer): Buffer;

  namespace crc32 {
    /**
     * Compute CRC32C and return as unsigned 32-bit integer.
     */
    function unsigned(data: Buffer): number;

    /**
     * Compute CRC32C and return as signed 32-bit integer.
     */
    function signed(data: Buffer): number;
  }

  export = crc32;
}
