import { describe, expect, it } from 'vitest';
import { calculateDurationTicks } from '../../src/domain/rhythm.ts';
import { resolveScoreNotes } from '../../src/domain/theory.ts';
import type { ScoreDocument } from '../../src/domain/types.ts';
import {
  assignFretboardPositions,
  cycleManualFretPosition,
  getEffectiveOpenMidis,
  getInstrumentProfile,
  getTuningPreset,
  getValidFretPositions,
  INSTRUMENT_PROFILES,
  midiToNoteLabel,
  PRACTICE_INSTRUMENT_IDS,
  TUNING_PRESETS,
} from '../../src/domain/v2-instruments.ts';
import { computeScoreLayout } from '../../src/rendering/layout-engine.ts';

describe('L1 单元测试 - V2.2 乐器配置注册表与吉他/贝斯弦品映射', () => {
  it('乐器配置注册表与调弦预设完备且字段自洽', () => {
    expect(PRACTICE_INSTRUMENT_IDS).toEqual([
      'electric-guitar-clean',
      'acoustic-guitar',
      'piano',
      'bass',
      'melody',
    ]);

    const guitar = getInstrumentProfile('electric-guitar-clean');
    expect(guitar.dockType).toBe('fretboard');
    expect(guitar.defaultViews).toEqual(['staff', 'tab']);
    expect(guitar.maxFret).toBe(24);
    expect(guitar.supportsCapo).toBe(true);
    expect(guitar.supportsGuitarTone).toBe(true);

    const guitarOd = INSTRUMENT_PROFILES['electric-guitar-od'];
    expect(guitarOd.dockType).toBe('fretboard');
    expect(guitarOd.supportsGuitarTone).toBe(true);

    const piano = getInstrumentProfile('piano');
    expect(piano.dockType).toBe('piano-keys');
    expect(piano.defaultClef).toBe('grand');
    expect(piano.supportsCapo).toBe(false);

    const bass = getInstrumentProfile('bass');
    expect(bass.dockType).toBe('fretboard');
    expect(bass.defaultClef).toBe('bass');
    expect(bass.availableTuningIds).toEqual([
      'bass-4-standard',
      'bass-5-standard',
    ]);

    expect(TUNING_PRESETS['standard-6'].openStringMidis).toEqual([
      64, 59, 55, 50, 45, 40,
    ]);
    expect(TUNING_PRESETS['drop-d-6'].openStringMidis[5]).toBe(38);
    expect(TUNING_PRESETS['eb-standard-6'].openStringMidis[0]).toBe(63);
    expect(getEffectiveOpenMidis([64, 59, 55, 50, 45, 40], 2)).toEqual([
      66, 61, 57, 52, 47, 42,
    ]);
    expect(midiToNoteLabel(60)).toBe('C4');
    expect(midiToNoteLabel(69)).toBe('A4');
  });

  it('assignFretboardPositions 支持最小把位移动、休止符跳过、Drop D 与 4/5 弦贝斯', () => {
    const standard = getTuningPreset('standard-6');
    const positions = assignFretboardPositions(
      [
        { noteId: 'n1', midiPitch: 60 }, // C4: 2弦1品 or 3弦5品 -> 选低把位 2弦1品
        { noteId: 'r1', midiPitch: null }, // 休止符跳过
        { noteId: 'n2', midiPitch: 62 }, // D4: 2弦3品（靠近上个把位 1品）
        { noteId: 'n3', midiPitch: 64 }, // E4: 1弦0品
      ],
      { openStringMidis: standard.openStringMidis, capo: 0, maxFret: 24 }
    );

    expect(positions.r1).toBeUndefined();
    expect(positions.n1?.string).toBe(2);
    expect(positions.n1?.fret).toBe(1);
    expect(positions.n2?.string).toBe(2);
    expect(positions.n2?.fret).toBe(3);
    expect(positions.n3?.string).toBe(1);
    expect(positions.n3?.fret).toBe(0);

    // Drop D 最低音 D2 (MIDI 38) 映射至 6 弦 0 品
    const dropD = getTuningPreset('drop-d-6');
    const dropPos = assignFretboardPositions(
      [{ noteId: 'd2', midiPitch: 38 }],
      { openStringMidis: dropD.openStringMidis, capo: 0, maxFret: 24 }
    );
    expect(dropPos.d2?.string).toBe(6);
    expect(dropPos.d2?.fret).toBe(0);

    // 5 弦贝斯最低音 B0 (MIDI 23) 映射至 5 弦 0 品
    const bass5 = getTuningPreset('bass-5-standard');
    const bassPos = assignFretboardPositions(
      [{ noteId: 'b0', midiPitch: 23 }],
      { openStringMidis: bass5.openStringMidis, capo: 0, maxFret: 24 }
    );
    expect(bassPos.b0?.string).toBe(5);
    expect(bassPos.b0?.fret).toBe(0);
  });

  it('变调夹 Capo 联动重算相对品位与物理品位，支持手动把位覆盖与循环切换', () => {
    const standard = getTuningPreset('standard-6');

    // Capo 2：空弦变成 F#4/C#4/A3/E3/B2/F#2；MIDI 64 (E4) 变成 2弦3品（物理5品）
    const capoPos = assignFretboardPositions(
      [{ noteId: 'e4', midiPitch: 64 }],
      { openStringMidis: standard.openStringMidis, capo: 2, maxFret: 24 }
    );
    expect(capoPos.e4?.string).toBe(2);
    expect(capoPos.e4?.fret).toBe(3);
    expect(capoPos.e4?.physicalFret).toBe(5);

    // 手动覆盖把位至 3弦7品（相对7品，物理9品，MIDI 55+2+7=64）
    const manualPos = assignFretboardPositions(
      [{ noteId: 'e4', midiPitch: 64 }],
      {
        openStringMidis: standard.openStringMidis,
        capo: 2,
        maxFret: 24,
        manualPositions: { e4: { string: 3, fret: 7 } },
      }
    );
    expect(manualPos.e4?.string).toBe(3);
    expect(manualPos.e4?.fret).toBe(7);
    expect(manualPos.e4?.physicalFret).toBe(9);
    expect(manualPos.e4?.isManual).toBe(true);

    // 候选列表与循环切换把位
    const candidates = getValidFretPositions(64, standard.openStringMidis, 0, 24);
    expect(candidates.length).toBeGreaterThanOrEqual(4);
    const next = cycleManualFretPosition(
      64,
      candidates[0],
      standard.openStringMidis,
      0,
      24
    );
    expect(next).toEqual(candidates[1]);
  });

  it('布局引擎开启 tabLineHeight 后严格保持既有 LayoutSlot.x 不变', () => {
    const doc: ScoreDocument = {
      schemaVersion: 1,
      id: 'tab-layout-test',
      title: 'TAB 布局对齐测试',
      keySignature: 'C',
      timeSignature: '4/4',
      bpm: 100,
      viewMode: 'dual',
      updatedAtEpochMs: 1730000000000,
      measures: [
        {
          id: 'm1',
          index: 0,
          notes: [
            {
              id: 'n1',
              isRest: false,
              degree: 1,
              octaveOffset: 0,
              accidental: null,
              baseDuration: 'quarter',
              dotted: false,
              durationTicks: calculateDurationTicks('quarter', false),
            },
            {
              id: 'n2',
              isRest: false,
              degree: 3,
              octaveOffset: 0,
              accidental: null,
              baseDuration: 'quarter',
              dotted: false,
              durationTicks: calculateDurationTicks('quarter', false),
            },
          ],
        },
      ],
    };

    const resolved = resolveScoreNotes(doc);
    const baseLayout = computeScoreLayout(doc, resolved, { containerWidth: 900 });
    const tabLayout = computeScoreLayout(doc, resolved, {
      containerWidth: 900,
      tabLineHeight: 120,
    });

    expect(tabLayout.slotByNoteId.n1?.x).toBe(baseLayout.slotByNoteId.n1?.x);
    expect(tabLayout.slotByNoteId.n2?.x).toBe(baseLayout.slotByNoteId.n2?.x);
    expect(tabLayout.lines[0]?.tabY).toBe(
      (baseLayout.lines[0]?.y ?? 0) + (baseLayout.lines[0]?.height ?? 0)
    );
    expect(tabLayout.lines[0]?.height).toBe(
      (baseLayout.lines[0]?.height ?? 0) + 120
    );
  });
});
