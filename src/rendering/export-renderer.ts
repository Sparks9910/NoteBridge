import { createAppError } from '../domain/state-machines.ts';
import { resolveScoreNotes } from '../domain/theory.ts';
import type { ResolvedNote, Result, ScoreDocument } from '../domain/types.ts';
import type {
  MeasureNotationExtra,
  NoteNotationExtra,
  Track,
  V2Measure,
} from '../domain/v2-types.ts';
import {
  buildA4PdfFromJpegPages,
  dataUrlToUint8Array,
  type PdfJpegPage,
} from '../infrastructure/exporters/pdf-builder.ts';
import { renderJianpu } from './jianpu-renderer.ts';
import { computeScoreLayout, type LayoutLine } from './layout-engine.ts';
import { renderStaff } from './staff-renderer.ts';

export interface ScorePrintMeta {
  subtitle?: string;
  composer?: string;
  lyricist?: string;
}

export interface ScoreNotationPrintContext {
  clef?: Track['clef'];
  voice2Measures?: readonly V2Measure[];
  noteExtrasById?: Readonly<Record<string, NoteNotationExtra>>;
  measureExtrasByIndex?: Readonly<Record<number, MeasureNotationExtra>>;
}

export interface PrintablePageOptions {
  pageWidthPx?: number;
  pageHeightPx?: number;
  notation?: ScoreNotationPrintContext;
}

const DEFAULT_PAGE_WIDTH_PX = 860;
const DEFAULT_PAGE_HEIGHT_PX = 1216;
const FIRST_PAGE_HEADER_HEIGHT = 124;
const NEXT_PAGE_HEADER_HEIGHT = 48;
const FOOTER_HEIGHT = 42;

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * 纯字符串生成无水印 SVG 缩略图（Node 测试与浏览器通用）。
 */
