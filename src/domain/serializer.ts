import type {
  Accidental,
  BaseDuration,
  KeySignature,
  Measure,
  NoteEvent,
  Result,
  ScoreDocument,
  TimeSignature,
  ViewMode,
} from './types.ts';
import {
  calculateDurationTicks,
  VALID_BASE_DURATIONS,
  VALID_TIME_SIGNATURES,
} from './rhythm.ts';
import { VALID_KEY_SIGNATURES } from './theory.ts';
import { createAppError, createRequestId } from './state-machines.ts';

export { createAppError, createRequestId };

const VALID_VIEW_MODES: readonly ViewMode[] = ['dual', 'jianpu', 'staff'];
const VALID_ACCIDENTALS: ReadonlySet<Accidental> = new Set([
  'sharp',
  'flat',
  'natural',
  null,
]);
const VALID_OCTAVE_OFFSETS: ReadonlySet<number> = new Set([-2, -1, 0, 1, 2]);
const VALID_DEGREES: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 5, 6, 7]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failSchema<T>(
  code:
    | 'STORAGE_SCHEMA_CORRUPTED'
    | 'SCORE_INVALID_KEY_SIGNATURE'
    | 'SCORE_INVALID_TIME_SIGNATURE'
    | 'SCORE_INVALID_BPM'
    | 'SCORE_INVALID_DURATION',
  detail: string,
  field?: string
): Result<T> {
  return {
    ok: false,
    error: createAppError(code, detail, field),
  };
}

function validateNoteEvent(
  raw: unknown,
  measureIdx: number,
  noteIdx: number
): Result<NoteEvent> {
  const path = `measures[${measureIdx}].notes[${noteIdx}]`;
  if (!isRecord(raw)) {
    return failSchema('STORAGE_SCHEMA_CORRUPTED', '乐谱音符节点格式损坏', path);
  }

  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
    return failSchema('STORAGE_SCHEMA_CORRUPTED', '音符缺少有效的唯一标识', `${path}.id`);
  }
  if (typeof raw.isRest !== 'boolean') {
    return failSchema('STORAGE_SCHEMA_CORRUPTED', '音符休止标记必须为布尔值', `${path}.isRest`);
  }
  if (typeof raw.degree !== 'number' || !VALID_DEGREES.has(raw.degree)) {
    return failSchema('STORAGE_SCHEMA_CORRUPTED', '音符音级必须为 0 到 7 的整数', `${path}.degree`);
  }
  if (raw.isRest && raw.degree !== 0) {
    return failSchema('STORAGE_SCHEMA_CORRUPTED', '休止符的音级必须为 0', `${path}.degree`);
  }
  if (!raw.isRest && raw.degree === 0) {
    return failSchema('STORAGE_SCHEMA_CORRUPTED', '非休止音符的音级不能为 0', `${path}.degree`);
  }

  if (
    typeof raw.octaveOffset !== 'number' ||
    !VALID_OCTAVE_OFFSETS.has(raw.octaveOffset)
  ) {
    return failSchema('STORAGE_SCHEMA_CORRUPTED', '音符八度偏移必须为 -2 到 2 的整数', `${path}.octaveOffset`);
  }
  if (raw.isRest && raw.octaveOffset !== 0) {
    return failSchema('STORAGE_SCHEMA_CORRUPTED', '休止符的八度偏移必须为 0', `${path}.octaveOffset`);
  }

  if (!VALID_ACCIDENTALS.has(raw.accidental as Accidental)) {
    return failSchema('STORAGE_SCHEMA_CORRUPTED', '音符临时升降号类型无效', `${path}.accidental`);
  }
  if (raw.isRest && raw.accidental !== null) {
    return failSchema('STORAGE_SCHEMA_CORRUPTED', '休止符不允许设置临时升降号', `${path}.accidental`);
  }

  if (
    typeof raw.baseDuration !== 'string' ||
    !VALID_BASE_DURATIONS.includes(raw.baseDuration as BaseDuration)
  ) {
    return failSchema('SCORE_INVALID_DURATION', '音符基础时值档位无效', `${path}.baseDuration`);
  }
  if (typeof raw.dotted !== 'boolean') {
    return failSchema('SCORE_INVALID_DURATION', '音符附点标记必须为布尔值', `${path}.dotted`);
  }

  const expectedTicks = calculateDurationTicks(
    raw.baseDuration as BaseDuration,
    raw.dotted
  );
  if (
    typeof raw.durationTicks !== 'number' ||
    !Number.isInteger(raw.durationTicks) ||
    raw.durationTicks !== expectedTicks
  ) {
    return failSchema(
      'SCORE_INVALID_DURATION',
      `音符时值数值异常，期望 ${expectedTicks} Ticks`,
      `${path}.durationTicks`
    );
  }

  return {
    ok: true,
    value: {
      id: raw.id,
      isRest: raw.isRest,
      degree: raw.degree as NoteEvent['degree'],
      octaveOffset: raw.octaveOffset as NoteEvent['octaveOffset'],
      accidental: raw.accidental as Accidental,
      baseDuration: raw.baseDuration as BaseDuration,
      dotted: raw.dotted,
      durationTicks: raw.durationTicks,
    },
  };
}

