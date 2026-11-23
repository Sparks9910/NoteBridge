import type { Accidental, KeySignature } from './types.ts';

export type StaffLetter = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
export type AccidentalOffset = -1 | 0 | 1;

export interface MeasureAccidentalItem {
  letter: StaffLetter;
  octave: number;
  effectiveOffset: AccidentalOffset;
}

export type MeasureAccidentalInput = MeasureAccidentalItem | null;

function createLetterMap(
  overrides: Partial<Record<StaffLetter, AccidentalOffset>>
): Record<StaffLetter, AccidentalOffset> {
  return {
    C: overrides.C ?? 0,
    D: overrides.D ?? 0,
    E: overrides.E ?? 0,
    F: overrides.F ?? 0,
    G: overrides.G ?? 0,
    A: overrides.A ?? 0,
    B: overrides.B ?? 0,
  };
}

/** 12 个大调调号在五线谱各音名上的默认升降偏移 */
export const KEY_SIGNATURE_ACCIDENTALS: Record<
  KeySignature,
  Record<StaffLetter, AccidentalOffset>
> = {
  C: createLetterMap({}),
  G: createLetterMap({ F: 1 }),
  D: createLetterMap({ F: 1, C: 1 }),
  A: createLetterMap({ F: 1, C: 1, G: 1 }),
  E: createLetterMap({ F: 1, C: 1, G: 1, D: 1 }),
  B: createLetterMap({ F: 1, C: 1, G: 1, D: 1, A: 1 }),
  F: createLetterMap({ B: -1 }),
  Bb: createLetterMap({ B: -1, E: -1 }),
  Eb: createLetterMap({ B: -1, E: -1, A: -1 }),
  Ab: createLetterMap({ B: -1, E: -1, A: -1, D: -1 }),
  Db: createLetterMap({ B: -1, E: -1, A: -1, D: -1, G: -1 }),
  Gb: createLetterMap({ B: -1, E: -1, A: -1, D: -1, G: -1, C: -1 }),
};

const KEY_ACCIDENTAL_COUNTS: Record<KeySignature, number> = {
  C: 0,
  G: 1,
  D: 2,
  A: 3,
  E: 4,
  B: 5,
  F: 1,
  Bb: 2,
  Eb: 3,
  Ab: 4,
  Db: 5,
  Gb: 6,
};

/** 获取调号在谱首占用的升降号个数 */
export function getKeySignatureAccidentalCount(
  keySignature: KeySignature
): number {
  return KEY_ACCIDENTAL_COUNTS[keySignature];
}

/** 将升降偏移值转换为标准临时记号枚举 */
export function offsetToAccidental(
  offset: AccidentalOffset
): Exclude<Accidental, null> {
  if (offset === 1) {
    return 'sharp';
  }
  if (offset === -1) {
    return 'flat';
  }
  return 'natural';
}

/**
 * 计算单小节内每个音符在五线谱上应显示的临时升降/还原记号。
 * 规则：同小节、同音名、同八度共享临时升降号状态，跨小节自动重置为调号默认状态。
 */
export function computeMeasureDisplayAccidentals(
  keySignature: KeySignature,
  items: readonly MeasureAccidentalInput[]
): Accidental[] {
  const keyMap = KEY_SIGNATURE_ACCIDENTALS[keySignature];
  const activeState = new Map<string, AccidentalOffset>();
  const result: Accidental[] = [];

  for (const item of items) {
    if (!item) {
      result.push(null);
      continue;
    }
    const pitchKey = `${item.letter}/${item.octave}`;
    const currentOffset = activeState.get(pitchKey) ?? keyMap[item.letter];
    if (item.effectiveOffset === currentOffset) {
      result.push(null);
    } else {
      result.push(offsetToAccidental(item.effectiveOffset));
      activeState.set(pitchKey, item.effectiveOffset);
    }
  }

  return result;
}