export function buildThumbnailSvg(
  doc: ScoreDocument,
  _resolvedNotes?: readonly ResolvedNote[]
): string {
  const safeTitle = escapeXml((doc.title || '未命名曲谱').slice(0, 18));
  const keyBadge = escapeXml(`1=${doc.keySignature}`);
  const timeBadge = escapeXml(doc.timeSignature);
  const measureCountText = `${doc.measures.length} 小节`;

  // 渲染前 2 小节的简洁简谱旋律轮廓预览
  const previewMeasures = doc.measures.slice(0, 2);
  const itemsSvg: string[] = [];
  let cursorX = 16;
  const baseLineY = 74;

  // 五线谱示意细线
  for (let i = 0; i < 5; i += 1) {
    const y = 50 + i * 5;
    itemsSvg.push(
      `<line x1="12" y1="${y}" x2="268" y2="${y}" stroke="#e2e8f0" stroke-width="1" />`
    );
  }

  for (let mIdx = 0; mIdx < previewMeasures.length; mIdx += 1) {
    const measure = previewMeasures[mIdx];
    if (!measure) {
      continue;
    }
    const maxNotes = measure.notes.slice(0, 6);
    for (const note of maxNotes) {
      if (cursorX > 256) {
        break;
      }
      const label = note.isRest ? '0' : String(note.degree);
      const yOffset = note.isRest ? 0 : -note.degree * 2.2 - note.octaveOffset * 4;
      const dotY = Math.max(46, Math.min(82, baseLineY + yOffset));
      itemsSvg.push(
        `<circle cx="${cursorX}" cy="${dotY.toFixed(1)}" r="2.6" fill="#2563eb" opacity="0.82" />`
      );
      itemsSvg.push(
        `<text x="${cursorX}" y="99" text-anchor="middle" font-size="11" font-weight="600" fill="#334155" font-family="sans-serif">${label}</text>`
      );
      cursorX += 18;
    }
    if (mIdx === 0 && previewMeasures.length > 1) {
      const barX = Math.min(256, cursorX + 4);
      itemsSvg.push(
        `<line x1="${barX}" y1="48" x2="${barX}" y2="104" stroke="#cbd5e1" stroke-width="1.2" />`
      );
      cursorX = barX + 12;
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 280 120" width="280" height="120">`,
    `<rect x="0" y="0" width="280" height="120" rx="8" fill="#ffffff" />`,
    `<rect x="0.5" y="0.5" width="279" height="119" rx="8" fill="none" stroke="#e2e8f0" />`,
    `<text x="14" y="24" font-size="13" font-weight="700" fill="#0f172a" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${safeTitle}</text>`,
    `<rect x="14" y="31" width="44" height="15" rx="4" fill="#eff6ff" />`,
    `<text x="36" y="42" text-anchor="middle" font-size="10" font-weight="600" fill="#2563eb" font-family="sans-serif">${keyBadge}</text>`,
    `<rect x="64" y="31" width="32" height="15" rx="4" fill="#f1f5f9" />`,
    `<text x="80" y="42" text-anchor="middle" font-size="10" font-weight="600" fill="#475569" font-family="sans-serif">${timeBadge}</text>`,
    `<text x="266" y="42" text-anchor="end" font-size="10" fill="#64748b" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${escapeXml(measureCountText)}</text>`,
    ...itemsSvg,
    `</svg>`,
  ].join('');
}

function serializeSvgInnerContent(svg: SVGSVGElement | null): string {
  if (!svg) {
    return '';
  }
  const serializer = new XMLSerializer();
  let inner = '';
  for (const child of Array.from(svg.childNodes)) {
    inner += serializer.serializeToString(child);
  }
  return inner;
}

function paginateLayoutLines(
  lines: readonly LayoutLine[],
  pageHeightPx: number
): LayoutLine[][] {
  if (lines.length === 0) {
    return [[]];
  }
  const pages: LayoutLine[][] = [];
  let current: LayoutLine[] = [];
  let usedHeight = 0;

  const getMaxBodyHeight = (pageIdx: number): number => {
    const header = pageIdx === 0 ? FIRST_PAGE_HEADER_HEIGHT : NEXT_PAGE_HEADER_HEIGHT;
    return Math.max(180, pageHeightPx - header - FOOTER_HEIGHT - 16);
  };

  for (const line of lines) {
    const limit = getMaxBodyHeight(pages.length);
    if (current.length > 0 && usedHeight + line.height > limit) {
      pages.push(current);
      current = [line];
      usedHeight = line.height;
    } else {
      current.push(line);
      usedHeight += line.height;
    }
  }
  if (current.length > 0) {
    pages.push(current);
  }
  return pages;
}

function buildPageHeaderSvg(
  doc: ScoreDocument,
  meta: ScorePrintMeta | undefined,
  pageIndex: number,
  pageWidthPx: number
): string {
  const title = escapeXml(doc.title.trim() || '未命名曲谱');
  if (pageIndex > 0) {
    return [
      `<text x="28" y="28" font-size="13" font-weight="600" fill="#334155" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${title}</text>`,
      `<text x="${pageWidthPx - 28}" y="28" text-anchor="end" font-size="12" fill="#64748b" font-family="sans-serif">1=${escapeXml(doc.keySignature)}  ${escapeXml(doc.timeSignature)}  BPM=${doc.bpm}</text>`,
      `<line x1="24" y1="38" x2="${pageWidthPx - 24}" y2="38" stroke="#e2e8f0" stroke-width="1" />`,
    ].join('');
  }

  const parts: string[] = [
    `<text x="${pageWidthPx / 2}" y="42" text-anchor="middle" font-size="24" font-weight="700" fill="#0f172a" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${title}</text>`,
  ];

  const subtitle = meta?.subtitle?.trim();
  if (subtitle) {
    parts.push(
      `<text x="${pageWidthPx / 2}" y="66" text-anchor="middle" font-size="13" fill="#475569" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${escapeXml(subtitle)}</text>`
    );
  }

  const leftMeta = `1 = ${doc.keySignature}    ${doc.timeSignature}    ♩= ${doc.bpm}`;
  parts.push(
    `<text x="28" y="98" font-size="13" font-weight="600" fill="#1e293b" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${escapeXml(leftMeta)}</text>`
  );

  const credits: string[] = [];
  if (meta?.lyricist?.trim()) {
    credits.push(`词：${meta.lyricist.trim()}`);
  }
  if (meta?.composer?.trim()) {
    credits.push(`曲：${meta.composer.trim()}`);
  }
  if (credits.length > 0) {
    parts.push(
      `<text x="${pageWidthPx - 28}" y="98" text-anchor="end" font-size="12" fill="#334155" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${escapeXml(credits.join('   '))}</text>`
    );
  }

  parts.push(
    `<line x1="24" y1="110" x2="${pageWidthPx - 24}" y2="110" stroke="#cbd5e1" stroke-width="1" />`
  );
  return parts.join('');
}

/**
 * 离屏生成无水印、分页切片后的完整自包含 SVG 页面列表。
 */
export function renderPrintablePageSvgs(
  doc: ScoreDocument,
  meta?: ScorePrintMeta,
  options?: PrintablePageOptions
): string[] {
  if (typeof globalThis === 'undefined' || !globalThis.document) {
    throw new Error('PRINT_RENDER_REQUIRES_DOM');
  }

  const pageWidthPx = options?.pageWidthPx ?? DEFAULT_PAGE_WIDTH_PX;
  const pageHeightPx = options?.pageHeightPx ?? DEFAULT_PAGE_HEIGHT_PX;
  const notation = options?.notation;

  const resolvedNotes = resolveScoreNotes(doc);
  const isGrand = notation?.clef === 'grand';
  const hasLyricsOrMarkings = Boolean(
    notation?.noteExtrasById && Object.keys(notation.noteExtrasById).length > 0
  );
  const staffLineHeight =
    doc.viewMode === 'jianpu' ? 0 : isGrand ? 210 : 110;
  const jianpuLineHeight =
    doc.viewMode === 'staff' ? 0 : hasLyricsOrMarkings ? 96 : 76;

  const layout = computeScoreLayout(doc, resolvedNotes, {
    containerWidth: pageWidthPx,
    staffLineHeight,
    jianpuLineHeight,
    paddingTop: 12,
    paddingX: 24,
  });

  const staffHost = globalThis.document.createElement('div');
  const jianpuHost = globalThis.document.createElement('div');

  const staffSvg =
    doc.viewMode === 'jianpu'
      ? null
      : renderStaff(staffHost, doc, resolvedNotes, layout, {
          clef: notation?.clef,
          voice2Measures: notation?.voice2Measures,
          noteExtrasById: notation?.noteExtrasById,
          measureExtrasByIndex: notation?.measureExtrasByIndex,
        });
  const jianpuSvg =
    doc.viewMode === 'staff'
      ? null
      : renderJianpu(jianpuHost, doc, resolvedNotes, layout, {
          noteExtrasById: notation?.noteExtrasById,
          measureExtrasByIndex: notation?.measureExtrasByIndex,
        });

  const staffInner = serializeSvgInnerContent(staffSvg);
  const jianpuInner = serializeSvgInnerContent(jianpuSvg);
  const pages = paginateLayoutLines(layout.lines, pageHeightPx);
  const totalPages = pages.length;

  return pages.map((pageLines, pageIdx) => {
    const headerHeight =
      pageIdx === 0 ? FIRST_PAGE_HEADER_HEIGHT : NEXT_PAGE_HEADER_HEIGHT;
    const firstLine = pageLines[0];
    const lastLine = pageLines[pageLines.length - 1];
    const sliceStartY = firstLine ? Math.max(0, firstLine.y - 6) : 0;
    const sliceEndY = lastLine
      ? lastLine.y + lastLine.height + 10
      : layout.totalHeight;
    const sliceHeight = Math.max(120, sliceEndY - sliceStartY);
    const actualHeight = Math.max(
      pageHeightPx,
      headerHeight + sliceHeight + FOOTER_HEIGHT
    );

    const headerSvg = buildPageHeaderSvg(doc, meta, pageIdx, pageWidthPx);
    const footerY = actualHeight - 18;
    const footerSvg = `<text x="${pageWidthPx / 2}" y="${footerY}" text-anchor="middle" font-size="11" fill="#64748b" font-family="'PingFang SC','Microsoft YaHei',sans-serif">${pageIdx + 1} / ${totalPages}</text>`;

    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${pageWidthPx}" height="${actualHeight}" viewBox="0 0 ${pageWidthPx} ${actualHeight}">`,
      `<rect x="0" y="0" width="${pageWidthPx}" height="${actualHeight}" fill="#ffffff" />`,
      headerSvg,
      `<svg x="0" y="${headerHeight}" width="${pageWidthPx}" height="${sliceHeight}" viewBox="0 ${sliceStartY} ${layout.totalWidth} ${sliceHeight}" overflow="hidden">`,
      staffInner,
      jianpuInner,
      `</svg>`,
      footerSvg,
      `</svg>`,
    ].join('');
  });
}

