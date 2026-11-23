import { describe, expect, it } from 'vitest';
import { calculateDurationTicks } from '../../src/domain/rhythm.ts';
import { resolveNotePitch } from '../../src/domain/theory.ts';
import {
  computeSemitoneDelta,
  transposeKeySignature,
  transposeScoreDocument,
} from '../../src/domain/transpose.ts';
import type { NoteEvent, ScoreDocument } from '../../src/domain/types.ts';
import {
  deserializeAnyScoreDocument,
  deserializeLibraryBackup,
  migrateV1ToV2,
  projectV2ToV1,
  serializeLibraryBackup,
  serializeScoreDocumentV2,
} from '../../src/domain/v2-serializer.ts';
import { buildA4PdfFromJpegPages } from '../../src/infrastructure/exporters/pdf-builder.ts';
import { buildThumbnailSvg } from '../../src/rendering/export-renderer.ts';

function makeNote(
  id: string,
  degree: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7,
  options?: {
    isRest?: boolean;
    octaveOffset?: -2 | -1 | 0 | 1 | 2;
    accidental?: NoteEvent['accidental'];
    baseDuration?: NoteEvent['baseDuration'];
    dotted?: boolean;
  }
): NoteEvent {
  const isRest = options?.isRest ?? degree === 0;
  const baseDuration = options?.baseDuration ?? 'quarter';
  const dotted = options?.dotted ?? false;
  return {
    id,
    isRest,
    degree: isRest ? 0 : degree,
    octaveOffset: isRest ? 0 : (options?.octaveOffset ?? 0),
    accidental: isRest ? null : (options?.accidental ?? null),
    baseDuration,
    dotted,
    durationTicks: calculateDurationTicks(baseDuration, dotted),
  };
}

function makeSampleV1Doc(): ScoreDocument {
  return {
    schemaVersion: 1,
    id: 'v2_test_doc_1',
    title: '测试迁移曲谱',
    keySignature: 'C',
    timeSignature: '4/4',
    bpm: 100,
    viewMode: 'dual',
    updatedAtEpochMs: 1732300000000,
    measures: [
      {
        id: 'm1',
        index: 0,
        notes: [
          makeNote('n1', 1, { octaveOffset: 1, accidental: 'sharp' }),
          makeNote('n2', 3, { dotted: true }),
          makeNote('n3', 0, { isRest: true, baseDuration: 'eighth' }),
          makeNote('n4', 5, { octaveOffset: -1, baseDuration: 'eighth' }),
        ],
      },
      {
        id: 'm2',
        index: 1,
        notes: [makeNote('n5', 1, { baseDuration: 'whole' })],
      },
    ],
  };
}

