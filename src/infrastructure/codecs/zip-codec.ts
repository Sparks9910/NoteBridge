import { createAppError } from '../../domain/state-machines.ts';
import type { Result } from '../../domain/types.ts';

export interface ZipEntryInput {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function runStreamTransform(
  input: Uint8Array,
  transform: ReadableWritablePair<Uint8Array, Uint8Array>
): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  const writePromise = writer.write(new Uint8Array(input)).then(() => writer.close());
  const reader = transform.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  await writePromise;

  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

async function deflateRaw(input: Uint8Array): Promise<{ method: 0 | 8; payload: Uint8Array }> {
  if (typeof CompressionStream === 'function') {
    try {
      const compressed = await runStreamTransform(
        input,
        new CompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>
      );
      if (compressed.byteLength < input.byteLength) {
        return { method: 8, payload: compressed };
      }
    } catch {
      // Fallback to STORE
    }
  }
  return { method: 0, payload: input };
}

async function inflateRaw(input: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('DECOMPRESSION_UNAVAILABLE');
  }
  return runStreamTransform(
    input,
    new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>
  );
}

/** 将多个文件条目打包为标准 ZIP 字节数组（用于 .mxl 导出） */
export async function packZip(entries: readonly ZipEntryInput[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const { method, payload } = await deflateRaw(entry.data);

    // Local File Header (30 bytes + name)
    const lfh = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(lfh.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true); // version needed
    ldv.setUint16(6, 0x0800, true); // UTF-8 filename flag
    ldv.setUint16(8, method, true);
    ldv.setUint16(10, 0, true);
    ldv.setUint16(12, 0x5421, true);
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, payload.byteLength, true);
    ldv.setUint32(22, entry.data.byteLength, true);
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true);
    lfh.set(nameBytes, 30);

    localParts.push(lfh, payload);

    // Central Directory Header (46 bytes + name)
    const cdh = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cdh.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0x0800, true);
    cdv.setUint16(10, method, true);
    cdv.setUint16(12, 0, true);
    cdv.setUint16(14, 0x5421, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, payload.byteLength, true);
    cdv.setUint32(24, entry.data.byteLength, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, localOffset, true);
    cdh.set(nameBytes, 46);

    centralParts.push(cdh);
    localOffset += lfh.byteLength + payload.byteLength;
  }

  let centralSize = 0;
  for (const part of centralParts) {
    centralSize += part.byteLength;
  }

  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, entries.length, true);
  edv.setUint16(10, entries.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, localOffset, true);
  edv.setUint16(20, 0, true);

  const totalSize = localOffset + centralSize + eocd.byteLength;
  const output = new Uint8Array(totalSize);
  let cursor = 0;
  for (const part of localParts) {
    output.set(part, cursor);
    cursor += part.byteLength;
  }
  for (const part of centralParts) {
    output.set(part, cursor);
    cursor += part.byteLength;
  }
  output.set(eocd, cursor);
  return output;
}

/** 解压标准 ZIP 压缩包（支持 STORE 与 DEFLATE） */
export async function unpackZip(
  bytes: Uint8Array
): Promise<Result<Map<string, Uint8Array>>> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22) {
    return {
      ok: false,
      error: createAppError('STORAGE_SCHEMA_CORRUPTED', 'MXL 压缩文件数据过短或已损坏'),
    };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocdPos = -1;
  const minScan = Math.max(0, bytes.byteLength - 65557);
  for (let i = bytes.byteLength - 22; i >= minScan; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdPos = i;
      break;
    }
  }

  if (eocdPos === -1) {
    return {
      ok: false,
      error: createAppError('STORAGE_SCHEMA_CORRUPTED', 'MXL 压缩包缺少目录尾签名，文件格式无效'),
    };
  }

  const entryCount = view.getUint16(eocdPos + 10, true);
  const cdOffset = view.getUint32(eocdPos + 16, true);
  if (cdOffset >= bytes.byteLength) {
    return {
      ok: false,
      error: createAppError('STORAGE_SCHEMA_CORRUPTED', 'MXL 压缩包目录偏移越界'),
    };
  }

  const decoder = new TextDecoder('utf-8');
  const files = new Map<string, Uint8Array>();
  let cursor = cdOffset;

  try {
    for (let i = 0; i < entryCount; i += 1) {
      if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== 0x02014b50) {
        return {
          ok: false,
          error: createAppError('STORAGE_SCHEMA_CORRUPTED', 'MXL 压缩包中央目录项已损坏'),
        };
      }
      const method = view.getUint16(cursor + 10, true);
      const compressedSize = view.getUint32(cursor + 20, true);
      const nameLen = view.getUint16(cursor + 28, true);
      const extraLen = view.getUint16(cursor + 30, true);
      const commentLen = view.getUint16(cursor + 32, true);
      const localHeaderOffset = view.getUint32(cursor + 42, true);

      const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));
      cursor += 46 + nameLen + extraLen + commentLen;

      if (
        localHeaderOffset + 30 > bytes.byteLength ||
        view.getUint32(localHeaderOffset, true) !== 0x04034b50
      ) {
        return {
          ok: false,
          error: createAppError('STORAGE_SCHEMA_CORRUPTED', 'MXL 压缩包本地文件头损坏'),
        };
      }

      const lfhNameLen = view.getUint16(localHeaderOffset + 26, true);
      const lfhExtraLen = view.getUint16(localHeaderOffset + 28, true);
      const dataStart = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > bytes.byteLength) {
        return {
          ok: false,
          error: createAppError('STORAGE_SCHEMA_CORRUPTED', 'MXL 压缩包条目长度越界'),
        };
      }

      const rawSlice = bytes.subarray(dataStart, dataEnd);
      if (name.endsWith('/')) {
        continue;
      }

      if (method === 0) {
        files.set(name, new Uint8Array(rawSlice));
      } else if (method === 8) {
        const inflated = await inflateRaw(rawSlice);
        files.set(name, inflated);
      } else {
        return {
          ok: false,
          error: createAppError(
            'STORAGE_SCHEMA_CORRUPTED',
            `MXL 压缩算法不受支持（方式 ${method}），仅支持 Store 与 Deflate`
          ),
        };
      }
    }
  } catch {
    return {
      ok: false,
      error: createAppError('STORAGE_SCHEMA_CORRUPTED', '解压 MXL 压缩乐谱包失败，文件可能已损坏'),
    };
  }

  return { ok: true, value: files };
}
