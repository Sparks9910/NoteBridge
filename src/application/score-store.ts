import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  calculateDurationTicks,
  type MeasureRhythmStatus,
  VALID_TIME_SIGNATURES,
  validateMeasureRhythm,
} from '../domain/rhythm.ts';
import {
  createAppError,
  createRequestId,
  transitionDocumentState,
} from '../domain/state-machines.ts';
import { resolveScoreNotes, VALID_KEY_SIGNATURES } from '../domain/theory.ts';
import {
  transposeScoreDocument,
  type TransposeOptions,
} from '../domain/transpose.ts';
import type {
  Accidental,
  AppError,
  BaseDuration,
  DocumentState,
  KeySignature,
  Measure,
  NoteEvent,
  ResolvedNote,
  Result,
  ScoreDocument,
  TimeSignature,
  ViewMode,
} from '../domain/types.ts';
import { appConfig, type AppConfig } from '../infrastructure/config.ts';
import {
  createStorageAdapter,
  type StorageAdapter,
} from '../infrastructure/storage-adapter.ts';

export const KEY_SIGNATURE_OPTIONS: readonly KeySignature[] =
  VALID_KEY_SIGNATURES;

export const TIME_SIGNATURE_OPTIONS: readonly TimeSignature[] =
  VALID_TIME_SIGNATURES;

export function resolveScoreForView(doc: ScoreDocument): ResolvedNote[] {
  return resolveScoreNotes(doc);
}

export interface CursorTarget {
  measureIndex: number;
  noteIndex: number;
}

export interface InsertNoteParams {
  measureIndex: number;
  noteIndex?: number;
  isRest: boolean;
  degree: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  octaveOffset: -2 | -1 | 0 | 1 | 2;
  accidental: Accidental;
  baseDuration: BaseDuration;
  dotted: boolean;
}

export interface InsertNoteResult {
  note: NoteEvent;
  measureStatus: MeasureRhythmStatus;
  autoCreatedMeasure: boolean;
  nextCursor: CursorTarget;
}

export interface DeleteNoteResult {
  deletedNoteId: string;
  measureStatus: MeasureRhythmStatus;
  nextCursor: CursorTarget;
}

export interface UpdateNotePatch {
  isRest?: boolean;
  degree?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  octaveOffset?: -2 | -1 | 0 | 1 | 2;
  accidental?: Accidental;
  baseDuration?: BaseDuration;
  dotted?: boolean;
}

export interface ScoreStoreDeps {
  storage?: StorageAdapter;
  config?: Pick<AppConfig, 'enableDemoMode' | 'defaultBpm'>;
  autoSaveDelayMs?: number;
  now?: () => number;
  idGenerator?: (prefix: string) => string;
}

export interface ScoreStoreState {
  document: ScoreDocument;
  documentState: DocumentState;
  measureStatuses: MeasureRhythmStatus[];
  past: ScoreDocument[];
  future: ScoreDocument[];
  canUndo: boolean;
  canRedo: boolean;
  lastError: AppError | null;
  lastSavedAtEpochMs: number | null;
  isDemoModeEnabled: boolean;

  createNewScore: (options?: { title?: string }) => Result<ScoreDocument>;
  setTitle: (title: string) => Result<ScoreDocument>;
  setKeySignature: (keySignature: KeySignature) => Result<ScoreDocument>;
  setTimeSignature: (timeSignature: TimeSignature) => Result<ScoreDocument>;
  setBpm: (bpm: number) => Result<ScoreDocument>;
  setViewMode: (viewMode: ViewMode) => Result<ViewMode>;
  insertNote: (params: InsertNoteParams) => Result<InsertNoteResult>;
  deleteNote: (
    measureIndex: number,
    noteIndex: number
  ) => Result<DeleteNoteResult>;
  deleteNoteById: (noteId: string) => Result<DeleteNoteResult>;
  updateNote: (
    measureIndex: number,
    noteIndex: number,
    patch: UpdateNotePatch
  ) => Result<NoteEvent>;
  insertMeasureBar: (
    afterMeasureIndex: number,
    splitAtNoteIndex?: number
  ) => Result<ScoreDocument>;
  transposeScore: (options: TransposeOptions) => Result<ScoreDocument>;
  loadExternalDocument: (doc: ScoreDocument) => Result<ScoreDocument>;
  undo: () => Result<ScoreDocument>;
  redo: () => Result<ScoreDocument>;
  saveNow: () => Result<ScoreDocument>;
  loadLastOpened: () => Result<ScoreDocument | null>;
  loadScoreById: (id: string) => Result<ScoreDocument>;
  loadDemoScore: () => Result<ScoreDocument>;
  clearError: () => void;
  dispose: () => void;
}

