/**
 * scripts/png-metadata.mjs (review M2): the brand PNGs carried the author's name in XMP. Stripping
 * removes only the metadata chunks and copies every other chunk byte for byte.
 */
import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JS module outside the package
import { METADATA, chunks, strip, text } from "../../../scripts/png-metadata.mjs";

const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]); // 1x1, 8-bit grey
const idat = deflateSync(Buffer.from([0, 0x7f]));
const xmp = Buffer.concat([Buffer.from("XML:com.adobe.xmp\0\0\0\0\0", "latin1"), Buffer.from("<pdf:Author>A. Person</pdf:Author>")]);
const png = (...meta: Buffer[]) => Buffer.concat([SIG, chunk("IHDR", ihdr), ...meta, chunk("pHYs", Buffer.alloc(9)), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);

describe("PNG metadata", () => {
  it("strips text, Exif and time chunks and keeps every other byte", () => {
    const withMeta = png(
      chunk("tEXt", Buffer.from("Author\0A. Person", "latin1")),
      chunk("zTXt", Buffer.concat([Buffer.from("Comment\0\0", "latin1"), deflateSync(Buffer.from("A. Person"))])),
      chunk("iTXt", xmp),
      chunk("eXIf", Buffer.from("II*\0", "latin1")),
      chunk("tIME", Buffer.from([0x07, 0xea, 10, 6, 18, 16, 59])),
    );
    const meta = chunks(withMeta).filter((c: { type: string }) => METADATA.has(c.type));
    expect(meta.map((c: { type: string }) => c.type)).toEqual(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);
    expect(meta.slice(0, 3).map(text)).toEqual(["Author: A. Person", "Comment: A. Person", "XML:com.adobe.xmp: <pdf:Author>A. Person</pdf:Author>"]);
    const out = strip(withMeta) as Buffer;
    expect(Buffer.compare(out, png())).toBe(0);
    expect(out.includes(Buffer.from("A. Person"))).toBe(false);
    expect(chunks(out).map((c: { type: string }) => c.type)).toEqual(["IHDR", "pHYs", "IDAT", "IEND"]);
  });

  it("refuses a corrupt file rather than rewriting it", () => {
    const bad = png(chunk("tEXt", Buffer.from("k\0v", "latin1")));
    bad[bad.length - 20] ^= 1; // inside a chunk: its CRC no longer matches
    expect(() => strip(bad, "x.png")).toThrow(/bad CRC/);
    expect(() => strip(Buffer.from("GIF89a"), "x.gif")).toThrow(/not a PNG/);
    expect(() => strip(png().subarray(0, 30), "x.png")).toThrow(/truncated|IEND/);
  });
});
