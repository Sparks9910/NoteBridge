import { createAppError } from './state-machines.ts';
import {
  KEY_BASE_MIDI_MAP,
  resolveNotePitch,
  VALID_KEY_SIGNATURES,
} from './theory.ts';
import type {
  Accidental,
  KeySignature,
  Measure,
  NoteEvent,
  Result,
  ScoreDocument,
} from './types.ts';

/** 移调策略：首调换调（唱名不变，改调号）或固定调移高（调号不变，重算音高） */
export type TransposeStrategy = 'movable-do' | 'fixed-pitch';

export interface TransposeOptions {
  strategy: TransposeStrategy;
  targetKey?: KeySignature;
  semitones?: number;
}

export const KEY_PITCH_CLASS_MAP: Record<KeySignature, number> = {
  C: 0,
  Db: 1,
  D: 2,
  Eb: 3,
  E: 4,
  F: 5,
  Gb: 6,
  G: 7,
  Ab: 8,
  A: 9,
  Bb: 10,
  B: 11,
};

export const PITCH_CLASS_TO_KEY: readonly KeySignature[] = [
  'C',
  'Db',
  'D',
  'Eb',
  'E',
  'F',
  'Gb',
  'G',
  'Ab',
  'A',
  'Bb',
  'B',
];

const FLAT_KEY_SET: ReadonlySet<KeySignature> = new Set([
  'F',
  'Bb',
  'Eb',
  'Ab',
  'Db',
  'Gb',
]);

const SHARP_SEMITONE_TABLE: Readonly<
  Record<number, { degree: 1 | 2 | 3 | 4 | 5 | 6 | 7; accidental: Accidental }>
> = {
  0: { degree: 1, accidental: null },
  1: { degree: 1, accidental: 'sharp' },
  2: { degree: 2, accidental: null },
  3: { degree: 2, accidental: 'sharp' },
  4: { degree: 3, accidental: null },
  5: { degree: 4, accidental: null },
  6: { degree: 4, accidental: 'sharp' },
  7: { degree: 5, accidental: null },
  8: { degree: 5, accidental: 'sharp' },
  9: { degree: 6, accidental: null },
  10: { degree: 6, accidental: 'sharp' },
  11: { degree: 7, accidental: null },
};

const FLAT_SEMITONE_TABLE: Readonly<
  Record<number, { degree: 1 | 2 | 3 | 4 | 5 | 6 | 7; accidental: Accidental }>
> = {
  0: { degree: 1, accidental: null },
  1: { degree: 2, accidental: 'flat' },
  2: { degree: 2, accidental: null },
  3: { degree: 3, accidental: 'flat' },
  4: { degree: 3, accidental: null },
  5: { degree: 4, accidental: null },
  6: { degree: 5, accidental: 'flat' },
  7: { degree: 5, accidental: null },
  8: { degree: 6, accidental: 'flat' },
  9: { degree: 6, accidental: null },
  10: { degree: 7, accidental: 'flat' },
  11: { degree: 7, accidental: null },
};

/** 计算从原调号到目标调号的最短半音差（范围 -5..+6） */
export function computeSemitoneDelta(
  fromKey: KeySignature,
  toKey: KeySignature
): number {
  const raw = (KEY_PITCH_CLASS_MAP[toKey] - KEY_PITCH_CLASS_MAP[fromKey] + 12) % 12;
  return raw > 6 ? raw - 12 : raw;
}

/** 根据半音偏移量推算目标大调调号 */
export function transposeKeySignature(
  fromKey: KeySignature,
  semitones: number
): KeySignature {
  const fromPc = KEY_PITCH_CLASS_MAP[fromKey];
  const nextPc = (((fromPc + semitones) % 12) + 12) % 12;
  return PITCH_CLASS_TO_KEY[nextPc] ?? 'C';
}

