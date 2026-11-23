import { describe, expect, it } from 'vitest';
import {
  computeMeasureDisplayAccidentals,
  getKeySignatureAccidentalCount,
  KEY_SIGNATURE_ACCIDENTALS,
} from '../../src/domain/accidental.ts';

describe('accidental - 同小节临时升降号与还原号作用域', () => {
  it('12 个大调调号升降表数量与音名准确', () => {
    expect(getKeySignatureAccidentalCount('C')).toBe(0);
    expect(getKeySignatureAccidentalCount('G')).toBe(1);
    expect(getKeySignatureAccidentalCount('B')).toBe(5);
    expect(getKeySignatureAccidentalCount('Gb')).toBe(6);

    expect(KEY_SIGNATURE_ACCIDENTALS.G.F).toBe(1);
    expect(KEY_SIGNATURE_ACCIDENTALS.Bb.B).toBe(-1);
    expect(KEY_SIGNATURE_ACCIDENTALS.Bb.E).toBe(-1);
  });

  it('同小节同八度重复临时记号自动去重，还原后再次升降显式标注', () => {
    const result = computeMeasureDisplayAccidentals('C', [
      { letter: 'F', octave: 4, effectiveOffset: 1 }, // #F4 -> 显示 sharp
      { letter: 'F', octave: 4, effectiveOffset: 1 }, // 同小节同八度仍为 #F4 -> null
      { letter: 'F', octave: 5, effectiveOffset: 1 }, // 不同八度 #F5 -> sharp
      { letter: 'F', octave: 4, effectiveOffset: 0 }, // 还原 F4 -> natural
      { letter: 'F', octave: 4, effectiveOffset: 0 }, // 仍为还原 F4 -> null
    ]);
    expect(result).toEqual(['sharp', null, 'sharp', 'natural', null]);
  });

  it('调号自带升降音无需显示记号，被临时还原后在同一小节恢复需再标升降', () => {
    // G 调 F5 默认为 #F5
    const gMajorMeasure = computeMeasureDisplayAccidentals('G', [
      { letter: 'F', octave: 5, effectiveOffset: 1 }, // 符合调号 -> null
      { letter: 'F', octave: 5, effectiveOffset: 0 }, // 临时还原 -> natural
      { letter: 'F', octave: 5, effectiveOffset: 1 }, // 恢复 #F5 -> sharp
      null, // 休止符不影响状态 -> null
    ]);
    expect(gMajorMeasure).toEqual([null, 'natural', 'sharp', null]);

    // 跨小节后自动重置回调号默认状态
    const nextMeasure = computeMeasureDisplayAccidentals('G', [
      { letter: 'F', octave: 5, effectiveOffset: 1 },
    ]);
    expect(nextMeasure).toEqual([null]);
  });
});
