import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  clampCapo,
  getInstrumentProfile,
  type TuningPresetId,
} from '../domain/v2-instruments.ts';
import type { InstrumentId, ViewLayerType } from '../domain/v2-types.ts';

export type GuitarToneMode = 'clean' | 'overdrive';

export interface PracticeViewFlags {
  staff: boolean;
  jianpu: boolean;
  tab: boolean;
}

export interface PracticePlaybackFrame {
  activeNoteId: string | null;
  activeMidiPitchesV1: number[];
  activeMidiPitchesV2: number[];
  nextNoteId: string | null;
  nextMidiPitch: number | null;
  activeMeasureIndex: number;
  countInBeat: number | null;
}

export interface SpeedTrainerConfigPatch {
  startPercent?: number;
  stepPercent?: number;
  targetPercent?: number;
}

export interface PracticeStoreState {
  selectedInstrumentId: InstrumentId;
  guitarTone: GuitarToneMode;
  tuningPresetId: TuningPresetId;
  capo: number;
  practiceViews: PracticeViewFlags;
  manualFretPositions: Record<string, { string: number; fret: number }>;

  muteRightHand: boolean;
  muteLeftHand: boolean;

  abLoopEnabled: boolean;
  loopStartMeasure: number;
  loopEndMeasure: number;
  countInEnabled: boolean;
  speedTrainerEnabled: boolean;
  speedStartPercent: number;
  speedStepPercent: number;
  speedTargetPercent: number;
  currentSpeedPercent: number;
  completedLoopCount: number;
  autoScrollEnabled: boolean;

  activeNoteId: string | null;
  activeMidiPitchesV1: number[];
  activeMidiPitchesV2: number[];
  nextNoteId: string | null;
  nextMidiPitch: number | null;
  activeMeasureIndex: number;
  countInBeat: number | null;

  selectInstrument: (id: InstrumentId) => void;
  setGuitarTone: (tone: GuitarToneMode) => void;
  setTuningPreset: (presetId: TuningPresetId) => void;
  setCapo: (capo: number) => void;
  togglePracticeView: (layer: ViewLayerType) => void;
  setManualFretPosition: (
    noteId: string,
    pos: { string: number; fret: number } | null
  ) => void;
  clearManualFretPositions: () => void;

  setMuteRightHand: (muted: boolean) => void;
  setMuteLeftHand: (muted: boolean) => void;

  setAbLoopEnabled: (enabled: boolean) => void;
  setLoopRange: (start: number, end: number, measureCount?: number) => void;
  setCountInEnabled: (enabled: boolean) => void;
  setSpeedTrainerEnabled: (enabled: boolean) => void;
  setSpeedTrainerConfig: (patch: SpeedTrainerConfigPatch) => void;
  resetSpeedTrainerRun: () => void;
  advanceSpeedTrainerLoop: () => number;
  setAutoScrollEnabled: (enabled: boolean) => void;

  setActivePlaybackFrame: (frame: Partial<PracticePlaybackFrame>) => void;
  clearActivePlaybackFrame: () => void;
}

export type PracticeStoreApi = StoreApi<PracticeStoreState>;

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function viewsFromDefault(
  views: readonly ViewLayerType[]
): PracticeViewFlags {
  return {
    staff: views.includes('staff'),
    jianpu: views.includes('jianpu'),
    tab: views.includes('tab'),
  };
}

