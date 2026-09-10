const fs = require('fs');
const { inflateSync, zipSync } = require('fflate');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 0xffff + 22;

let crcTable;

function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    crcTable[n] = value >>> 0;
  }
  return crcTable;
}

function crc32(buffer) {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function asBuffer(source) {
  return Buffer.isBuffer(source) ? source : fs.readFileSync(source);
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - MAX_EOCD_SEARCH);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error('ZIP end-of-central-directory record is missing');
}

function decodeName(bytes, flags) {
  return bytes.toString((flags & 0x0800) !== 0 ? 'utf8' : 'latin1');
}

function readZipEntries(source, limits = {}) {
  const buffer = asBuffer(source);
  const eocd = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error('Multi-disk ZIP archives are not supported');
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported');
  }
  if (centralOffset + centralSize > eocd || centralOffset < 0) {
    throw new Error('ZIP central directory is invalid');
  }
  const maxEntries = Number(limits.maxEntries ?? 10000);
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || entryCount > maxEntries) {
    const error = new Error('ZIP entry count exceeds the configured limit');
    error.code = 'ZIP_TOO_MANY_ENTRIES';
    throw error;
  }

  const maxEntryBytes = Number(limits.maxEntryBytes ?? 1024 * 1024 * 1024);
  const maxTotalBytes = Number(limits.maxTotalBytes ?? 1024 * 1024 * 1024);
  let offset = centralOffset;
  let totalBytes = 0;
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error('ZIP central directory entry is invalid');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const compression = buffer.readUInt16LE(offset + 10);
    const expectedCrc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > eocd) throw new Error('ZIP central directory entry is truncated');
    const entryName = decodeName(buffer.subarray(offset + 46, offset + 46 + nameLength), flags);
    const isDirectory = entryName.endsWith('/');
    if (!isDirectory) {
      totalBytes += size;
      if (size > maxEntryBytes) {
        const error = new Error('ZIP entry exceeds the configured limit');
        error.code = 'ZIP_ENTRY_TOO_LARGE';
        throw error;
      }
      if (totalBytes > maxTotalBytes) {
        const error = new Error('ZIP expanded size exceeds the configured limit');
        error.code = 'ZIP_EXPANDED_TOO_LARGE';
        throw error;
      }
    }
    entries.push({
      entryName,
      isDirectory,
      header: { size, compressedSize, offset: localOffset },
      getData() {
        if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
          throw new Error('ZIP local entry is invalid');
        }
        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
        if (dataOffset + compressedSize > centralOffset) throw new Error('ZIP entry data is truncated');
        const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
        let data;
        if (compression === 0) data = Buffer.from(compressed);
        else if (compression === 8) data = Buffer.from(inflateSync(compressed));
        else throw new Error(`Unsupported ZIP compression method: ${compression}`);
        if (data.length !== size) throw new Error('ZIP entry size mismatch');
        if (crc32(data) !== expectedCrc) throw new Error('ZIP entry CRC mismatch');
        return data;
      },
    });
    offset = nextOffset;
  }
  if (offset !== centralOffset + centralSize) throw new Error('ZIP central directory size mismatch');
  return entries;
}

function createZipBuffer(entries, options = {}) {
  const files = Object.create(null);
  for (const [name, value] of entries) files[name] = new Uint8Array(value);
  return Buffer.from(zipSync(files, { level: options.level ?? 6 }));
}

module.exports = { createZipBuffer, readZipEntries };
