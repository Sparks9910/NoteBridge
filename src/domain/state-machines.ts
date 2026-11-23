import type {
  AppError,
  DocumentState,
  ErrorCode,
  InputPadState,
  MeasureValidityState,
  PlaybackState,
  Result,
} from './types.ts';

export type PlaybackEvent =
  | 'START_PLAY'
  | 'AUDIO_READY'
  | 'AUDIO_FAILED'
  | 'PAUSE'
  | 'RESUME'
  | 'STOP'
  | 'PLAY_COMPLETE'
  | 'RESET_ERROR';

export type InputPadEvent =
  | 'ARM_MODIFIER'
  | 'CLEAR_MODIFIER'
  | 'COMMIT_NOTE'
  | 'LOCK'
  | 'UNLOCK';

export interface MeasureValidityEvent {
  type: 'RECALCULATE_MEASURE';
  totalTicks: number;
  capacityTicks: number;
}

export type DocumentEvent =
  | 'MUTATE_SCORE'
  | 'BEGIN_SAVE'
  | 'SAVE_SUCCEEDED'
  | 'SAVE_FAILED_ERR';

const VALID_PLAYBACK_STATES: ReadonlySet<PlaybackState> = new Set([
  'IDLE',
  'LOADING_AUDIO',
  'PLAYING',
  'PAUSED',
  'ERROR',
]);

const VALID_INPUT_PAD_STATES: ReadonlySet<InputPadState> = new Set([
  'READY',
  'MODIFIER_ARMED',
  'LOCKED_BY_PLAYBACK',
]);

const VALID_MEASURE_VALIDITY_STATES: ReadonlySet<MeasureValidityState> = new Set([
  'EMPTY',
  'UNDERFLOW',
  'VALID',
  'OVERFLOW',
]);

const VALID_DOCUMENT_STATES: ReadonlySet<DocumentState> = new Set([
  'CLEAN',
  'DIRTY',
  'SAVING',
  'SAVE_FAILED',
]);

const HEX = '0123456789abcdef';

/** 生成符合 RFC 4122 UUID v4 规范的追踪标识 */
export function createRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  const b6 = bytes[6] ?? 0;
  const b8 = bytes[8] ?? 0;
  bytes[6] = (b6 & 0x0f) | 0x40;
  bytes[8] = (b8 & 0x3f) | 0x80;

  let out = '';
  for (let i = 0; i < 16; i += 1) {
    if (i === 4 || i === 6 || i === 8 || i === 10) {
      out += '-';
    }
    const byte = bytes[i] ?? 0;
    out += (HEX[(byte >> 4) & 0x0f] ?? '0') + (HEX[byte & 0x0f] ?? '0');
  }
  return out;
}

