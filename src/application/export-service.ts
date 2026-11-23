import type { Result, ScoreDocument } from '../domain/types.ts';
import {
  extractPartsFromScoreV2,
  extractVoiceAsPartV2,
  projectV2ToV1,
} from '../domain/v2-serializer.ts';
import type {
  MeasureNotationExtra,
  NoteNotationExtra,
  ScoreDocumentV2,
  ScoreMetadata,
} from '../domain/v2-types.ts';
import { exportScoreV2ToMidi } from '../infrastructure/codecs/midi-codec.ts';
import {
  exportScoreV2ToMusicXml,
  exportScoreV2ToMxl,
} from '../infrastructure/codecs/musicxml-codec.ts';
import {
  exportScoreToPdfBlob,
  exportScoreToPngBlob,
  type ScoreNotationPrintContext,
} from '../rendering/export-renderer.ts';
import { libraryStore } from './library-store.ts';
import { notationStore } from './notation-store.ts';

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

function buildPrintContextFromV2(
  v2?: ScoreDocumentV2
): ScoreNotationPrintContext | undefined {
  if (v2) {
    const mainTrack = v2.tracks[0];
    const v2Measures = mainTrack?.voices[1]?.measures;
    const noteExtrasById: Record<string, NoteNotationExtra> = {};
    const measureExtrasByIndex: Record<number, MeasureNotationExtra> = {};
    for (const track of v2.tracks) {
      for (const voice of track.voices) {
        for (const m of voice.measures) {
          if (track === mainTrack && voice.index === 0) {
            if (m.repeatStart || m.repeatEnd || m.barline || m.ending) {
              measureExtrasByIndex[m.index] = {
                repeatStart: m.repeatStart,
                repeatEnd: m.repeatEnd,
                barline: m.barline,
                ending: m.ending,
              };
            }
          }
          for (const b of m.beats) {
            if (
              b.lyric ||
              b.dynamic ||
              b.ornament ||
              b.tieStart ||
              b.tieEnd ||
              b.slurStart ||
              b.slurEnd ||
              b.notes[0]?.fingering
            ) {
              noteExtrasById[b.id] = {
                lyric: b.lyric,
                fingering: b.notes[0]?.fingering,
                dynamic: b.dynamic,
                ornament: b.ornament,
                tieStart: b.tieStart,
                tieEnd: b.tieEnd,
                slurStart: b.slurStart,
                slurEnd: b.slurEnd,
              };
            }
          }
        }
      }
    }
    return {
      clef: mainTrack?.clef ?? 'treble',
      voice2Measures: v2Measures,
      noteExtrasById,
      measureExtrasByIndex,
    };
  }

  const nState = notationStore.getState();
  return {
    clef: nState.clef,
    voice2Measures: nState.tracks[nState.activeTrackIndex]?.voices[1]?.measures,
    noteExtrasById: nState.noteExtrasById,
    measureExtrasByIndex: nState.measureExtrasByIndex,
  };
}

export async function exportCurrentScoreAsPng(
  doc: ScoreDocument,
  meta?: ScoreMetadata,
  v2Override?: ScoreDocumentV2
): Promise<Result<string>> {
  const targetDoc = v2Override ? projectV2ToV1(v2Override) : doc;
  const ctx = buildPrintContextFromV2(v2Override);
  const res = await exportScoreToPngBlob(targetDoc, meta, ctx);
  if (!res.ok) {
    return res;
  }
  const filename = `${sanitizeFilename(targetDoc.title)}.png`;
  downloadBlob(res.value, filename);
  return { ok: true, value: filename };
}

export async function exportCurrentScoreAsPdf(
  doc: ScoreDocument,
  meta?: ScoreMetadata,
  v2Override?: ScoreDocumentV2
): Promise<Result<string>> {
  const targetDoc = v2Override ? projectV2ToV1(v2Override) : doc;
  const ctx = buildPrintContextFromV2(v2Override);
  const res = await exportScoreToPdfBlob(targetDoc, meta, ctx);
  if (!res.ok) {
    return res;
  }
  const filename = `${sanitizeFilename(targetDoc.title)}.pdf`;
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

export function exportScoreAsMusicXml(scoreV2: ScoreDocumentV2): Result<string> {
  const res = exportScoreV2ToMusicXml(scoreV2);
  if (!res.ok) {
    return res;
  }
  const filename = `${sanitizeFilename(scoreV2.title)}.musicxml`;
  const blob = new Blob([res.value], {
    type: 'application/vnd.recordare.musicxml+xml;charset=utf-8',
  });
  downloadBlob(blob, filename);
  return { ok: true, value: filename };
}

export async function exportScoreAsMxl(
  scoreV2: ScoreDocumentV2
): Promise<Result<string>> {
  const res = await exportScoreV2ToMxl(scoreV2);
  if (!res.ok) {
    return res;
  }
  const filename = `${sanitizeFilename(scoreV2.title)}.mxl`;
  const blob = new Blob([new Uint8Array(res.value)], {
    type: 'application/vnd.recordare.musicxml',
  });
  downloadBlob(blob, filename);
  return { ok: true, value: filename };
}

export function exportScoreAsMidi(scoreV2: ScoreDocumentV2): Result<string> {
  const res = exportScoreV2ToMidi(scoreV2);
  if (!res.ok) {
    return res;
  }
  const filename = `${sanitizeFilename(scoreV2.title)}.mid`;
  const blob = new Blob([new Uint8Array(res.value)], {
    type: 'audio/midi',
  });
  downloadBlob(blob, filename);
  return { ok: true, value: filename };
}

export type PartExportFormat = 'musicxml' | 'mxl' | 'midi' | 'pdf' | 'png';

export async function exportPartAsFormat(
  scoreV2: ScoreDocumentV2,
  selection:
    | { mode: 'tracks'; trackIds: string[] }
    | { mode: 'voice'; trackId: string; voiceIndex: number },
  format: PartExportFormat,
  meta?: ScoreMetadata
): Promise<Result<string>> {
  const partRes =
    selection.mode === 'tracks'
      ? extractPartsFromScoreV2(scoreV2, selection.trackIds)
      : extractVoiceAsPartV2(scoreV2, selection.trackId, selection.voiceIndex);

  if (!partRes.ok) {
    return partRes;
  }

  const partDoc = partRes.value;
  if (format === 'musicxml') {
    return exportScoreAsMusicXml(partDoc);
  }
  if (format === 'mxl') {
    return exportScoreAsMxl(partDoc);
  }
  if (format === 'midi') {
    return exportScoreAsMidi(partDoc);
  }
  if (format === 'png') {
    return exportCurrentScoreAsPng(projectV2ToV1(partDoc), meta, partDoc);
  }
  return exportCurrentScoreAsPdf(projectV2ToV1(partDoc), meta, partDoc);
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
