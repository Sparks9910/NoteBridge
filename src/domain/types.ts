/**
 * NoteBridge（音桥）GATE-0 共享数据结构、状态机类型与错误码契约
 * 严格对齐 docs/02-架构与契约.md 第二、三节
 */

/** 乐谱逻辑时值基准：每拍 480 Ticks */
export const PPQ = 480 as const;

/** 标准化全大写蛇形错误码 */
export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'STATE_INVALID_TRANSITION'
  | 'SCORE_INVALID_KEY_SIGNATURE'
  | 'SCORE_INVALID_TIME_SIGNATURE'
  | 'SCORE_INVALID_BPM'
  | 'SCORE_INVALID_DURATION'
  | 'SCORE_MEASURE_NOT_FOUND'
  | 'AUDIO_CONTEXT_BLOCKED'
  | 'AUDIO_SOUNDFONT_LOAD_FAILED'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'STORAGE_SCHEMA_CORRUPTED'
  | 'AUTH_UNAUTHORIZED'
  | 'AUTH_FORBIDDEN'
  | 'RESOURCE_NOT_FOUND';

/** 统一失败响应结构 */
export interface AppError {
  /** 面向中文用户的可读错误提示，禁止直接暴露英文堆栈 */
  detail: string;
  /** 标准化全大写蛇形错误码 */
  code: ErrorCode;
  /** UUID v4 追踪标识 */
  request_id: string;
  /** 可选，出错字段名 */
  field?: string;
}

/** 内部服务同步与异步接口统一判别联合返回 */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: AppError };

/** 支持的 12 个大调调号 */
export type KeySignature =
  | 'C'
  | 'G'
  | 'D'
  | 'A'
  | 'E'
  | 'B'
  | 'F'
  | 'Bb'
  | 'Eb'
  | 'Ab'
  | 'Db'
  | 'Gb';

/** 支持的拍号 */
export type TimeSignature = '2/4' | '3/4' | '4/4' | '6/8';

/** 谱面视图模式 */
export type ViewMode = 'dual' | 'jianpu' | 'staff';

/** 基础音符时值档位 */
export type BaseDuration = 'whole' | 'half' | 'quarter' | 'eighth' | 'sixteenth';

/** 临时升降号 */
export type Accidental = 'sharp' | 'flat' | 'natural' | null;

/** 音符或休止符事件 */
export interface NoteEvent {
  id: string;
  isRest: boolean;
  /** 简谱音级 1..7；0 仅当 isRest=true */
  degree: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /** 低音点负值，高音点正值 */
  octaveOffset: -2 | -1 | 0 | 1 | 2;
  accidental: Accidental;
  baseDuration: BaseDuration;
  dotted: boolean;
  /** 由 baseDuration + dotted 确定计算（整数 ticks） */
  durationTicks: number;
}

/** 小节 */
export interface Measure {
  id: string;
  index: number;
  notes: NoteEvent[];
}

/** 唯一权威数据源：Score AST 根文档 */
export interface ScoreDocument {
  schemaVersion: 1;
  id: string;
  title: string;
  keySignature: KeySignature;
  timeSignature: TimeSignature;
  /** 整数，范围 40..200 */
  bpm: number;
  viewMode: ViewMode;
  measures: Measure[];
  /** 整数 Unix 毫秒时间戳 */
  updatedAtEpochMs: number;
}

/** 乐理推导后的可渲染/可发声音符 */
export interface ResolvedNote {
  noteId: string;
  measureIndex: number;
  startTickInScore: number;
  durationTicks: number;
  /** 休止符为 null，音符为 0..127 */
  midiPitch: number | null;
  /** 如 "C/4"、"F#/5"，供 VexFlow 渲染 */
  staffPitchName: string | null;
  /** 结合调号与同小节上下文计算出的五线谱显示记号 */
  displayAccidental: Accidental;
  stemDirection: 'up' | 'down' | null;
}

/** 双谱共享横坐标布局槽位 */
export interface LayoutSlot {
  noteId: string;
  measureIndex: number;
  lineIndex: number;
  /** 双谱共享的绝对横坐标（px） */
  x: number;
  width: number;
}

/** 1. 音频播放状态机状态集 */
export type PlaybackState =
  | 'IDLE'
  | 'LOADING_AUDIO'
  | 'PLAYING'
  | 'PAUSED'
  | 'ERROR';

/** 2. 虚拟输入面板状态机状态集 */
export type InputPadState = 'READY' | 'MODIFIER_ARMED' | 'LOCKED_BY_PLAYBACK';

/** 3. 小节时值校验状态机状态集 */
export type MeasureValidityState = 'EMPTY' | 'UNDERFLOW' | 'VALID' | 'OVERFLOW';

/** 4. 工程文档持久化状态机状态集 */
export type DocumentState = 'CLEAN' | 'DIRTY' | 'SAVING' | 'SAVE_FAILED';
