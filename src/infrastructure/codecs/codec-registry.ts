import { createAppError } from '../../domain/state-machines.ts';
import type { Result } from '../../domain/types.ts';
import { parseJianpuTextToScoreV2 } from '../../domain/v2-jianpu-text.ts';
import { deserializeLibraryBackup } from '../../domain/v2-serializer.ts';
import type { ImportFormat, ScoreDocumentV2 } from '../../domain/v2-types.ts';
import { importGuitarProToScoreV2 } from './guitarpro-codec.ts';
import { importMidiToScoreV2 } from './midi-codec.ts';
import { importMusicXmlToScoreV2, importMxlToScoreV2 } from './musicxml-codec.ts';

export interface FileImportPayload {
  filename: string;
  bytes: Uint8Array;
  nowMs?: number;
}

export function detectImportFormat(filename: string): ImportFormat | null {
  const lower = filename.trim().toLowerCase();
  if (lower.endsWith('.musicxml') || lower.endsWith('.xml')) return 'musicxml';
  if (lower.endsWith('.mxl')) return 'mxl';
  if (lower.endsWith('.mid') || lower.endsWith('.midi')) return 'midi';
  if (
    lower.endsWith('.gp') ||
    lower.endsWith('.gp5') ||
    lower.endsWith('.gpx')
  ) {
    return 'guitarpro';
  }
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.txt')) return 'jianpu-text';
  return null;
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').trim() || '导入曲谱';
}

/**
 * 统一外部乐谱文件导入入口，支持 MusicXML (.musicxml/.xml)、MXL (.mxl)、MIDI (.mid/.midi)、JSON (.json) 与简谱文本 (.txt)。
 */
export async function importScoreFromFileData(
  payload: FileImportPayload
): Promise<Result<ScoreDocumentV2[]>> {
  const format = detectImportFormat(payload.filename);
  if (!format) {
    return {
      ok: false,
      error: createAppError(
        'STORAGE_SCHEMA_CORRUPTED',
        '不支持的文件格式，请导入 .musicxml、.mxl、.mid、.gp、.gp5、.gpx、.json 或简谱 .txt 文件'
      ),
    };
  }

  const baseTitle = stripExtension(payload.filename);
  const decoder = new TextDecoder('utf-8');

  if (format === 'guitarpro') {
    const res = await importGuitarProToScoreV2(payload.bytes, {
      title: baseTitle,
      nowMs: payload.nowMs,
    });
    return res.ok ? { ok: true, value: [res.value] } : res;
  }

  if (format === 'mxl') {
    const res = await importMxlToScoreV2(payload.bytes, {
      title: baseTitle,
      nowMs: payload.nowMs,
    });
    return res.ok ? { ok: true, value: [res.value] } : res;
  }

  if (format === 'midi') {
    const res = importMidiToScoreV2(payload.bytes, {
      title: baseTitle,
      nowMs: payload.nowMs,
    });
    return res.ok ? { ok: true, value: [res.value] } : res;
  }

  const text = decoder.decode(payload.bytes);

  if (format === 'musicxml') {
    const res = importMusicXmlToScoreV2(text, {
      title: baseTitle,
      nowMs: payload.nowMs,
    });
    return res.ok ? { ok: true, value: [res.value] } : res;
  }

  if (format === 'jianpu-text') {
    const res = parseJianpuTextToScoreV2(text, {
      title: baseTitle,
      nowMs: payload.nowMs,
    });
    return res.ok ? { ok: true, value: [res.value] } : res;
  }

  return deserializeLibraryBackup(text);
}
