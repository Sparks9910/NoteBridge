import type { Result, ScoreDocument } from '../domain/types.ts';
import type { ScoreMetadata } from '../domain/v2-types.ts';
import {
  exportScoreToPdfBlob,
  exportScoreToPngBlob,
} from '../rendering/export-renderer.ts';
import { libraryStore } from './library-store.ts';

function sanitizeFilename(title: string): string {
  const cleaned = title
    .trim()
    .replaceAll(/[\\/:*?"<>|]/g, '_')
    .replaceAll(/\s+/g, ' ');
  return cleaned.length > 0 ? cleaned.slice(0, 64) : '未命名曲谱';
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  globalThis.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

export async function exportCurrentScoreAsPng(
  doc: ScoreDocument,
  meta?: ScoreMetadata
): Promise<Result<string>> {
  const res = await exportScoreToPngBlob(doc, meta);
  if (!res.ok) {
    return res;
  }
  const filename = `${sanitizeFilename(doc.title)}.png`;
  downloadBlob(res.value, filename);
  return { ok: true, value: filename };
}

export async function exportCurrentScoreAsPdf(
  doc: ScoreDocument,
  meta?: ScoreMetadata
): Promise<Result<string>> {
  const res = await exportScoreToPdfBlob(doc, meta);
  if (!res.ok) {
    return res;
  }
  const filename = `${sanitizeFilename(doc.title)}.pdf`;
  downloadBlob(res.value, filename);
  return { ok: true, value: filename };
}

export function exportCurrentScoreAsJson(
  doc: ScoreDocument,
  meta?: ScoreMetadata
): Result<string> {
  const res = libraryStore.getState().exportSingleScoreJson(doc, meta);
  if (!res.ok) {
    return res;
  }
  const filename = `${sanitizeFilename(doc.title)}.notebridge.json`;
  const blob = new Blob([res.value], {
    type: 'application/json;charset=utf-8',
  });
  downloadBlob(blob, filename);
  return { ok: true, value: filename };
}

export async function exportLibraryBackupFile(): Promise<Result<string>> {
  const res = await libraryStore.getState().exportAllBackupJson();
  if (!res.ok) {
    return res;
  }
  const dateStamp = new Date().toISOString().slice(0, 10);
  const filename = `notebridge-library-backup-${dateStamp}.json`;
  const blob = new Blob([res.value], {
    type: 'application/json;charset=utf-8',
  });
  downloadBlob(blob, filename);
  return { ok: true, value: filename };
}