const MAX_HISTORY_SIZE = 100;
const VALID_VIEW_MODES: ReadonlySet<ViewMode> = new Set([
  'dual',
  'jianpu',
  'staff',
]);

function defaultIdGenerator(prefix: string): string {
  return `${prefix}_${createRequestId().slice(0, 8)}`;
}

function computeMeasureStatuses(doc: ScoreDocument): MeasureRhythmStatus[] {
  return doc.measures.map((measure) => {
    const res = validateMeasureRhythm(measure, doc.timeSignature);
    if (res.ok) {
      return res.value;
    }
    return {
      totalTicks: 0,
      capacityTicks: 1920,
      remainingTicks: 1920,
      overflowTicks: 0,
      state: 'EMPTY',
    };
  });
}

function cloneDocument(doc: ScoreDocument): ScoreDocument {
  return structuredClone(doc);
}

function createBlankDocument(
  defaultBpm: number,
  nowMs: number,
  idGen: (prefix: string) => string,
  title = '未命名曲谱'
): ScoreDocument {
  return {
    schemaVersion: 1,
    id: idGen('score'),
    title,
    keySignature: 'C',
    timeSignature: '4/4',
    bpm: defaultBpm,
    viewMode: 'dual',
    measures: [
      {
        id: idGen('m'),
        index: 0,
        notes: [],
      },
    ],
    updatedAtEpochMs: nowMs,
  };
}