export function createPracticeStore(): PracticeStoreApi {
  return createStore<PracticeStoreState>((set, get) => ({
    selectedInstrumentId: 'piano',
    guitarTone: 'clean',
    tuningPresetId: 'standard-6',
    capo: 0,
    practiceViews: { staff: true, jianpu: true, tab: false },
    manualFretPositions: {},

    muteRightHand: false,
    muteLeftHand: false,

    abLoopEnabled: false,
    loopStartMeasure: 0,
    loopEndMeasure: 0,
    countInEnabled: false,
    speedTrainerEnabled: false,
    speedStartPercent: 70,
    speedStepPercent: 5,
    speedTargetPercent: 100,
    currentSpeedPercent: 100,
    completedLoopCount: 0,
    autoScrollEnabled: true,

    activeNoteId: null,
    activeMidiPitchesV1: [],
    activeMidiPitchesV2: [],
    nextNoteId: null,
    nextMidiPitch: null,
    activeMeasureIndex: 0,
    countInBeat: null,

    selectInstrument: (id) => {
      const state = get();
      let resolvedId = id;
      if (id === 'electric-guitar-clean' || id === 'electric-guitar-od') {
        resolvedId =
          state.guitarTone === 'overdrive'
            ? 'electric-guitar-od'
            : 'electric-guitar-clean';
      }
      const profile = getInstrumentProfile(resolvedId);
      const nextViews = viewsFromDefault(profile.defaultViews);

      let nextTuning = state.tuningPresetId;
      if (profile.availableTuningIds.length > 0) {
        if (!profile.availableTuningIds.includes(nextTuning)) {
          nextTuning = profile.defaultTuningId ?? profile.availableTuningIds[0]!;
        }
      }

      set({
        selectedInstrumentId: resolvedId,
        practiceViews: nextViews,
        tuningPresetId: nextTuning,
        capo: profile.supportsCapo ? state.capo : 0,
        manualFretPositions: {},
      });
    },

    setGuitarTone: (tone) => {
      const state = get();
      const isElectricGuitar =
        state.selectedInstrumentId === 'electric-guitar-clean' ||
        state.selectedInstrumentId === 'electric-guitar-od';
      set({
        guitarTone: tone,
        selectedInstrumentId: isElectricGuitar
          ? tone === 'overdrive'
            ? 'electric-guitar-od'
            : 'electric-guitar-clean'
          : state.selectedInstrumentId,
      });
    },

    setTuningPreset: (presetId) => {
      set({
        tuningPresetId: presetId,
        manualFretPositions: {},
      });
    },

    setCapo: (capo) => {
      set({
        capo: clampCapo(capo),
        manualFretPositions: {},
      });
    },

    togglePracticeView: (layer) => {
      const curr = get().practiceViews;
      const next: PracticeViewFlags = {
        ...curr,
        [layer]: !curr[layer],
      };
      if (!next.staff && !next.jianpu && !next.tab) {
        return;
      }
      set({ practiceViews: next });
    },

    setManualFretPosition: (noteId, pos) => {
      const curr = { ...get().manualFretPositions };
      if (!pos) {
        delete curr[noteId];
      } else {
        curr[noteId] = { string: pos.string, fret: pos.fret };
      }
      set({ manualFretPositions: curr });
    },

    clearManualFretPositions: () => {
      set({ manualFretPositions: {} });
    },

    setMuteRightHand: (muted) => {
      set({ muteRightHand: muted });
    },

    setMuteLeftHand: (muted) => {
      set({ muteLeftHand: muted });
    },

    setAbLoopEnabled: (enabled) => {
      set({ abLoopEnabled: enabled });
    },

    setLoopRange: (start, end, measureCount) => {
      const maxIdx =
        measureCount !== undefined && measureCount > 0
          ? measureCount - 1
          : Number.MAX_SAFE_INTEGER;
      const safeStart = clampInt(start, 0, maxIdx);
      const safeEnd = clampInt(Math.max(safeStart, end), safeStart, maxIdx);
      set({
        loopStartMeasure: safeStart,
        loopEndMeasure: safeEnd,
      });
    },

    setCountInEnabled: (enabled) => {
      set({ countInEnabled: enabled });
    },

    setSpeedTrainerEnabled: (enabled) => {
      const state = get();
      set({
        speedTrainerEnabled: enabled,
        currentSpeedPercent: enabled ? state.speedStartPercent : 100,
        completedLoopCount: 0,
      });
    },

    setSpeedTrainerConfig: (patch) => {
      const state = get();
      const startPercent =
        patch.startPercent !== undefined
          ? clampInt(patch.startPercent, 40, 100)
          : state.speedStartPercent;
      const stepPercent =
        patch.stepPercent !== undefined
          ? clampInt(patch.stepPercent, 1, 25)
          : state.speedStepPercent;
      const targetPercent =
        patch.targetPercent !== undefined
          ? clampInt(patch.targetPercent, startPercent, 150)
          : Math.max(startPercent, state.speedTargetPercent);
      set({
        speedStartPercent: startPercent,
        speedStepPercent: stepPercent,
        speedTargetPercent: targetPercent,
        currentSpeedPercent: state.speedTrainerEnabled
          ? startPercent
          : state.currentSpeedPercent,
      });
    },

    resetSpeedTrainerRun: () => {
      const state = get();
      set({
        currentSpeedPercent: state.speedTrainerEnabled
          ? state.speedStartPercent
          : 100,
        completedLoopCount: 0,
      });
    },

    advanceSpeedTrainerLoop: () => {
      const state = get();
      if (!state.speedTrainerEnabled) {
        return 100;
      }
      const nextPercent = Math.min(
        state.speedTargetPercent,
        state.currentSpeedPercent + state.speedStepPercent
      );
      set({
        currentSpeedPercent: nextPercent,
        completedLoopCount: state.completedLoopCount + 1,
      });
      return nextPercent;
    },

    setAutoScrollEnabled: (enabled) => {
      set({ autoScrollEnabled: enabled });
    },

    setActivePlaybackFrame: (frame) => {
      set((state) => ({
        activeNoteId:
          frame.activeNoteId !== undefined
            ? frame.activeNoteId
            : state.activeNoteId,
        activeMidiPitchesV1:
          frame.activeMidiPitchesV1 !== undefined
            ? frame.activeMidiPitchesV1
            : state.activeMidiPitchesV1,
        activeMidiPitchesV2:
          frame.activeMidiPitchesV2 !== undefined
            ? frame.activeMidiPitchesV2
            : state.activeMidiPitchesV2,
        nextNoteId:
          frame.nextNoteId !== undefined ? frame.nextNoteId : state.nextNoteId,
        nextMidiPitch:
          frame.nextMidiPitch !== undefined
            ? frame.nextMidiPitch
            : state.nextMidiPitch,
        activeMeasureIndex:
          frame.activeMeasureIndex !== undefined
            ? frame.activeMeasureIndex
            : state.activeMeasureIndex,
        countInBeat:
          frame.countInBeat !== undefined
            ? frame.countInBeat
            : state.countInBeat,
      }));
    },

    clearActivePlaybackFrame: () => {
      set({
        activeNoteId: null,
        activeMidiPitchesV1: [],
        activeMidiPitchesV2: [],
        nextNoteId: null,
        nextMidiPitch: null,
        countInBeat: null,
      });
    },
  }));
}

export const practiceStore: PracticeStoreApi = createPracticeStore();

export function usePracticeStore<T>(
  selector: (state: PracticeStoreState) => T,
  store: PracticeStoreApi = practiceStore
): T {
  return useStore(store, selector);
}
