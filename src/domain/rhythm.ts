import {
  PPQ,
  type BaseDuration,
  type Measure,
  type MeasureValidityState,
  type NoteEvent,
  type Result,
  type TimeSignature,
} from './types.ts';
import { transitionMeasureValidityState } from './state-machines.ts';

export const VALID_TIME_SIGNATURES: readonly TimeSignature[] = [
  '2/4',
  '3/4',
  '4/4',
  '6/8',
];

export const VALID_BASE_DURATIONS: readonly BaseDuration[] = [
  'whole',
  'half',
  'quarter',
  'eighth',
  'sixteenth',
];

/** 基于 PPQ = 480 的基础时值整数表 */
export const BASE_DURATION_TICKS: Record<BaseDuration, number> = {
  whole: PPQ * 4,
  half: PPQ * 2,
  quarter: PPQ,
  eighth: PPQ / 2,
  sixteenth: PPQ / 4,
};

const MEASURE_CAPACITY_TICKS: Record<TimeSignature, number> = {
  '2/4': PPQ * 2,
  '3/4': PPQ * 3,
  '4/4': PPQ * 4,
  '6/8': PPQ * 3,
};

const BEAT_TICKS_MAP: Record<TimeSignature, number> = {
  '2/4': PPQ,
  '3/4': PPQ,
  '4/4': PPQ,
  '6/8': (PPQ * 3) / 2, // 复二拍：3 个八分音符（720 ticks）为一大拍分组
};

export interface MeasureRhythmStatus {
  totalTicks: number;
  capacityTicks: number;
  remainingTicks: number;
  overflowTicks: number;
  state: MeasureValidityState;
}

export interface BeamGroup {
  noteIds: string[];
  indices: number[];
  beatIndex: number;
}

/** 计算基础时值与附点对应的整数 Ticks */
export function calculateDurationTicks(
  baseDuration: BaseDuration,
  dotted: boolean
): number {
  const base = BASE_DURATION_TICKS[baseDuration];
  return dotted ? (base * 3) / 2 : base;
}

/** 获取指定拍号的单小节总容量（Ticks） */
export function getMeasureCapacityTicks(timeSignature: TimeSignature): number {
  return MEASURE_CAPACITY_TICKS[timeSignature];
}

/** 获取指定拍号的连杠分组拍长（Ticks） */
export function getBeatTicks(timeSignature: TimeSignature): number {
  return BEAT_TICKS_MAP[timeSignature];
}

/** 汇总小节内所有音符/休止符的总 Ticks */
export function calculateMeasureTotalTicks(
  notes: readonly NoteEvent[]
): number {
  let sum = 0;
  for (const note of notes) {
    sum += note.durationTicks;
  }
  return sum;
}

/** 校验小节时值并返回小节时值状态 */
export function validateMeasureRhythm(
  measure: Measure,
  timeSignature: TimeSignature
): Result<MeasureRhythmStatus> {
  const capacityTicks = getMeasureCapacityTicks(timeSignature);
  const totalTicks = calculateMeasureTotalTicks(measure.notes);
  const stateRes = transitionMeasureValidityState('EMPTY', {
    type: 'RECALCULATE_MEASURE',
    totalTicks,
    capacityTicks,
  });

  if (!stateRes.ok) {
    return stateRes;
  }

  return {
    ok: true,
    value: {
      totalTicks,
      capacityTicks,
      remainingTicks: Math.max(0, capacityTicks - totalTicks),
      overflowTicks: Math.max(0, totalTicks - capacityTicks),
      state: stateRes.value,
    },
  };
}

function isBeamableNote(note: NoteEvent): boolean {
  return (
    !note.isRest &&
    (note.baseDuration === 'eighth' || note.baseDuration === 'sixteenth')
  );
}

/** 计算同拍内连续可连杠（八分/十六分非休止）音符分组 */
export function computeBeamGroups(
  notes: readonly NoteEvent[],
  timeSignature: TimeSignature
): BeamGroup[] {
  const beatTicks = getBeatTicks(timeSignature);
  const groups: BeamGroup[] = [];

  let currentTick = 0;
  let activeGroup: BeamGroup | null = null;

  for (let i = 0; i < notes.length; i += 1) {
    const note = notes[i];
    if (!note) {
      continue;
    }

    const startTick = currentTick;
    const endTick = startTick + note.durationTicks;
    const startBeat = Math.floor(startTick / beatTicks);
    const endBeat = Math.floor(Math.max(startTick, endTick - 1) / beatTicks);

    const beamable = isBeamableNote(note) && startBeat === endBeat;

    if (!beamable) {
      if (activeGroup && activeGroup.noteIds.length >= 2) {
        groups.push(activeGroup);
      }
      activeGroup = null;
      currentTick = endTick;
      continue;
    }

    if (activeGroup && activeGroup.beatIndex === startBeat) {
      activeGroup.noteIds.push(note.id);
      activeGroup.indices.push(i);
    } else {
      if (activeGroup && activeGroup.noteIds.length >= 2) {
        groups.push(activeGroup);
      }
      activeGroup = {
        noteIds: [note.id],
        indices: [i],
        beatIndex: startBeat,
      };
    }

    currentTick = endTick;
  }

  if (activeGroup && activeGroup.noteIds.length >= 2) {
    groups.push(activeGroup);
  }

  return groups;
}

/** 乐谱逻辑 Ticks 转毫秒 */
export function ticksToMs(ticks: number, bpm: number): number {
  return (ticks / PPQ) * (60000 / bpm);
}

/** 毫秒转乐谱逻辑 Ticks */
export function msToTicks(ms: number, bpm: number): number {
  return (ms / (60000 / bpm)) * PPQ;
}
