import { deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * Just enough ZIP for theme files: "Download theme file" writes one, "Upload
 * theme" reads one. Deflate or stored entries, no encryption, no ZIP64 —
 * a theme is a few hundred small text files, far inside those limits.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(date: Date): { time: number; day: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function createZip(files: { path: string; data: Buffer }[], modified = new Date()): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const { time, day } = dosTime(modified);
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8');
    const compressed = deflateRawSync(file.data);
    const useDeflate = compressed.length < file.data.length;
    const body = useDeflate ? compressed : file.data;
    const crc = crc32(file.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

export class ZipError extends Error {}

/** Reads every file entry. Limits guard against zip bombs. */
export function readZip(zip: Buffer, limits = { maxFiles: 1000, maxTotalBytes: 50 * 1024 * 1024 }): { path: string; data: Buffer }[] {
  let endOffset = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      endOffset = i;
      break;
    }
  }
  if (endOffset < 0) throw new ZipError('This is not a zip file.');
  const count = zip.readUInt16LE(endOffset + 10);
  let pointer = zip.readUInt32LE(endOffset + 16);
  if (count > limits.maxFiles) throw new ZipError(`The zip has more than ${limits.maxFiles} files.`);
  const out: { path: string; data: Buffer }[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(pointer) !== 0x02014b50) throw new ZipError('The zip file is damaged.');
    const method = zip.readUInt16LE(pointer + 10);
    const compressedSize = zip.readUInt32LE(pointer + 20);
    const size = zip.readUInt32LE(pointer + 24);
    const nameLength = zip.readUInt16LE(pointer + 28);
    const extraLength = zip.readUInt16LE(pointer + 30);
    const commentLength = zip.readUInt16LE(pointer + 32);
    const localOffset = zip.readUInt32LE(pointer + 42);
    const path = zip.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');
    pointer += 46 + nameLength + extraLength + commentLength;
    if (path.endsWith('/')) continue;
    total += size;
    if (total > limits.maxTotalBytes) throw new ZipError('The zip is too large once unpacked.');
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const body = zip.subarray(start, start + compressedSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = inflateRawSync(body, { maxOutputLength: Math.max(size, 1) });
    else throw new ZipError(`${path} uses a compression method this upload does not support.`);
    out.push({ path, data });
  }
  return out;
}
