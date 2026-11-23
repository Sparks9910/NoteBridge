import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { transitionInputPadState } from '../domain/state-machines.ts';
import type {
  Accidental,
  AppError,
  BaseDuration,
  InputPadState,
  Result,
} from '../domain/types.ts';

export interface InputCursor {
  measureIndex: number;
  noteIndex: number;
  selectedNoteId: string | null;
}

export interface CommittedNoteSpec {
  baseDuration: BaseDuration;
  accidental: Accidental;
  octaveOffset: -2 | -1 | 0 | 1 | 2;
  dotted: boolean;
}

export interface InputStoreState {
  padState: InputPadState;
  baseDuration: BaseDuration;
  accidental: Accidental;
  octaveOffset: -2 | -1 | 0 | 1 | 2;
  dotted: boolean;
  cursor: InputCursor;
  lastError: AppError | null;

  setBaseDuration: (duration: BaseDuration) => Result<BaseDuration>;
  setAccidental: (accidental: Accidental) => Result<InputPadState>;
  toggleAccidental: (
    accidental: Exclude<Accidental, null>
  ) => Result<InputPadState>;
  setOctaveOffset: (offset: -2 | -1 | 0 | 1 | 2) => Result<InputPadState>;
  stepOctave: (delta: -1 | 1) => Result<InputPadState>;
  setDotted: (dotted: boolean) => Result<InputPadState>;
  toggleDotted: () => Result<InputPadState>;
  clearModifiers: () => Result<InputPadState>;
  commitNote: () => Result<CommittedNoteSpec>;
  lockForPlayback: () => Result<InputPadState>;
  unlockFromPlayback: () => Result<InputPadState>;
  setCursor: (cursor: Partial<InputCursor>) => void;
  clearError: () => void;
}

function hasActiveModifiers(
  accidental: Accidental,
  octaveOffset: -2 | -1 | 0 | 1 | 2,
  dotted: boolean
): boolean {
  return accidental !== null || octaveOffset !== 0 || dotted;
}

function clampOctave(val: number): -2 | -1 | 0 | 1 | 2 {
  if (val <= -2) {
    return -2;
  }
  if (val === -1) {
    return -1;
  }
  if (val === 1) {
    return 1;
  }
  if (val >= 2) {
    return 2;
  }
  return 0;
}

export type InputStoreApi = StoreApi<InputStoreState>;

