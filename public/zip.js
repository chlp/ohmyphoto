/**
 * Minimal streaming ZIP writer for the gallery's client-side "download all as ZIP".
 *
 * Method STORE (JPEGs do not compress), general-purpose flag bits 3 (data descriptor, so files
 * stream without knowing their size up front) and 11 (UTF-8 names), DOS timestamps, central
 * directory + EOCD. No ZIP64: the server-side gate (src/utils/albumZip.js) keeps archives under
 * 4 GiB and 65535 entries. No dependencies and no WebAssembly, so the CSP stays unchanged.
 *
 * Plain ES module so it can be unit-tested outside the browser (test/zip.test.js).
 */

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Incremental CRC-32 (IEEE): start with 0, feed chunks, use the last return value. */
export function crc32Update(crc, bytes) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

/**
 * @param {{ write: (bytes: Uint8Array) => (void|Promise<void>) }} sink
 * @param {{ now?: () => Date }} [opts]
 */
export function createZipWriter(sink, { now = () => new Date() } = {}) {
  const textEncoder = new TextEncoder();
  const central = [];
  let offset = 0;
  let current = null;

  const write = async (bytes) => {
    await sink.write(bytes);
    offset += bytes.length;
  };

  const u16 = (view, pos, v) => view.setUint16(pos, v & 0xffff, true);
  const u32 = (view, pos, v) => view.setUint32(pos, v >>> 0, true);

  return {
    async beginFile(name) {
      if (current) throw new Error('zip: previous file not finished');
      const nameBytes = textEncoder.encode(name);
      const { time, date } = dosDateTime(now());
      const header = new Uint8Array(30 + nameBytes.length);
      const v = new DataView(header.buffer);
      u32(v, 0, 0x04034b50); // local file header signature
      u16(v, 4, 20);         // version needed to extract (2.0)
      u16(v, 6, 0x0808);     // flags: data descriptor + UTF-8 names
      u16(v, 8, 0);          // method: STORE
      u16(v, 10, time);
      u16(v, 12, date);
      u32(v, 14, 0);         // crc-32 (in data descriptor)
      u32(v, 18, 0);         // compressed size (in data descriptor)
      u32(v, 22, 0);         // uncompressed size (in data descriptor)
      u16(v, 26, nameBytes.length);
      u16(v, 28, 0);         // extra field length
      header.set(nameBytes, 30);
      current = { nameBytes, time, date, headerOffset: offset, crc: 0, size: 0 };
      await write(header);
    },
    async writeChunk(chunk) {
      if (!current) throw new Error('zip: no open file');
      current.crc = crc32Update(current.crc, chunk);
      current.size += chunk.length;
      await write(chunk);
    },
    async endFile() {
      if (!current) throw new Error('zip: no open file');
      const dd = new Uint8Array(16);
      const v = new DataView(dd.buffer);
      u32(v, 0, 0x08074b50); // data descriptor signature
      u32(v, 4, current.crc);
      u32(v, 8, current.size);
      u32(v, 12, current.size);
      await write(dd);
      central.push(current);
      current = null;
    },
    /** Writes the central directory + EOCD; returns the total archive size in bytes. */
    async finish() {
      if (current) throw new Error('zip: file still open');
      const cdOffset = offset;
      for (const e of central) {
        const rec = new Uint8Array(46 + e.nameBytes.length);
        const v = new DataView(rec.buffer);
        u32(v, 0, 0x02014b50); // central directory header signature
        u16(v, 4, 20);         // version made by
        u16(v, 6, 20);         // version needed
        u16(v, 8, 0x0808);     // flags
        u16(v, 10, 0);         // method
        u16(v, 12, e.time);
        u16(v, 14, e.date);
        u32(v, 16, e.crc);
        u32(v, 20, e.size);
        u32(v, 24, e.size);
        u16(v, 28, e.nameBytes.length);
        u16(v, 30, 0);         // extra length
        u16(v, 32, 0);         // comment length
        u16(v, 34, 0);         // disk number start
        u16(v, 36, 0);         // internal attributes
        u32(v, 38, 0);         // external attributes
        u32(v, 42, e.headerOffset);
        rec.set(e.nameBytes, 46);
        await write(rec);
      }
      const cdSize = offset - cdOffset;
      const eocd = new Uint8Array(22);
      const v = new DataView(eocd.buffer);
      u32(v, 0, 0x06054b50); // end of central directory signature
      u16(v, 4, 0);
      u16(v, 6, 0);
      u16(v, 8, central.length);
      u16(v, 10, central.length);
      u32(v, 12, cdSize);
      u32(v, 16, cdOffset);
      u16(v, 20, 0);
      await write(eocd);
      return offset;
    }
  };
}
