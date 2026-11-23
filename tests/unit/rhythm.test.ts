import { describe, expect, it } from 'vitest';
import {
  BASE_DURATION_TICKS,
  calculateDurationTicks,
  computeBeamGroups,
  getBeatTicks,
  getMeasureCapacityTicks,
  msToTicks,
  ticksToMs,
  validateMeasureRhythm,
} from '../../src/domain/rhythm.ts';
import {
  PPQ,
  type BaseDuration,
  type Measure,
  type NoteEvent,
} from '../../src/domain/types.ts';

function makeNote(
  id: string,
  baseDuration: BaseDuration,
  options?: { dotted?: boolean; isRest?: boolean }
): NoteEvent {
  const dotted = options?.dotted ?? false;
  const isRest = options?.isRest ?? false;
  return {
    id,
    isRest,
    degree: isRest ? 0 : 1,
    octaveOffset: 0,
    accidental: null,
    baseDuration,
    dotted,
    durationTicks: calculateDurationTicks(baseDuration, dotted),
  };
}

describe('rhythm - 480 Ticks 时值、小节容量、连杠与节拍换算', () => {
  it('PPQ=480 下的 5 种基础时值与附点时值均为精确整数', () => {
    expect(PPQ).toBe(480);
    expect(BASE_DURATION_TICKS).toEqual({
      whole: 1920,
      half: 960,
      quarter: 480,
      eighth: 240,
      sixteenth: 120,
    });

    expect(calculateDurationTicks('whole', true)).toBe(2880);
    expect(calculateDurationTicks('half', true)).toBe(1440);
    expect(calculateDurationTicks('quarter', true)).toBe(720);
    expect(calculateDurationTicks('eighth', true)).toBe(360);
    expect(calculateDurationTicks('sixteenth', true)).toBe(180);
  });

  it('4 种拍号小节容量与 EMPTY/UNDERFLOW/VALID/OVERFLOW 状态判定正确', () => {
    expect(getMeasureCapacityTicks('2/4')).toBe(960);
    expect(getMeasureCapacityTicks('3/4')).toBe(1440);
    expect(getMeasureCapacityTicks('4/4')).toBe(1920);
    expect(getMeasureCapacityTicks('6/8')).toBe(1440);

    const empty: Measure = { id: 'm1', index: 0, notes: [] };
    const rEmpty = validateMeasureRhythm(empty, '4/4');
    expect(rEmpty.ok && rEmpty.value.state).toBe('EMPTY');

    const under: Measure = {
      id: 'm2',
      index: 0,
      notes: [makeNote('n1', 'quarter'), makeNote('n2', 'half')],
    };
    const rUnder = validateMeasureRhythm(under, '4/4');
    expect(rUnder.ok && rUnder.value.state).toBe('UNDERFLOW');
    expect(rUnder.ok && rUnder.value.remainingTicks).toBe(480);

    const valid: Measure = {
      id: 'm3',
      index: 0,
      notes: [makeNote('n1', 'half', { dotted: true }), makeNote('n2', 'quarter')],
    };
    const rValid = validateMeasureRhythm(valid, '4/4');
    expect(rValid.ok && rValid.value.state).toBe('VALID');
    expect(rValid.ok && rValid.value.overflowTicks).toBe(0);

    const over: Measure = {
      id: 'm4',
      index: 0,
      notes: [makeNote('n1', 'whole'), makeNote('n2', 'eighth')],
    };
    const rOver = validateMeasureRhythm(over, '4/4');
    expect(rOver.ok && rOver.value.state).toBe('OVERFLOW');
    expect(rOver.ok && rOver.value.overflowTicks).toBe(240);
  });

  it('4/4 与 6/8 自动连杠分组不跨拍且遇休止符断裂', () => {
    expect(getBeatTicks('4/4')).toBe(480);
    expect(getBeatTicks('6/8')).toBe(720);

    const notes44 = [
      makeNote('a1', 'eighth'),
      makeNote('a2', 'eighth'),
      makeNote('b1', 'eighth'),
      makeNote('b2', 'eighth', { isRest: true }),
      makeNote('c1', 'sixteenth'),
      makeNote('c2', 'sixteenth'),
      makeNote('c3', 'eighth'),
    ];
    const groups44 = computeBeamGroups(notes44, '4/4');
    expect(groups44).toEqual([
      { noteIds: ['a1', 'a2'], indices: [0, 1], beatIndex: 0 },
      { noteIds: ['c1', 'c2', 'c3'], indices: [4, 5, 6], beatIndex: 2 },
    ]);

    const notes68 = [
      makeNote('x1', 'eighth'),
      makeNote('x2', 'eighth'),
      makeNote('x3', 'eighth'),
      makeNote('y1', 'eighth'),
      makeNote('y2', 'eighth'),
      makeNote('y3', 'eighth'),
    ];
    const groups68 = computeBeamGroups(notes68, '6/8');
    expect(groups68).toEqual([
      { noteIds: ['x1', 'x2', 'x3'], indices: [0, 1, 2], beatIndex: 0 },
      { noteIds: ['y1', 'y2', 'y3'], indices: [3, 4, 5], beatIndex: 1 },
    ]);
  });

  it('ticksToMs 与 msToTicks 在边界 BPM 下往返精确', () => {
    expect(ticksToMs(480, 120)).toBe(500);
    expect(ticksToMs(480, 60)).toBe(1000);
    expect(msToTicks(500, 120)).toBe(480);
    expect(ticksToMs(msToTicks(1250, 90), 90)).toBeCloseTo(1250, 8);
  });
});