export function createInputStore(): InputStoreApi {
  return createStore<InputStoreState>((set, get) => {
    const applyModifierChange = (
      nextAccidental: Accidental,
      nextOctaveOffset: -2 | -1 | 0 | 1 | 2,
      nextDotted: boolean
    ): Result<InputPadState> => {
      const current = get();
      const willHaveModifiers = hasActiveModifiers(
        nextAccidental,
        nextOctaveOffset,
        nextDotted
      );

      if (current.padState === 'LOCKED_BY_PLAYBACK') {
        const blocked = transitionInputPadState(
          current.padState,
          'ARM_MODIFIER'
        );
        if (!blocked.ok) {
          set({ lastError: blocked.error });
        }
        return blocked;
      }

      if (willHaveModifiers) {
        const res = transitionInputPadState(current.padState, 'ARM_MODIFIER');
        if (!res.ok) {
          set({ lastError: res.error });
          return res;
        }
        set({
          padState: res.value,
          accidental: nextAccidental,
          octaveOffset: nextOctaveOffset,
          dotted: nextDotted,
          lastError: null,
        });
        return res;
      }

      if (current.padState === 'MODIFIER_ARMED') {
        const res = transitionInputPadState(current.padState, 'CLEAR_MODIFIER');
        if (!res.ok) {
          set({ lastError: res.error });
          return res;
        }
        set({
          padState: res.value,
          accidental: null,
          octaveOffset: 0,
          dotted: false,
          lastError: null,
        });
        return res;
      }

      set({
        accidental: null,
        octaveOffset: 0,
        dotted: false,
        lastError: null,
      });
      return { ok: true, value: current.padState };
    };

    return {
      padState: 'READY',
      baseDuration: 'quarter',
      accidental: null,
      octaveOffset: 0,
      dotted: false,
      cursor: {
        measureIndex: 0,
        noteIndex: 0,
        selectedNoteId: null,
      },
      lastError: null,

      setBaseDuration: (duration) => {
        const current = get();
        if (current.padState === 'LOCKED_BY_PLAYBACK') {
          const blocked = transitionInputPadState(
            current.padState,
            'ARM_MODIFIER'
          );
          if (!blocked.ok) {
            set({ lastError: blocked.error });
            return blocked;
          }
        }
        set({
          baseDuration: duration,
          lastError: null,
        });
        return { ok: true, value: duration };
      },

      setAccidental: (accidental) => {
        const current = get();
        return applyModifierChange(
          accidental,
          current.octaveOffset,
          current.dotted
        );
      },

      toggleAccidental: (accidental) => {
        const current = get();
        const next = current.accidental === accidental ? null : accidental;
        return applyModifierChange(next, current.octaveOffset, current.dotted);
      },

      setOctaveOffset: (offset) => {
        const current = get();
        return applyModifierChange(
          current.accidental,
          clampOctave(offset),
          current.dotted
        );
      },

      stepOctave: (delta) => {
        const current = get();
        const next = clampOctave(current.octaveOffset + delta);
        return applyModifierChange(current.accidental, next, current.dotted);
      },

      setDotted: (dotted) => {
        const current = get();
        return applyModifierChange(
          current.accidental,
          current.octaveOffset,
          dotted
        );
      },

      toggleDotted: () => {
        const current = get();
        return applyModifierChange(
          current.accidental,
          current.octaveOffset,
          !current.dotted
        );
      },

      clearModifiers: () => {
        const current = get();
        if (current.padState === 'LOCKED_BY_PLAYBACK') {
          const blocked = transitionInputPadState(
            current.padState,
            'CLEAR_MODIFIER'
          );
          if (!blocked.ok) {
            set({ lastError: blocked.error });
          }
          return blocked;
        }
        if (current.padState === 'MODIFIER_ARMED') {
          const res = transitionInputPadState(
            current.padState,
            'CLEAR_MODIFIER'
          );
          if (!res.ok) {
            set({ lastError: res.error });
            return res;
          }
          set({
            padState: res.value,
            accidental: null,
            octaveOffset: 0,
            dotted: false,
            lastError: null,
          });
          return res;
        }
        set({
          accidental: null,
          octaveOffset: 0,
          dotted: false,
          lastError: null,
        });
        return { ok: true, value: current.padState };
      },

      commitNote: () => {
        const current = get();
        const res = transitionInputPadState(current.padState, 'COMMIT_NOTE');
        if (!res.ok) {
          set({ lastError: res.error });
          return res;
        }

        const spec: CommittedNoteSpec = {
          baseDuration: current.baseDuration,
          accidental: current.accidental,
          octaveOffset: current.octaveOffset,
          dotted: current.dotted,
        };

        // 假设 A-06：录入后自动复位临时升降号/八度点/附点，保留基础时值档位
        set({
          padState: res.value,
          accidental: null,
          octaveOffset: 0,
          dotted: false,
          lastError: null,
        });

        return { ok: true, value: spec };
      },

      lockForPlayback: () => {
        const current = get();
        if (current.padState === 'LOCKED_BY_PLAYBACK') {
          return { ok: true, value: 'LOCKED_BY_PLAYBACK' };
        }
        const res = transitionInputPadState(current.padState, 'LOCK');
        if (!res.ok) {
          set({ lastError: res.error });
          return res;
        }
        set({
          padState: res.value,
          accidental: null,
          octaveOffset: 0,
          dotted: false,
          lastError: null,
        });
        return res;
      },

      unlockFromPlayback: () => {
        const current = get();
        if (current.padState !== 'LOCKED_BY_PLAYBACK') {
          return { ok: true, value: current.padState };
        }
        const res = transitionInputPadState(current.padState, 'UNLOCK');
        if (!res.ok) {
          set({ lastError: res.error });
          return res;
        }
        set({
          padState: res.value,
          lastError: null,
        });
        return res;
      },

      setCursor: (cursor) => {
        const current = get();
        set({
          cursor: {
            measureIndex: Math.max(
              0,
              cursor.measureIndex ?? current.cursor.measureIndex
            ),
            noteIndex: Math.max(0, cursor.noteIndex ?? current.cursor.noteIndex),
            selectedNoteId:
              cursor.selectedNoteId !== undefined
                ? cursor.selectedNoteId
                : current.cursor.selectedNoteId,
          },
        });
      },

      clearError: () => {
        set({ lastError: null });
      },
    };
  });
}

export const inputStore: InputStoreApi = createInputStore();

export function useInputStore<T>(
  selector: (state: InputStoreState) => T,
  store: InputStoreApi = inputStore
): T {
  return useStore(store, selector);
}