/** 将自包含 SVG 字符串光栅化为高 DPI Canvas */
export async function svgStringToCanvas(
  svgStr: string,
  widthPx: number,
  heightPx: number,
  scale = 2
): Promise<HTMLCanvasElement> {
  if (typeof globalThis === 'undefined' || !globalThis.document) {
    throw new Error('CANVAS_RENDER_REQUIRES_DOM');
  }

  const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('SVG_IMAGE_DECODE_FAILED'));
      image.src = url;
    });

    const canvas = globalThis.document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(widthPx * scale));
    canvas.height = Math.max(1, Math.round(heightPx * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('CANVAS_2D_CONTEXT_UNAVAILABLE');
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, widthPx, heightPx);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function parseSvgSize(svgStr: string): { width: number; height: number } {
  const wMatch = svgStr.match(/\bwidth="(\d+(?:\.\d+)?)"/);
  const hMatch = svgStr.match(/\bheight="(\d+(?:\.\d+)?)"/);
  return {
    width: wMatch ? Number(wMatch[1]) : DEFAULT_PAGE_WIDTH_PX,
    height: hMatch ? Number(hMatch[1]) : DEFAULT_PAGE_HEIGHT_PX,
  };
}

/** 导出完整无水印高清 PNG 长图 */
export async function exportScoreToPngBlob(
  doc: ScoreDocument,
  meta?: ScorePrintMeta,
  notation?: ScoreNotationPrintContext
): Promise<Result<Blob>> {
  try {
    const resolvedNotes = resolveScoreNotes(doc);
    const isGrand = notation?.clef === 'grand';
    const hasLyricsOrMarkings = Boolean(
      notation?.noteExtrasById && Object.keys(notation.noteExtrasById).length > 0
    );
    const staffLineHeight =
      doc.viewMode === 'jianpu' ? 0 : isGrand ? 210 : 110;
    const jianpuLineHeight =
      doc.viewMode === 'staff' ? 0 : hasLyricsOrMarkings ? 96 : 76;
    const layout = computeScoreLayout(doc, resolvedNotes, {
      containerWidth: DEFAULT_PAGE_WIDTH_PX,
      staffLineHeight,
      jianpuLineHeight,
      paddingTop: 12,
      paddingX: 24,
    });

    const fullHeight = Math.max(
      640,
      Math.ceil(layout.totalHeight) + FIRST_PAGE_HEADER_HEIGHT + FOOTER_HEIGHT + 32
    );
    const pages = renderPrintablePageSvgs(doc, meta, {
      pageWidthPx: DEFAULT_PAGE_WIDTH_PX,
      pageHeightPx: fullHeight,
      notation,
    });
    const firstSvg = pages[0];
    if (!firstSvg) {
      return {
        ok: false,
        error: createAppError(
          'STORAGE_SCHEMA_CORRUPTED',
          '生成高清图片失败，乐谱渲染内容为空'
        ),
      };
    }
    const { width, height } = parseSvgSize(firstSvg);
    const canvas = await svgStringToCanvas(firstSvg, width, height, 2);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((out) => resolve(out), 'image/png');
    });
    if (!blob) {
      return {
        ok: false,
        error: createAppError(
          'STORAGE_QUOTA_EXCEEDED',
          '生成 PNG 图片文件失败，请重试'
        ),
      };
    }
    return { ok: true, value: blob };
  } catch {
    return {
      ok: false,
      error: createAppError(
        'STORAGE_SCHEMA_CORRUPTED',
        '导出高清 PNG 图片失败，请检查浏览器画布支持后重试'
      ),
    };
  }
}

