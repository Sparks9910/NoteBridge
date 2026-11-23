import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { AppError, Result } from '../domain/types.ts';
import {
  analyzeTunerReading,
  DEFAULT_A4_HZ,
  detectPitchAutocorrelation,
  type TunerPitchReading,
  type TunerTargetString,
} from '../domain/v2-tuner.ts';
import {
  generateSineWaveBuffer,
  type TunerAdapter,
  WebMicrophoneTunerAdapter,
} from '../infrastructure/tuner-adapter.ts';

export type TunerRunStatus = 'idle' | 'starting' | 'listening' | 'error';

export interface TunerStoreState {
  status: TunerRunStatus;
  a4Hz: number;
  selectedStringNumber: number | null;
  targetStrings: TunerTargetString[];
  reading: TunerPitchReading | null;
  error: AppError | null;

  start: (targetStrings?: readonly TunerTargetString[]) => Promise<Result<void>>;
  stop: () => void;
  setA4Hz: (a4Hz: number) => void;
  setSelectedString: (stringNumber: number | null) => void;
  setTargetStrings: (targetStrings: readonly TunerTargetString[]) => void;
  processSamples: (samples: Float32Array, sampleRate: number) => void;
  simulateFrequency: (frequencyHz: number, sampleRate?: number) => void;
  clearError: () => void;
}

export type TunerStoreApi = StoreApi<TunerStoreState>;

export function createTunerStore(adapter?: TunerAdapter): TunerStoreApi {
  const tunerAdapter = adapter ?? new WebMicrophoneTunerAdapter();

  return createStore<TunerStoreState>((set, get) => ({
    status: 'idle',
    a4Hz: DEFAULT_A4_HZ,
    selectedStringNumber: null,
    targetStrings: [],
    reading: null,
    error: null,

    start: async (targetStrings) => {
      if (targetStrings) {
        set({ targetStrings: [...targetStrings] });
      }
      set({ status: 'starting', error: null });

      const res = await tunerAdapter.start((samples, sampleRate) => {
        get().processSamples(samples, sampleRate);
      });

      if (!res.ok) {
        set({
          status: 'error',
          error: res.error,
          reading: null,
        });
        return res;
      }

      set({ status: 'listening', error: null });
      return res;
    },

    stop: () => {
      tunerAdapter.stop();
      set({
        status: 'idle',
        reading: null,
      });
    },

    setA4Hz: (a4Hz) => {
      const clamped = Number.isFinite(a4Hz)
        ? Math.max(415, Math.min(465, Math.round(a4Hz)))
        : DEFAULT_A4_HZ;
      set({ a4Hz: clamped });
    },

    setSelectedString: (stringNumber) => {
      set({ selectedStringNumber: stringNumber });
    },

    setTargetStrings: (targetStrings) => {
      set({ targetStrings: [...targetStrings] });
    },

    processSamples: (samples, sampleRate) => {
      const detected = detectPitchAutocorrelation(samples, sampleRate);
      if (!detected) {
        return;
      }
      const state = get();
      const analyzed = analyzeTunerReading(detected, state.targetStrings, {
        a4Hz: state.a4Hz,
        lockedStringNumber: state.selectedStringNumber,
      });
      set({ reading: analyzed });
    },

    simulateFrequency: (frequencyHz, sampleRate = 44100) => {
      const buf = generateSineWaveBuffer(frequencyHz, sampleRate, 4096, 0.7);
      get().processSamples(buf, sampleRate);
    },

    clearError: () => {
      set((state) => ({
        error: null,
        status: state.status === 'error' ? 'idle' : state.status,
      }));
    },
  }));
}

export const tunerStore: TunerStoreApi = createTunerStore();

export function useTunerStore<T>(
  selector: (state: TunerStoreState) => T,
  store: TunerStoreApi = tunerStore
): T {
  return useStore(store, selector);
}