function validateMeasure(raw: unknown, idx: number): Result<Measure> {
  const path = `measures[${idx}]`;
  if (!isRecord(raw)) {
    return failSchema('STORAGE_SCHEMA_CORRUPTED', '乐谱小节数据结构损坏', path);
  }
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
    return failSchema('STORAGE_SCHEMA_CORRUPTED', '小节缺少有效的唯一标识', `${path}.id`);
  }
  if (
    typeof raw.index !== 'number' ||
    !Number.isInteger(raw.index) ||
    raw.index < 0
  ) {
    return failSchema('STORAGE_SCHEMA_CORRUPTED', '小节序号必须为非负整数', `${path}.index`);
  }
  if (!Array.isArray(raw.notes)) {
    return failSchema('STORAGE_SCHEMA_CORRUPTED', '小节音符列表格式损坏', `${path}.notes`);
  }

  const notes: NoteEvent[] = [];
  for (let i = 0; i < raw.notes.length; i += 1) {
    const noteRes = validateNoteEvent(raw.notes[i], idx, i);
    if (!noteRes.ok) {
      return noteRes;
    }
    notes.push(noteRes.value);
  }

  return {
    ok: true,
    value: {
      id: raw.id,
      index: raw.index,
      notes,
    },
  };
}

/** 校验任意未知数据是否符合 ScoreDocument Schema 契约 */
export function validateScoreDocument(input: unknown): Result<ScoreDocument> {
  if (!isRecord(input)) {
    return failSchema('STORAGE_SCHEMA_CORRUPTED', '乐谱数据根对象格式无效');
  }
  if (input.schemaVersion !== 1) {
    return failSchema(
      'STORAGE_SCHEMA_CORRUPTED',
      '不支持的乐谱数据结构版本，仅支持版本 1',
      'schemaVersion'
    );
  }
  if (typeof input.id !== 'string' || input.id.trim().length === 0) {
    return failSchema('STORAGE_SCHEMA_CORRUPTED', '乐谱缺少有效的唯一标识', 'id');
  }
  if (typeof input.title !== 'string') {
    return failSchema('STORAGE_SCHEMA_CORRUPTED', '乐谱标题必须为字符串', 'title');
  }
  if (
    typeof input.keySignature !== 'string' ||
    !VALID_KEY_SIGNATURES.includes(input.keySignature as KeySignature)
  ) {
    return failSchema(
      'SCORE_INVALID_KEY_SIGNATURE',
      '不支持的调号设置，请使用 12 个标准大调调号之一',
      'keySignature'
    );
  }
  if (
    typeof input.timeSignature !== 'string' ||
    !VALID_TIME_SIGNATURES.includes(input.timeSignature as TimeSignature)
  ) {
    return failSchema(
      'SCORE_INVALID_TIME_SIGNATURE',
      '不支持的拍号设置，仅支持 2/4、3/4、4/4、6/8',
      'timeSignature'
    );
  }
  if (
    typeof input.bpm !== 'number' ||
    !Number.isInteger(input.bpm) ||
    input.bpm < 40 ||
    input.bpm > 200
  ) {
    return failSchema(
      'SCORE_INVALID_BPM',
      '速度 BPM 必须为 40 到 200 之间的整数',
      'bpm'
    );
  }
  if (
    typeof input.viewMode !== 'string' ||
    !VALID_VIEW_MODES.includes(input.viewMode as ViewMode)
  ) {
    return failSchema('STORAGE_SCHEMA_CORRUPTED', '谱面视图模式无效', 'viewMode');
  }
  if (
    typeof input.updatedAtEpochMs !== 'number' ||
    !Number.isInteger(input.updatedAtEpochMs) ||
    input.updatedAtEpochMs < 0
  ) {
    return failSchema(
      'STORAGE_SCHEMA_CORRUPTED',
      '乐谱更新时间戳必须为非负整数毫秒',
      'updatedAtEpochMs'
    );
  }
  if (!Array.isArray(input.measures) || input.measures.length === 0) {
    return failSchema(
      'STORAGE_SCHEMA_CORRUPTED',
      '乐谱至少需要包含一个小节',
      'measures'
    );
  }

  const measures: Measure[] = [];
  for (let i = 0; i < input.measures.length; i += 1) {
    const measureRes = validateMeasure(input.measures[i], i);
    if (!measureRes.ok) {
      return measureRes;
    }
    measures.push(measureRes.value);
  }

  return {
    ok: true,
    value: {
      schemaVersion: 1,
      id: input.id,
      title: input.title,
      keySignature: input.keySignature as KeySignature,
      timeSignature: input.timeSignature as TimeSignature,
      bpm: input.bpm,
      viewMode: input.viewMode as ViewMode,
      measures,
      updatedAtEpochMs: input.updatedAtEpochMs,
    },
  };
}

/** 序列化 ScoreDocument 为 JSON 字符串（先执行 Schema 校验） */
export function serializeScoreDocument(doc: ScoreDocument): Result<string> {
  const validated = validateScoreDocument(doc);
  if (!validated.ok) {
    return validated;
  }
  try {
    return { ok: true, value: JSON.stringify(validated.value) };
  } catch {
    return failSchema('STORAGE_SCHEMA_CORRUPTED', '乐谱数据序列化失败');
  }
}

/** 反序列化 JSON 字符串为经过校验的 ScoreDocument */
export function deserializeScoreDocument(raw: string): Result<ScoreDocument> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return failSchema('STORAGE_SCHEMA_CORRUPTED', '乐谱存储内容为空，无法解析');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failSchema('STORAGE_SCHEMA_CORRUPTED', '乐谱 JSON 格式已损坏，无法解析');
  }
  return validateScoreDocument(parsed);
}