/** 将绝对 MIDI 音高按指定调号反解为简谱音级、安全八度偏移（-2..+2）与临时升降号 */
export function midiToJianpuNoteSpec(
  targetMidi: number,
  keySignature: KeySignature,
  preferFlat?: boolean
): {
  degree: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  octaveOffset: -2 | -1 | 0 | 1 | 2;
  accidental: Accidental;
} {
  const baseMidi = KEY_BASE_MIDI_MAP[keySignature];
  const rel = targetMidi - baseMidi;
  const rawOctave = Math.floor(rel / 12);
  const octaveOffset = Math.max(-2, Math.min(2, rawOctave)) as -2 | -1 | 0 | 1 | 2;
  const semitoneInOctave = Math.max(
    0,
    Math.min(11, targetMidi - (baseMidi + octaveOffset * 12))
  );

  const useFlat = preferFlat ?? FLAT_KEY_SET.has(keySignature);
  const table = useFlat ? FLAT_SEMITONE_TABLE : SHARP_SEMITONE_TABLE;
  const entry = table[semitoneInOctave] ?? { degree: 1 as const, accidental: null };

  return {
    degree: entry.degree,
    octaveOffset,
    accidental: entry.accidental,
  };
}

function clampMidiRange(midi: number): number {
  return Math.max(24, Math.min(108, midi));
}

/** 对整份乐谱执行一键移调，返回新的不可变 ScoreDocument */
export function transposeScoreDocument(
  doc: ScoreDocument,
  options: TransposeOptions
): Result<ScoreDocument> {
  if (
    options.targetKey !== undefined &&
    !VALID_KEY_SIGNATURES.includes(options.targetKey)
  ) {
    return {
      ok: false,
      error: createAppError(
        'SCORE_INVALID_KEY_SIGNATURE',
        '不支持的目标调号，请选择 12 个标准大调之一',
        'targetKey'
      ),
    };
  }

  if (
    options.semitones !== undefined &&
    (!Number.isInteger(options.semitones) ||
      options.semitones < -12 ||
      options.semitones > 12)
  ) {
    return {
      ok: false,
      error: createAppError(
        'SCORE_INVALID_KEY_SIGNATURE',
        '半音偏移量必须为 -12 到 +12 之间的整数',
        'semitones'
      ),
    };
  }

  if (options.strategy === 'movable-do') {
    const nextKey: KeySignature = options.targetKey
      ? options.targetKey
      : transposeKeySignature(doc.keySignature, options.semitones ?? 0);

    return {
      ok: true,
      value: {
        ...doc,
        keySignature: nextKey,
        measures: doc.measures.map((m) => ({
          ...m,
          notes: m.notes.map((n) => ({ ...n })),
        })),
      },
    };
  }

  // fixed-pitch：保持原调号不变，全谱绝对 MIDI 音高整体偏移并重算简谱音级
  const delta =
    options.semitones !== undefined
      ? options.semitones
      : options.targetKey
        ? computeSemitoneDelta(doc.keySignature, options.targetKey)
        : 0;

  if (delta === 0) {
    return {
      ok: true,
      value: {
        ...doc,
        measures: doc.measures.map((m) => ({
          ...m,
          notes: m.notes.map((n) => ({ ...n })),
        })),
      },
    };
  }

  const preferFlat = delta < 0;
  const nextMeasures: Measure[] = doc.measures.map((measure) => ({
    ...measure,
    notes: measure.notes.map((note): NoteEvent => {
      if (note.isRest || note.degree === 0) {
        return { ...note };
      }
      const resolved = resolveNotePitch(note, doc.keySignature);
      if (!resolved) {
        return { ...note };
      }
      const shiftedMidi = clampMidiRange(resolved.midiPitch + delta);
      const spec = midiToJianpuNoteSpec(shiftedMidi, doc.keySignature, preferFlat);
      return {
        ...note,
        degree: spec.degree,
        octaveOffset: spec.octaveOffset,
        accidental: spec.accidental,
      };
    }),
  }));

  return {
    ok: true,
    value: {
      ...doc,
      measures: nextMeasures,
    },
  };
}
