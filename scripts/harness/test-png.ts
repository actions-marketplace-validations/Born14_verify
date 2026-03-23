/**
 * Test PNG Generator — Minimal Valid PNG for Vision Testing
 * ==========================================================
 *
 * Generates valid 8x8 solid-color PNGs programmatically.
 * Used by V-family scenarios and vision-smoke tests.
 * Zero dependencies beyond node:zlib.
 */

import { deflateSync } from 'zlib';

/**
 * Generate a minimal valid PNG with a solid color fill.
 * 8x8 pixel uncompressed PNG — no dependencies needed.
 */
export function makeSolidPNG(r: number, g: number, b: number): Buffer {
  const width = 8, height = 8;

  // Build raw scanlines (filter byte 0 = None, then RGB pixels)
  const rawData: number[] = [];
  for (let y = 0; y < height; y++) {
    rawData.push(0); // filter: None
    for (let x = 0; x < width; x++) {
      rawData.push(r, g, b);
    }
  }

  const compressed = deflateSync(Buffer.from(rawData));

  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // CRC32
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function makeChunk(type: string, data: Buffer): Buffer {
    const typeBytes = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crcInput = Buffer.concat([typeBytes, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(crcInput));
    return Buffer.concat([len, typeBytes, data, crcBuf]);
  }

  // IHDR: width, height, bit depth 8, color type 2 (RGB)
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 2;  // color type: RGB
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace

  const ihdr = makeChunk('IHDR', ihdrData);
  const idat = makeChunk('IDAT', compressed);
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}