/** 导出无水印 A4 分页高清 PDF */
export async function exportScoreToPdfBlob(
  doc: ScoreDocument,
  meta?: ScorePrintMeta,
  notation?: ScoreNotationPrintContext
): Promise<Result<Blob>> {
  try {
    const pageSvgs = renderPrintablePageSvgs(doc, meta, {
      pageWidthPx: DEFAULT_PAGE_WIDTH_PX,
      pageHeightPx: DEFAULT_PAGE_HEIGHT_PX,
      notation,
    });

    const pdfPages: PdfJpegPage[] = [];
    for (const svgStr of pageSvgs) {
      const { width, height } = parseSvgSize(svgStr);
      const canvas = await svgStringToCanvas(svgStr, width, height, 2);
      const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.92);
      const jpegBytes = dataUrlToUint8Array(jpegDataUrl);
      pdfPages.push({
        jpegBytes,
        widthPx: canvas.width,
        heightPx: canvas.height,
      });
    }

    const pdfBytes = buildA4PdfFromJpegPages(pdfPages);
    const blob = new Blob([new Uint8Array(pdfBytes)], {
      type: 'application/pdf',
    });
    return { ok: true, value: blob };
  } catch {
    return {
      ok: false,
      error: createAppError(
        'STORAGE_SCHEMA_CORRUPTED',
        '导出 A4 分页 PDF 失败，请检查浏览器画布支持后重试'
      ),
    };
  }
}