describe('L1 V2.0 领域模型迁移、移调、PDF 与缩略图单元测试', () => {
  it('migrateV1ToV2 与 projectV2ToV1 往返无损保留全部音符与参数', () => {
    const v1 = makeSampleV1Doc();
    const v2 = migrateV1ToV2(v1, {
      subtitle: '测试副标题',
      composer: '音桥测试',
    });

    expect(v2.schemaVersion).toBe(2);
    expect(v2.subtitle).toBe('测试副标题');
    expect(v2.composer).toBe('音桥测试');
    expect(v2.tracks).toHaveLength(1);
    expect(v2.tracks[0]?.enabledViews).toEqual(['staff', 'jianpu']);

    const leadBeat = v2.tracks[0]?.voices[0]?.measures[0]?.beats[0];
    expect(leadBeat?.notes[0]?.midiPitch).toBe(73); // 1=C 高八度 #1 = C#5 (73)

    const projected = projectV2ToV1(v2);
    expect(projected).toEqual(v1);
  });

  it('deserializeAnyScoreDocument 同时兼容 v1/v2，损坏数据返回中文 AppError', () => {
    const v1 = makeSampleV1Doc();
    const v1Res = deserializeAnyScoreDocument(JSON.stringify(v1));
    expect(v1Res.ok).toBe(true);
    if (v1Res.ok) {
      expect(v1Res.value.schemaVersion).toBe(2);
      expect(projectV2ToV1(v1Res.value)).toEqual(v1);
    }

    const v2 = migrateV1ToV2(v1);
    const v2Ser = serializeScoreDocumentV2(v2);
    expect(v2Ser.ok).toBe(true);
    if (v2Ser.ok) {
      const v2Res = deserializeAnyScoreDocument(v2Ser.value);
      expect(v2Res.ok).toBe(true);
      if (v2Res.ok) {
        expect(v2Res.value).toEqual(v2);
      }
    }

    const badRes = deserializeAnyScoreDocument('{"schemaVersion":99}');
    expect(badRes.ok).toBe(false);
    if (!badRes.ok) {
      expect(badRes.error.code).toBe('STORAGE_SCHEMA_CORRUPTED');
      expect(badRes.error.detail).toMatch(/[\u4e00-\u9fa5]/);
    }
  });

  it('serializeLibraryBackup 与 deserializeLibraryBackup 支持整库及单曲兼容解析', () => {
    const v2 = migrateV1ToV2(makeSampleV1Doc());
    const serRes = serializeLibraryBackup([v2], 1732300001000);
    expect(serRes.ok).toBe(true);
    if (!serRes.ok) {
      return;
    }

    const bundleRes = deserializeLibraryBackup(serRes.value);
    expect(bundleRes.ok).toBe(true);
    if (bundleRes.ok) {
      expect(bundleRes.value).toHaveLength(1);
      expect(bundleRes.value[0]).toEqual(v2);
    }

    // 兼容单曲 v1 JSON 直接导入
    const singleRes = deserializeLibraryBackup(JSON.stringify(makeSampleV1Doc()));
    expect(singleRes.ok).toBe(true);
    if (singleRes.ok) {
      expect(singleRes.value).toHaveLength(1);
      expect(singleRes.value[0]?.schemaVersion).toBe(2);
    }
  });

  it('一键移调：movable-do 保持简谱唱名不变并移动绝对 MIDI 与调号', () => {
    expect(computeSemitoneDelta('C', 'G')).toBe(-5);
    expect(transposeKeySignature('C', 7)).toBe('G');

    const doc: ScoreDocument = {
      ...makeSampleV1Doc(),
      keySignature: 'C',
      measures: [
        {
          id: 'm1',
          index: 0,
          notes: [makeNote('a1', 1), makeNote('a2', 3), makeNote('a3', 5)],
        },
      ],
    };

    const res = transposeScoreDocument(doc, {
      strategy: 'movable-do',
      targetKey: 'G',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }

    expect(res.value.keySignature).toBe('G');
    expect(res.value.measures[0]?.notes.map((n) => n.degree)).toEqual([1, 3, 5]);
    const midiList = res.value.measures[0]?.notes.map(
      (n) => resolveNotePitch(n, res.value.keySignature)?.midiPitch
    );
    expect(midiList).toEqual([67, 71, 74]);
  });

  it('一键移调：fixed-pitch 1=C 下 1 3 5 升 +2 变 2 #4 6，降 -2 变低八度 b7 2 4，休止符与极限八度安全', () => {
    const doc: ScoreDocument = {
      ...makeSampleV1Doc(),
      keySignature: 'C',
      measures: [
        {
          id: 'm1',
          index: 0,
          notes: [
            makeNote('n1', 1),
            makeNote('n2', 3),
            makeNote('n3', 5),
            makeNote('n4', 0, { isRest: true }),
          ],
        },
      ],
    };

    const upRes = transposeScoreDocument(doc, {
      strategy: 'fixed-pitch',
      semitones: 2,
    });
    expect(upRes.ok).toBe(true);
    if (upRes.ok) {
      expect(upRes.value.keySignature).toBe('C');
      const notes = upRes.value.measures[0]!.notes;
      expect(notes.map((n) => ({ d: n.degree, acc: n.accidental, o: n.octaveOffset, r: n.isRest }))).toEqual([
        { d: 2, acc: null, o: 0, r: false },
        { d: 4, acc: 'sharp', o: 0, r: false },
        { d: 6, acc: null, o: 0, r: false },
        { d: 0, acc: null, o: 0, r: true },
      ]);
    }

    const downRes = transposeScoreDocument(doc, {
      strategy: 'fixed-pitch',
      semitones: -2,
    });
    expect(downRes.ok).toBe(true);
    if (downRes.ok) {
      const notes = downRes.value.measures[0]!.notes;
      expect(notes.map((n) => ({ d: n.degree, acc: n.accidental, o: n.octaveOffset, r: n.isRest }))).toEqual([
        { d: 7, acc: 'flat', o: -1, r: false },
        { d: 2, acc: null, o: 0, r: false },
        { d: 4, acc: null, o: 0, r: false },
        { d: 0, acc: null, o: 0, r: true },
      ]);
    }

    // 非法半音参数拦截
    const badRes = transposeScoreDocument(doc, {
      strategy: 'fixed-pitch',
      semitones: 18,
    });
    expect(badRes.ok).toBe(false);
    if (!badRes.ok) {
      expect(badRes.error.code).toBe('SCORE_INVALID_KEY_SIGNATURE');
    }
  });

  it('buildA4PdfFromJpegPages 生成标准无水印 PDF 1.4 二进制结构与分页计数', () => {
    const fakeJpeg1 = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
    const fakeJpeg2 = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
    const pdfBytes = buildA4PdfFromJpegPages([
      { jpegBytes: fakeJpeg1, widthPx: 860, heightPx: 1216 },
      { jpegBytes: fakeJpeg2, widthPx: 860, heightPx: 1216 },
    ]);

    const ascii = new TextDecoder('latin1').decode(pdfBytes);
    expect(ascii.startsWith('%PDF-1.4')).toBe(true);
    expect(ascii.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(ascii).toContain('/Count 2');
    expect(ascii).toContain('/MediaBox [0 0 595.28 841.89]');
    expect(ascii).toContain('xref');
  });

  it('buildThumbnailSvg 生成有效无水印 SVG 缩略图字符串', () => {
    const svg = buildThumbnailSvg(makeSampleV1Doc());
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('测试迁移曲谱');
    expect(svg).toContain('1=C');
    expect(svg).not.toContain('来音');
  });
});
