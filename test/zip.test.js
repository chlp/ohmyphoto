import { describe, expect, it } from "vitest";
import { crc32Update, createZipWriter, dosDateTime } from "../public/zip.js";

const enc = new TextEncoder();

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Tiny reader for the structures the writer emits (local headers + data descriptors, CD, EOCD). */
function parseZip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (p) => v.getUint16(p, true);
  const u32 = (p) => v.getUint32(p, true);
  const eocdPos = bytes.length - 22;
  expect(u32(eocdPos)).toBe(0x06054b50);
  const entries = u16(eocdPos + 10);
  const cdSize = u32(eocdPos + 12);
  const cdOffset = u32(eocdPos + 16);
  expect(cdOffset + cdSize).toBe(eocdPos);
  const files = [];
  let p = cdOffset;
  for (let i = 0; i < entries; i++) {
    expect(u32(p)).toBe(0x02014b50);
    const flags = u16(p + 8);
    const crc = u32(p + 16);
    const size = u32(p + 24);
    const nameLen = u16(p + 28);
    const localOffset = u32(p + 42);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // local header for this entry
    expect(u32(localOffset)).toBe(0x04034b50);
    expect(u16(localOffset + 6)).toBe(0x0808);
    expect(u16(localOffset + 8)).toBe(0); // STORE
    const localNameLen = u16(localOffset + 26);
    const dataStart = localOffset + 30 + localNameLen;
    const data = bytes.subarray(dataStart, dataStart + size);
    // data descriptor follows the data
    expect(u32(dataStart + size)).toBe(0x08074b50);
    expect(u32(dataStart + size + 4)).toBe(crc);
    expect(u32(dataStart + size + 8)).toBe(size);
    files.push({ name, crc, size, flags, data });
    p += 46 + nameLen;
  }
  return files;
}

describe("crc32Update", () => {
  it("matches the IEEE CRC-32 test vectors, incrementally", () => {
    expect(crc32Update(0, enc.encode(""))).toBe(0);
    expect(crc32Update(0, enc.encode("123456789"))).toBe(0xcbf43926);
    expect(crc32Update(0, enc.encode("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
    const partial = crc32Update(crc32Update(0, enc.encode("12345")), enc.encode("6789"));
    expect(partial).toBe(0xcbf43926);
  });
});

describe("dosDateTime", () => {
  it("packs date and time in MS-DOS format and clamps years before 1980", () => {
    const d = new Date(2025, 5, 1, 13, 45, 30); // local time
    const { time, date } = dosDateTime(d);
    expect(date).toBe(((2025 - 1980) << 9) | (6 << 5) | 1);
    expect(time).toBe((13 << 11) | (45 << 5) | 15);
    expect(dosDateTime(new Date(1970, 0, 1)).date >> 9).toBe(0);
  });
});

describe("createZipWriter", () => {
  it("streams STORE entries with data descriptors and a valid central directory", async () => {
    const parts = [];
    const zip = createZipWriter({ write: (b) => { parts.push(b.slice()); } }, { now: () => new Date(2025, 0, 2, 3, 4, 6) });
    await zip.beginFile("a.jpg");
    await zip.writeChunk(enc.encode("1234"));
    await zip.writeChunk(enc.encode("56789"));
    await zip.endFile();
    await zip.beginFile("sub dir/b.jpg");
    await zip.endFile(); // empty file
    const total = await zip.finish();
    const bytes = concat(parts);
    expect(bytes.length).toBe(total);

    const files = parseZip(bytes);
    expect(files.map((f) => [f.name, f.size, f.crc])).toEqual([["a.jpg", 9, 0xcbf43926], ["sub dir/b.jpg", 0, 0]]);
    expect(new TextDecoder().decode(files[0].data)).toBe("123456789");
  });

  it("refuses out-of-order calls", async () => {
    const zip = createZipWriter({ write: () => {} });
    await expect(zip.writeChunk(new Uint8Array(1))).rejects.toThrow(/no open file/);
    await expect(zip.endFile()).rejects.toThrow(/no open file/);
    await zip.beginFile("x.jpg");
    await expect(zip.beginFile("y.jpg")).rejects.toThrow(/not finished/);
    await expect(zip.finish()).rejects.toThrow(/still open/);
  });
});