/** 构造内置 12 小节《小星星》演示曲谱（1=C，4/4，每小节 1920 Ticks VALID） */
export function createDemoTwinkleScore(bpm = 90): ScoreDocument {
  const safeBpm = Number.isInteger(bpm) && bpm >= 40 && bpm <= 200 ? bpm : 90;
  const pattern: Array<Array<{ degree: 1 | 2 | 3 | 4 | 5 | 6; dur: BaseDuration }>> = [
    [
      { degree: 1, dur: 'quarter' },
      { degree: 1, dur: 'quarter' },
      { degree: 5, dur: 'quarter' },
      { degree: 5, dur: 'quarter' },
    ],
    [
      { degree: 6, dur: 'quarter' },
      { degree: 6, dur: 'quarter' },
      { degree: 5, dur: 'half' },
    ],
    [
      { degree: 4, dur: 'quarter' },
      { degree: 4, dur: 'quarter' },
      { degree: 3, dur: 'quarter' },
      { degree: 3, dur: 'quarter' },
    ],
    [
      { degree: 2, dur: 'quarter' },
      { degree: 2, dur: 'quarter' },
      { degree: 1, dur: 'half' },
    ],
    [
      { degree: 5, dur: 'quarter' },
      { degree: 5, dur: 'quarter' },
      { degree: 4, dur: 'quarter' },
      { degree: 4, dur: 'quarter' },
    ],
    [
      { degree: 3, dur: 'quarter' },
      { degree: 3, dur: 'quarter' },
      { degree: 2, dur: 'half' },
    ],
    [
      { degree: 5, dur: 'quarter' },
      { degree: 5, dur: 'quarter' },
      { degree: 4, dur: 'quarter' },
      { degree: 4, dur: 'quarter' },
    ],
    [
      { degree: 3, dur: 'quarter' },
      { degree: 3, dur: 'quarter' },
      { degree: 2, dur: 'half' },
    ],
    [
      { degree: 1, dur: 'quarter' },
      { degree: 1, dur: 'quarter' },
      { degree: 5, dur: 'quarter' },
      { degree: 5, dur: 'quarter' },
    ],
    [
      { degree: 6, dur: 'quarter' },
      { degree: 6, dur: 'quarter' },
      { degree: 5, dur: 'half' },
    ],
    [
      { degree: 4, dur: 'quarter' },
      { degree: 4, dur: 'quarter' },
      { degree: 3, dur: 'quarter' },
      { degree: 3, dur: 'quarter' },
    ],
    [
      { degree: 2, dur: 'quarter' },
      { degree: 2, dur: 'quarter' },
      { degree: 1, dur: 'half' },
    ],
  ];

  const measures: Measure[] = pattern.map((items, mIdx) => ({
    id: `demo_m_${mIdx + 1}`,
    index: mIdx,
    notes: items.map((item, nIdx) => ({
      id: `demo_n_${mIdx + 1}_${nIdx + 1}`,
      isRest: false,
      degree: item.degree,
      octaveOffset: 0,
      accidental: null,
      baseDuration: item.dur,
      dotted: false,
      durationTicks: calculateDurationTicks(item.dur, false),
    })),
  }));

  return {
    schemaVersion: 1,
    id: 'demo_twinkle_star',
    title: '小星星（演示曲谱）',
    keySignature: 'C',
    timeSignature: '4/4',
    bpm: safeBpm,
    viewMode: 'dual',
    measures,
    updatedAtEpochMs: Date.now(),
  };
}

export type ScoreStoreApi = StoreApi<ScoreStoreState>;