/** 构造面向中文用户的统一错误对象 */
export function createAppError(
  code: ErrorCode,
  detail: string,
  field?: string
): AppError {
  return {
    detail,
    code,
    request_id: createRequestId(),
    ...(field !== undefined ? { field } : {}),
  };
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T>(
  code: ErrorCode,
  detail: string,
  field?: string
): Result<T> {
  return { ok: false, error: createAppError(code, detail, field) };
}

const PLAYBACK_TRANSITIONS: Record<
  PlaybackState,
  Partial<Record<PlaybackEvent, PlaybackState>>
> = {
  IDLE: {
    START_PLAY: 'LOADING_AUDIO',
  },
  LOADING_AUDIO: {
    AUDIO_READY: 'PLAYING',
    AUDIO_FAILED: 'ERROR',
    STOP: 'IDLE',
  },
  PLAYING: {
    PAUSE: 'PAUSED',
    STOP: 'IDLE',
    AUDIO_FAILED: 'ERROR',
  },
  PAUSED: {
    RESUME: 'PLAYING',
    STOP: 'IDLE',
  },
  ERROR: {
    RESET_ERROR: 'IDLE',
  },
};

/** 1. 音频播放状态机流转 */
export function transitionPlaybackState(
  current: PlaybackState,
  event: PlaybackEvent,
  options?: { loop?: boolean }
): Result<PlaybackState> {
  if (!VALID_PLAYBACK_STATES.has(current)) {
    return fail('STATE_INVALID_TRANSITION', '当前播放状态无效，无法执行状态流转', 'playbackState');
  }

  if (current === 'PLAYING' && event === 'PLAY_COMPLETE') {
    return ok(options?.loop ? 'PLAYING' : 'IDLE');
  }

  const next = PLAYBACK_TRANSITIONS[current][event];
  if (!next) {
    return fail(
      'STATE_INVALID_TRANSITION',
      `当前播放状态不允许执行该操作（状态：${current}，操作：${event}）`,
      'playbackState'
    );
  }
  return ok(next);
}

const INPUT_PAD_TRANSITIONS: Record<
  InputPadState,
  Partial<Record<InputPadEvent, InputPadState>>
> = {
  READY: {
    ARM_MODIFIER: 'MODIFIER_ARMED',
    COMMIT_NOTE: 'READY',
    LOCK: 'LOCKED_BY_PLAYBACK',
  },
  MODIFIER_ARMED: {
    ARM_MODIFIER: 'MODIFIER_ARMED',
    CLEAR_MODIFIER: 'READY',
    COMMIT_NOTE: 'READY',
    LOCK: 'LOCKED_BY_PLAYBACK',
  },
  LOCKED_BY_PLAYBACK: {
    UNLOCK: 'READY',
  },
};

/** 2. 虚拟输入面板状态机流转 */
export function transitionInputPadState(
  current: InputPadState,
  event: InputPadEvent
): Result<InputPadState> {
  if (!VALID_INPUT_PAD_STATES.has(current)) {
    return fail('STATE_INVALID_TRANSITION', '当前输入面板状态无效，无法执行流转', 'inputPadState');
  }
  const next = INPUT_PAD_TRANSITIONS[current][event];
  if (!next) {
    return fail(
      'STATE_INVALID_TRANSITION',
      current === 'LOCKED_BY_PLAYBACK'
        ? '播放期间虚拟输入面板已锁定，请先停止播放后再录入或修改音符'
        : `当前输入面板状态不允许执行该操作（状态：${current}，操作：${event}）`,
      'inputPadState'
    );
  }
  return ok(next);
}

/** 3. 小节时值校验状态机流转 */
export function transitionMeasureValidityState(
  current: MeasureValidityState,
  event: MeasureValidityEvent
): Result<MeasureValidityState> {
  if (!VALID_MEASURE_VALIDITY_STATES.has(current)) {
    return fail('STATE_INVALID_TRANSITION', '当前小节校验状态无效', 'measureValidityState');
  }
  if (!event || event.type !== 'RECALCULATE_MEASURE') {
    return fail('STATE_INVALID_TRANSITION', '小节校验仅支持重算事件', 'event');
  }
  const { totalTicks, capacityTicks } = event;
  if (
    !Number.isInteger(totalTicks) ||
    !Number.isInteger(capacityTicks) ||
    totalTicks < 0 ||
    capacityTicks <= 0
  ) {
    return fail(
      'SCORE_INVALID_DURATION',
      '小节总时值必须为非负整数且小节容量必须为正整数',
      'durationTicks'
    );
  }

  if (totalTicks === 0) {
    return ok('EMPTY');
  }
  if (totalTicks < capacityTicks) {
    return ok('UNDERFLOW');
  }
  if (totalTicks === capacityTicks) {
    return ok('VALID');
  }
  return ok('OVERFLOW');
}

const DOCUMENT_TRANSITIONS: Record<
  DocumentState,
  Partial<Record<DocumentEvent, DocumentState>>
> = {
  CLEAN: {
    MUTATE_SCORE: 'DIRTY',
  },
  DIRTY: {
    MUTATE_SCORE: 'DIRTY',
    BEGIN_SAVE: 'SAVING',
  },
  SAVING: {
    SAVE_SUCCEEDED: 'CLEAN',
    SAVE_FAILED_ERR: 'SAVE_FAILED',
  },
  SAVE_FAILED: {
    MUTATE_SCORE: 'DIRTY',
    BEGIN_SAVE: 'SAVING',
  },
};

/** 4. 工程文档持久化状态机流转 */
export function transitionDocumentState(
  current: DocumentState,
  event: DocumentEvent
): Result<DocumentState> {
  if (!VALID_DOCUMENT_STATES.has(current)) {
    return fail('STATE_INVALID_TRANSITION', '当前文档保存状态无效', 'documentState');
  }
  const next = DOCUMENT_TRANSITIONS[current][event];
  if (!next) {
    return fail(
      'STATE_INVALID_TRANSITION',
      `当前文档状态不允许执行该操作（状态：${current}，操作：${event}）`,
      'documentState'
    );
  }
  return ok(next);
}
