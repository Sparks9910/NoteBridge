export interface PdfJpegPage {
  jpegBytes: Uint8Array;
  widthPx: number;
  heightPx: number;
}

const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;

const encoder = new TextEncoder();

function encodeAscii(text: string): Uint8Array {
  return encoder.encode(text);
}

function concatUint8Arrays(chunks: readonly Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.byteLength;
  }
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** 将 data:image/...;base64,... URL 转为二进制 Uint8Array */
export function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const commaIdx = dataUrl.indexOf(',');
  const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * 纯 TypeScript 零依赖构造标准 PDF 1.4（A4 分页 + 无水印 DCTDecode JPEG 嵌图）。
 */
export function buildA4PdfFromJpegPages(pages: readonly PdfJpegPage[]): Uint8Array {
  const safePages: readonly PdfJpegPage[] =
    pages.length > 0 ? pages : [{ jpegBytes: new Uint8Array(0), widthPx: 860, heightPx: 1216 }];

  const chunks: Uint8Array[] = [];
  let cursorOffset = 0;
  const pushChunk = (bytes: Uint8Array) => {
    chunks.push(bytes);
    cursorOffset += bytes.byteLength;
  };
  const pushText = (text: string) => {
    pushChunk(encodeAscii(text));
  };

  // PDF Header (含 4 字节二进制标识行)
  pushChunk(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]));
  pushChunk(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const totalObjects = 2 + safePages.length * 3;
  const offsets = new Array<number>(totalObjects + 1).fill(0);

  const pageObjIds = safePages.map((_, idx) => 3 + idx * 3);

  // 1: Catalog
  offsets[1] = cursorOffset;
  pushText('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  // 2: Pages
  offsets[2] = cursorOffset;
  pushText(
    `2 0 obj\n<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${safePages.length} >>\nendobj\n`
  );

  // 逐页写入 Page / Image XObject / Content Stream
  for (let i = 0; i < safePages.length; i += 1) {
    const page = safePages[i]!;
    const pageId = 3 + i * 3;
    const imageId = 4 + i * 3;
    const contentId = 5 + i * 3;
    const hasImage = page.jpegBytes.byteLength > 0;

    // Page object
    offsets[pageId] = cursorOffset;
    const resources = hasImage
      ? `<< /XObject << /Im0 ${imageId} 0 R >> >>`
      : '<< >>';
    pushText(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_WIDTH_PT} ${A4_HEIGHT_PT}] /Resources ${resources} /Contents ${contentId} 0 R >>\nendobj\n`
    );

    // Image XObject
    offsets[imageId] = cursorOffset;
    if (hasImage) {
      const w = Math.max(1, Math.round(page.widthPx));
      const h = Math.max(1, Math.round(page.heightPx));
      pushText(
        `${imageId} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpegBytes.byteLength} >>\nstream\n`
      );
      pushChunk(page.jpegBytes);
      pushText('\nendstream\nendobj\n');
    } else {
      pushText(`${imageId} 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n`);
    }

    // Content stream (等比居中铺满 A4 页面)
    let streamBody = '';
    if (hasImage) {
      const safeW = Math.max(1, page.widthPx);
      const safeH = Math.max(1, page.heightPx);
      const scale = Math.min(A4_WIDTH_PT / safeW, A4_HEIGHT_PT / safeH);
      const drawW = safeW * scale;
      const drawH = safeH * scale;
      const offsetX = (A4_WIDTH_PT - drawW) / 2;
      const offsetY = (A4_HEIGHT_PT - drawH) / 2;
      streamBody = `q\n${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${offsetX.toFixed(2)} ${offsetY.toFixed(2)} cm\n/Im0 Do\nQ\n`;
    }
    const streamBytes = encodeAscii(streamBody);
    offsets[contentId] = cursorOffset;
    pushText(
      `${contentId} 0 obj\n<< /Length ${streamBytes.byteLength} >>\nstream\n`
    );
    pushChunk(streamBytes);
    pushText('endstream\nendobj\n');
  }

  // xref table
  const xrefOffset = cursorOffset;
  pushText(`xref\n0 ${totalObjects + 1}\n`);
  pushText('0000000000 65535 f \n');
  for (let objId = 1; objId <= totalObjects; objId += 1) {
    const off = offsets[objId] ?? 0;
    pushText(`${String(off).padStart(10, '0')} 00000 n \n`);
  }

  // trailer
  pushText(
    `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  );

  return concatUint8Arrays(chunks);
}