export function createScoreStore(deps?: ScoreStoreDeps): ScoreStoreApi {
  const storage = deps?.storage ?? createStorageAdapter();
  const config = deps?.config ?? appConfig;
  const autoSaveDelayMs = deps?.autoSaveDelayMs ?? 1200;
  const now = deps?.now ?? (() => Date.now());
  const idGen = deps?.idGenerator ?? defaultIdGenerator;

  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

  const clearAutoSaveTimer = () => {
    if (autoSaveTimer !== null) {
      globalThis.clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }
  };

  const initialDoc = createBlankDocument(config.defaultBpm, now(), idGen);

  return createStore<ScoreStoreState>((set, get) => {
    const scheduleAutoSave = () => {
      clearAutoSaveTimer();
      if (autoSaveDelayMs <= 0) {
        return;
      }
      autoSaveTimer = globalThis.setTimeout(() => {
        autoSaveTimer = null;
        get().saveNow();
      }, autoSaveDelayMs);
    };

    const commitMutation = (
      nextDoc: ScoreDocument,
      recordHistory = true
    ): Result<ScoreDocument> => {
      const current = get();
      const docStateRes = transitionDocumentState(
        current.documentState,
        'MUTATE_SCORE'
      );
      if (!docStateRes.ok) {
        set({ lastError: docStateRes.error });
        return docStateRes;
      }

      const stampedDoc: ScoreDocument = {
        ...nextDoc,
        updatedAtEpochMs: Math.trunc(now()),
      };

      const nextPast = recordHistory
        ? [...current.past.slice(-(MAX_HISTORY_SIZE - 1)), cloneDocument(current.document)]
        : current.past;

      set({
        document: stampedDoc,
        documentState: docStateRes.value,
        measureStatuses: computeMeasureStatuses(stampedDoc),
        past: nextPast,
        future: recordHistory ? [] : current.future,
        canUndo: nextPast.length > 0,
        canRedo: recordHistory ? false : current.future.length > 0,
        lastError: null,
      });

      scheduleAutoSave();
      return { ok: true, value: stampedDoc };
    };

    return {
      document: initialDoc,
      documentState: 'CLEAN',
      measureStatuses: computeMeasureStatuses(initialDoc),
      past: [],
      future: [],
      canUndo: false,
      canRedo: false,
      lastError: null,
      lastSavedAtEpochMs: null,
      isDemoModeEnabled: config.enableDemoMode,

      createNewScore: (options) => {
        clearAutoSaveTimer();
        const doc = createBlankDocument(
          config.defaultBpm,
          Math.trunc(now()),
          idGen,
          options?.title?.trim() || '未命名曲谱'
        );
        set({
          document: doc,
          documentState: 'CLEAN',
          measureStatuses: computeMeasureStatuses(doc),
          past: [],
          future: [],
          canUndo: false,
          canRedo: false,
          lastError: null,
        });
        return { ok: true, value: doc };
      },

      setTitle: (title) => {
        const current = get().document;
        return commitMutation({
          ...current,
          title,
        });
      },

      setKeySignature: (keySignature) => {
        if (!VALID_KEY_SIGNATURES.includes(keySignature)) {
          const err = createAppError(
            'SCORE_INVALID_KEY_SIGNATURE',
            '不支持的调号设置，请选择 12 个标准大调之一',
            'keySignature'
          );
          set({ lastError: err });
          return { ok: false, error: err };
        }
        const current = get().document;
        if (current.keySignature === keySignature) {
          return { ok: true, value: current };
        }
        return commitMutation({
          ...current,
          keySignature,
        });
      },

      setTimeSignature: (timeSignature) => {
        if (!VALID_TIME_SIGNATURES.includes(timeSignature)) {
          const err = createAppError(
            'SCORE_INVALID_TIME_SIGNATURE',
            '不支持的拍号设置，仅支持 2/4、3/4、4/4、6/8',
            'timeSignature'
          );
          set({ lastError: err });
          return { ok: false, error: err };
        }
        const current = get().document;
        if (current.timeSignature === timeSignature) {
          return { ok: true, value: current };
        }
        return commitMutation({
          ...current,
          timeSignature,
        });
      },

      setBpm: (bpm) => {
        if (!Number.isInteger(bpm) || bpm < 40 || bpm > 200) {
          const err = createAppError(
            'SCORE_INVALID_BPM',
            '速度 BPM 必须为 40 到 200 之间的整数',
            'bpm'
          );
          set({ lastError: err });
          return { ok: false, error: err };
        }
        const current = get().document;
        if (current.bpm === bpm) {
          return { ok: true, value: current };
        }
        return commitMutation({
          ...current,
          bpm,
        });
      },

      setViewMode: (viewMode) => {
        if (!VALID_VIEW_MODES.has(viewMode)) {
          const err = createAppError(
            'STATE_INVALID_TRANSITION',
            '不支持的谱面视图模式',
            'viewMode'
          );
          set({ lastError: err });
          return { ok: false, error: err };
        }
        const current = get().document;
        if (current.viewMode === viewMode) {
          return { ok: true, value: viewMode };
        }
        set({
          document: {
            ...current,
            viewMode,
          },
          lastError: null,
        });
        return { ok: true, value: viewMode };
      },

      insertNote: (params) => {
        const current = get().document;
        const targetMeasure = current.measures[params.measureIndex];
        if (!targetMeasure) {
          const err = createAppError(
            'SCORE_MEASURE_NOT_FOUND',
            `未找到第 ${params.measureIndex + 1} 小节，无法录入音符`,
            'measureIndex'
          );
          set({ lastError: err });
          return { ok: false, error: err };
        }

        if (!params.isRest && params.degree === 0) {
          const err = createAppError(
            'SCORE_INVALID_DURATION',
            '非休止符音符的音级必须为 1 到 7',
            'degree'
          );
          set({ lastError: err });
          return { ok: false, error: err };
        }

        const note: NoteEvent = {
          id: idGen('n'),
          isRest: params.isRest,
          degree: params.isRest ? 0 : params.degree,
          octaveOffset: params.isRest ? 0 : params.octaveOffset,
          accidental: params.isRest ? null : params.accidental,
          baseDuration: params.baseDuration,
          dotted: params.dotted,
          durationTicks: calculateDurationTicks(
            params.baseDuration,
            params.dotted
          ),
        };

        const rawIndex = params.noteIndex ?? targetMeasure.notes.length;
        const insertAt = Math.max(
          0,
          Math.min(rawIndex, targetMeasure.notes.length)
        );
        const updatedNotes = [...targetMeasure.notes];
        updatedNotes.splice(insertAt, 0, note);

        const nextMeasures: Measure[] = current.measures.map((m, idx) =>
          idx === params.measureIndex
            ? { ...m, notes: updatedNotes }
            : { ...m, notes: [...m.notes] }
        );

        const updatedTargetMeasure = nextMeasures[params.measureIndex];
        const statusRes = updatedTargetMeasure
          ? validateMeasureRhythm(updatedTargetMeasure, current.timeSignature)
          : null;
        const targetStatus: MeasureRhythmStatus =
          statusRes && statusRes.ok
            ? statusRes.value
            : {
                totalTicks: 0,
                capacityTicks: 1920,
                remainingTicks: 1920,
                overflowTicks: 0,
                state: 'EMPTY',
              };

        let autoCreatedMeasure = false;
        let nextCursor: CursorTarget = {
          measureIndex: params.measureIndex,
          noteIndex: insertAt + 1,
        };

        // 假设 A-07：小节满拍（VALID）自动开启下一小节；超拍（OVERFLOW）不阻断录入
        if (targetStatus.state === 'VALID') {
          if (params.measureIndex === nextMeasures.length - 1) {
            nextMeasures.push({
              id: idGen('m'),
              index: nextMeasures.length,
              notes: [],
            });
            autoCreatedMeasure = true;
            nextCursor = {
              measureIndex: params.measureIndex + 1,
              noteIndex: 0,
            };
          } else if (insertAt === updatedNotes.length - 1) {
            nextCursor = {
              measureIndex: params.measureIndex + 1,
              noteIndex: 0,
            };
          }
        }

        const mutateRes = commitMutation({
          ...current,
          measures: nextMeasures,
        });
        if (!mutateRes.ok) {
          return mutateRes;
        }

        return {
          ok: true,
          value: {
            note,
            measureStatus: targetStatus,
            autoCreatedMeasure,
            nextCursor,
          },
        };
      },

      deleteNote: (measureIndex, noteIndex) => {
        const current = get().document;
        const targetMeasure = current.measures[measureIndex];
        if (!targetMeasure) {
          const err = createAppError(
            'SCORE_MEASURE_NOT_FOUND',
            `未找到第 ${measureIndex + 1} 小节`,
            'measureIndex'
          );
          set({ lastError: err });
          return { ok: false, error: err };
        }
        const targetNote = targetMeasure.notes[noteIndex];
        if (!targetNote) {
          const err = createAppError(
            'RESOURCE_NOT_FOUND',
            '未找到要删除的音符',
            'noteIndex'
          );
          set({ lastError: err });
          return { ok: false, error: err };
        }

        const nextMeasures = current.measures.map((m, idx) => {
          if (idx !== measureIndex) {
            return { ...m, notes: [...m.notes] };
          }
          const copy = [...m.notes];
          copy.splice(noteIndex, 1);
          return { ...m, notes: copy };
        });

        const mutateRes = commitMutation({
          ...current,
          measures: nextMeasures,
        });
        if (!mutateRes.ok) {
          return mutateRes;
        }

        const updatedStatus = get().measureStatuses[measureIndex] ?? {
          totalTicks: 0,
          capacityTicks: 1920,
          remainingTicks: 1920,
          overflowTicks: 0,
          state: 'EMPTY',
        };

        return {
          ok: true,
          value: {
            deletedNoteId: targetNote.id,
            measureStatus: updatedStatus,
            nextCursor: {
              measureIndex,
              noteIndex: Math.max(0, noteIndex),
            },
          },
        };
      },

      deleteNoteById: (noteId) => {
        const current = get().document;
        for (let mIdx = 0; mIdx < current.measures.length; mIdx += 1) {
          const measure = current.measures[mIdx];
          if (!measure) {
            continue;
          }
          const nIdx = measure.notes.findIndex((n) => n.id === noteId);
          if (nIdx !== -1) {
            return get().deleteNote(mIdx, nIdx);
          }
        }
        const err = createAppError(
          'RESOURCE_NOT_FOUND',
          '未找到指定音符，可能已被删除',
          'noteId'
        );
        set({ lastError: err });
        return { ok: false, error: err };
      },

      updateNote: (measureIndex, noteIndex, patch) => {
        const current = get().document;
        const targetMeasure = current.measures[measureIndex];
        if (!targetMeasure) {
          const err = createAppError(
            'SCORE_MEASURE_NOT_FOUND',
            `未找到第 ${measureIndex + 1} 小节`,
            'measureIndex'
          );
          set({ lastError: err });
          return { ok: false, error: err };
        }
        const existing = targetMeasure.notes[noteIndex];
        if (!existing) {
          const err = createAppError(
            'RESOURCE_NOT_FOUND',
            '未找到要修改的音符',
            'noteIndex'
          );
          set({ lastError: err });
          return { ok: false, error: err };
        }

        const isRest = patch.isRest ?? existing.isRest;
        const degree = isRest ? 0 : (patch.degree ?? existing.degree);
        if (!isRest && degree === 0) {
          const err = createAppError(
            'SCORE_INVALID_DURATION',
            '非休止符音符的音级不能为 0',
            'degree'
          );
          set({ lastError: err });
          return { ok: false, error: err };
        }

        const baseDuration = patch.baseDuration ?? existing.baseDuration;
        const dotted = patch.dotted ?? existing.dotted;
        const updatedNote: NoteEvent = {
          id: existing.id,
          isRest,
          degree,
          octaveOffset: isRest ? 0 : (patch.octaveOffset ?? existing.octaveOffset),
          accidental: isRest
            ? null
            : patch.accidental !== undefined
              ? patch.accidental
              : existing.accidental,
          baseDuration,
          dotted,
          durationTicks: calculateDurationTicks(baseDuration, dotted),
        };

        const nextMeasures = current.measures.map((m, idx) => {
          if (idx !== measureIndex) {
            return { ...m, notes: [...m.notes] };
          }
          const copy = [...m.notes];
          copy[noteIndex] = updatedNote;
          return { ...m, notes: copy };
        });

        const mutateRes = commitMutation({
          ...current,
          measures: nextMeasures,
        });
        if (!mutateRes.ok) {
          return mutateRes;
        }
        return { ok: true, value: updatedNote };
      },

      insertMeasureBar: (afterMeasureIndex, splitAtNoteIndex) => {
        const current = get().document;
        const targetMeasure = current.measures[afterMeasureIndex];
        if (!targetMeasure) {
          const err = createAppError(
            'SCORE_MEASURE_NOT_FOUND',
            `未找到第 ${afterMeasureIndex + 1} 小节，无法插入小节线`,
            'afterMeasureIndex'
          );
          set({ lastError: err });
          return { ok: false, error: err };
        }

        const nextMeasures: Measure[] = [];
        for (let i = 0; i < current.measures.length; i += 1) {
          const m = current.measures[i];
          if (!m) {
            continue;
          }
          if (i !== afterMeasureIndex) {
            nextMeasures.push({ ...m, notes: [...m.notes] });
            continue;
          }

          if (
            splitAtNoteIndex !== undefined &&
            splitAtNoteIndex > 0 &&
            splitAtNoteIndex < m.notes.length
          ) {
            const headNotes = m.notes.slice(0, splitAtNoteIndex);
            const tailNotes = m.notes.slice(splitAtNoteIndex);
            nextMeasures.push({ ...m, notes: headNotes });
            nextMeasures.push({
              id: idGen('m'),
              index: 0,
              notes: tailNotes,
            });
          } else {
            nextMeasures.push({ ...m, notes: [...m.notes] });
            nextMeasures.push({
              id: idGen('m'),
              index: 0,
              notes: [],
            });
          }
        }

        const reindexed = nextMeasures.map((m, idx) => ({
          ...m,
          index: idx,
        }));

        return commitMutation({
          ...current,
          measures: reindexed,
        });
      },

      transposeScore: (options) => {
        const current = get().document;
        const res = transposeScoreDocument(current, options);
        if (!res.ok) {
          set({ lastError: res.error });
          return res;
        }
        return commitMutation(res.value);
      },

      loadExternalDocument: (doc) => {
        clearAutoSaveTimer();
        const cloned = cloneDocument(doc);
        const persistRes = storage.saveScore(cloned);
        set({
          document: cloned,
          documentState: persistRes.ok ? 'CLEAN' : 'SAVE_FAILED',
          measureStatuses: computeMeasureStatuses(cloned),
          past: [],
          future: [],
          canUndo: false,
          canRedo: false,
          lastError: persistRes.ok ? null : persistRes.error,
          lastSavedAtEpochMs: persistRes.ok ? Math.trunc(now()) : get().lastSavedAtEpochMs,
        });
        return { ok: true, value: cloned };
      },

      undo: () => {
        const current = get();
        if (current.past.length === 0) {
          const err = createAppError(
            'STATE_INVALID_TRANSITION',
            '当前没有可撤销的操作'
          );
          set({ lastError: err });
          return { ok: false, error: err };
        }

        const previous = current.past[current.past.length - 1];
        if (!previous) {
          const err = createAppError(
            'STATE_INVALID_TRANSITION',
            '撤销历史快照不可用'
          );
          set({ lastError: err });
          return { ok: false, error: err };
        }

        const docStateRes = transitionDocumentState(
          current.documentState,
          'MUTATE_SCORE'
        );
        if (!docStateRes.ok) {
          set({ lastError: docStateRes.error });
          return docStateRes;
        }

        const nextPast = current.past.slice(0, -1);
        const nextFuture = [cloneDocument(current.document), ...current.future];
        const restored: ScoreDocument = {
          ...cloneDocument(previous),
          viewMode: current.document.viewMode,
          updatedAtEpochMs: Math.trunc(now()),
        };

        set({
          document: restored,
          documentState: docStateRes.value,
          measureStatuses: computeMeasureStatuses(restored),
          past: nextPast,
          future: nextFuture,
          canUndo: nextPast.length > 0,
          canRedo: nextFuture.length > 0,
          lastError: null,
        });
        scheduleAutoSave();
        return { ok: true, value: restored };
      },

      redo: () => {
        const current = get();
        if (current.future.length === 0) {
          const err = createAppError(
            'STATE_INVALID_TRANSITION',
            '当前没有可重做的操作'
          );
          set({ lastError: err });
          return { ok: false, error: err };
        }

        const nextSnapshot = current.future[0];
        if (!nextSnapshot) {
          const err = createAppError(
            'STATE_INVALID_TRANSITION',
            '重做历史快照不可用'
          );
          set({ lastError: err });
          return { ok: false, error: err };
        }

        const docStateRes = transitionDocumentState(
          current.documentState,
          'MUTATE_SCORE'
        );
        if (!docStateRes.ok) {
          set({ lastError: docStateRes.error });
          return docStateRes;
        }

        const nextPast = [
          ...current.past.slice(-(MAX_HISTORY_SIZE - 1)),
          cloneDocument(current.document),
        ];
        const nextFuture = current.future.slice(1);
        const restored: ScoreDocument = {
          ...cloneDocument(nextSnapshot),
          viewMode: current.document.viewMode,
          updatedAtEpochMs: Math.trunc(now()),
        };

        set({
          document: restored,
          documentState: docStateRes.value,
          measureStatuses: computeMeasureStatuses(restored),
          past: nextPast,
          future: nextFuture,
          canUndo: nextPast.length > 0,
          canRedo: nextFuture.length > 0,
          lastError: null,
        });
        scheduleAutoSave();
        return { ok: true, value: restored };
      },

      saveNow: () => {
        clearAutoSaveTimer();
        let state = get().documentState;

        if (state === 'CLEAN') {
          const dirtyRes = transitionDocumentState(state, 'MUTATE_SCORE');
          if (!dirtyRes.ok) {
            set({ lastError: dirtyRes.error });
            return dirtyRes;
          }
          state = dirtyRes.value;
        }

        const savingRes = transitionDocumentState(state, 'BEGIN_SAVE');
        if (!savingRes.ok) {
          set({ lastError: savingRes.error });
          return savingRes;
        }
        set({ documentState: savingRes.value });

        const docToSave = get().document;
        const persistRes = storage.saveScore(docToSave);
        if (!persistRes.ok) {
          const failedRes = transitionDocumentState(
            'SAVING',
            'SAVE_FAILED_ERR'
          );
          set({
            documentState: failedRes.ok ? failedRes.value : 'SAVE_FAILED',
            lastError: persistRes.error,
          });
          return persistRes;
        }

        const cleanRes = transitionDocumentState('SAVING', 'SAVE_SUCCEEDED');
        const savedAt = Math.trunc(now());
        set({
          documentState: cleanRes.ok ? cleanRes.value : 'CLEAN',
          lastSavedAtEpochMs: savedAt,
          lastError: null,
        });
        return { ok: true, value: persistRes.value };
      },

      loadLastOpened: () => {
        clearAutoSaveTimer();
        const res = storage.loadLastOpenedScore();
        if (!res.ok) {
          set({ lastError: res.error });
          return res;
        }
        if (res.value === null) {
          return { ok: true, value: null };
        }
        set({
          document: res.value,
          documentState: 'CLEAN',
          measureStatuses: computeMeasureStatuses(res.value),
          past: [],
          future: [],
          canUndo: false,
          canRedo: false,
          lastError: null,
        });
        return { ok: true, value: res.value };
      },

      loadScoreById: (id) => {
        clearAutoSaveTimer();
        const res = storage.loadScore(id);
        if (!res.ok) {
          set({ lastError: res.error });
          return res;
        }
        set({
          document: res.value,
          documentState: 'CLEAN',
          measureStatuses: computeMeasureStatuses(res.value),
          past: [],
          future: [],
          canUndo: false,
          canRedo: false,
          lastError: null,
        });
        return { ok: true, value: res.value };
      },

      loadDemoScore: () => {
        if (!config.enableDemoMode) {
          const err = createAppError(
            'CONFIG_INVALID',
            '当前未启用演示模式，无法载入内置演示曲谱'
          );
          set({ lastError: err });
          return { ok: false, error: err };
        }
        clearAutoSaveTimer();
        const demoDoc = createDemoTwinkleScore(config.defaultBpm);
        set({
          document: demoDoc,
          documentState: 'CLEAN',
          measureStatuses: computeMeasureStatuses(demoDoc),
          past: [],
          future: [],
          canUndo: false,
          canRedo: false,
          lastError: null,
        });
        return { ok: true, value: demoDoc };
      },

      clearError: () => {
        set({ lastError: null });
      },

      dispose: () => {
        clearAutoSaveTimer();
      },
    };
  });
}

export const scoreStore: ScoreStoreApi = createScoreStore();

export function useScoreStore<T>(
  selector: (state: ScoreStoreState) => T,
  store: ScoreStoreApi = scoreStore
): T {
  return useStore(store, selector);
}
