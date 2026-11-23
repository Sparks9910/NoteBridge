import { describe, expect, it } from 'vitest';
import {
  computeStemDirection,
  KEY_BASE_MIDI_MAP,
  resolveMeasureNotes,
  resolveNotePitch,
  resolveScoreNotes,
  VALID_KEY_SIGNATURES,
} from '../../src/domain/theory.ts';
import type {
  KeySignature,
  Measure,
  NoteEvent,
  ScoreDocument,
} from '../../src/domain/types.ts';

function makeNote(
  id: string,
  degree: NoteEvent['degree'],
  overrides?: Partial<NoteEvent>
): NoteEvent {
  return {
    id,
    isRest: degree === 0,
    degree,
    octaveOffset: 0,
    accidental: null,
    baseDuration: 'quarter',
    dotted: false,
    durationTicks: 480,
    ...overrides,
  };
}

describe('theory - 12 大调首调↔固定调映射与音高解析', () => {
  it('12 个大调基准 MIDI 严格符合 A-05 假设', () => {
    expect(VALID_KEY_SIGNATURES).toHaveLength(12);
    expect(KEY_BASE_MIDI_MAP).toEqual({
      Ab: 56,
      A: 57,
      Bb: 58,
      B: 59,
      C: 60,
      Db: 61,
      D: 62,
      Eb: 63,
      E: 64,
      F: 65,
      Gb: 66,
      G: 67,
    });
  });

  it('12 大调音级 1..7 全部映射到正确 MIDI 与五线谱音名', () => {
    const majorIntervals = [0, 2, 4, 5, 7, 9, 11] as const;

    for (const key of VALID_KEY_SIGNATURES) {
      const baseMidi = KEY_BASE_MIDI_MAP[key];
      for (let i = 0; i < 7; i += 1) {
        const degree = (i + 1) as NoteEvent['degree'];
        const interval = majorIntervals[i] ?? 0;
        const resolved = resolveNotePitch(makeNote(`n-${key}-${degree}`, degree), key);
        expect(resolved).not.toBeNull();
        expect(resolved?.midiPitch).toBe(baseMidi + interval);
        expect(resolved?.staffPitchName).toMatch(/^[A-G][#b]?\/\d+$/);
      }
    }
  });

  it('验证 README 与契约关键调号示例（C / G / F / D / Bb / Gb）', () => {
    const cases: Array<{
      key: KeySignature;
      degree: NoteEvent['degree'];
      expectedMidi: number;
      expectedPitch: string;
    }> = [
      { key: 'C', degree: 1, expectedMidi: 60, expectedPitch: 'C/4' },
      { key: 'C', degree: 7, expectedMidi: 71, expectedPitch: 'B/4' },
      { key: 'G', degree: 1, expectedMidi: 67, expectedPitch: 'G/4' },
      { key: 'G', degree: 7, expectedMidi: 78, expectedPitch: 'F#/5' },
      { key: 'F', degree: 1, expectedMidi: 65, expectedPitch: 'F/4' },
      { key: 'F', degree: 4, expectedMidi: 70, expectedPitch: 'Bb/4' },
      { key: 'D', degree: 3, expectedMidi: 66, expectedPitch: 'F#/4' },
      { key: 'Bb', degree: 1, expectedMidi: 58, expectedPitch: 'Bb/3' },
      { key: 'Gb', degree: 4, expectedMidi: 71, expectedPitch: 'Cb/5' },
    ];

    for (const c of cases) {
      const res = resolveNotePitch(makeNote('test', c.degree), c.key);
      expect(res?.midiPitch).toBe(c.expectedMidi);
      expect(res?.staffPitchName).toBe(c.expectedPitch);
    }
  });

  it('支持 octaveOffset -2..2、休止符及临时升降号与重升降等音回退', () => {
    const high2 = resolveNotePitch(makeNote('h2', 1, { octaveOffset: 2 }), 'C');
    expect(high2?.midiPitch).toBe(84);
    expect(high2?.staffPitchName).toBe('C/6');

    const low2 = resolveNotePitch(makeNote('l2', 1, { octaveOffset: -2 }), 'C');
    expect(low2?.midiPitch).toBe(36);
    expect(low2?.staffPitchName).toBe('C/2');

    const rest = resolveNotePitch(makeNote('r', 0, { isRest: true }), 'C');
    expect(rest).toBeNull();

    // G 调 7 默认 F#5，再加升号得 G5（避免产生 VexFlow 不合法的重升记号）
    const doubleSharpFallback = resolveNotePitch(
      makeNote('ds', 7, { accidental: 'sharp' }),
      'G'
    );
    expect(doubleSharpFallback?.midiPitch).toBe(79);
    expect(doubleSharpFallback?.staffPitchName).toBe('G/5');

    // F 调 4 默认 Bb4，再加降号得 A4
    const doubleFlatFallback = resolveNotePitch(
      makeNote('df', 4, { accidental: 'flat' }),
      'F'
    );
    expect(doubleFlatFallback?.midiPitch).toBe(69);
    expect(doubleFlatFallback?.staffPitchName).toBe('A/4');
  });

  it('高音谱号第三线 B4 符干方向规则正确', () => {
    expect(computeStemDirection('A', 4, 'quarter')).toBe('up');
    expect(computeStemDirection('B', 4, 'quarter')).toBe('down');
    expect(computeStemDirection('C', 5, 'eighth')).toBe('down');
    expect(computeStemDirection('C', 4, 'whole')).toBeNull();
  });

  it('resolveScoreNotes 正确累计跨小节 startTickInScore', () => {
    const m1: Measure = {
      id: 'm1',
      index: 0,
      notes: [makeNote('n1', 1), makeNote('n2', 2)],
    };
    const m2: Measure = {
      id: 'm2',
      index: 1,
      notes: [makeNote('n3', 3), makeNote('n4', 0, { isRest: true })],
    };
    const doc: ScoreDocument = {
      schemaVersion: 1,
      id: 'doc1',
      title: '测试',
      keySignature: 'C',
      timeSignature: '2/4',
      bpm: 90,
      viewMode: 'dual',
      measures: [m1, m2],
      updatedAtEpochMs: 1000,
    };

    const resolved = resolveScoreNotes(doc);
    expect(resolved.map((n) => n.startTickInScore)).toEqual([0, 480, 960, 1440]);
    expect(resolved[3]?.midiPitch).toBeNull();
    expect(resolved[3]?.stemDirection).toBeNull();

    const mRes = resolveMeasureNotes(m1, 'C', 0);
    expect(mRes).toHaveLength(2);
  });
});
