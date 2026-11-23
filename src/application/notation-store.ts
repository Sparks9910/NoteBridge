import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { calculateDurationTicks } from '../domain/rhythm.ts';
import { createAppError, createRequestId } from '../domain/state-machines.ts';
import { resolveNotePitch } from '../domain/theory.ts';
import type {
  Accidental,
  AppError,
  BaseDuration,
  KeySignature,
  Result,
  ScoreDocument,
} from '../domain/types.ts';
import { normalizeGuitarTechniques } from '../domain/v2-instruments.ts';
import { migrateV1ToV2 } from '../domain/v2-serializer.ts';
import type {
  Beat,
  GuitarTechnique,
  InstrumentId,
  MeasureNotationExtra,
  NoteNotationExtra,
  PitchNode,
  ReferenceAttachment,
  ScoreDocumentV2,
  ScoreMetadata,
  Track,
  V2Measure,
} from '../domain/v2-types.ts';

export type KeypadTabId =
  | 'input'
  | 'setup'
  | 'measure'
  | 'markings'
  | 'lyrics'
  | 'fingering'
  | 'voices';

export interface InsertVoice2Params {
  measureIndex: number;
  noteIndex?: number;
  isRest: boolean;
  degree: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  octaveOffset: -2 | -1 | 0 | 1 | 2;
  accidental: Accidental;
  baseDuration: BaseDuration;
  dotted: boolean;
  keySignature: KeySignature;
}

export interface NotationStoreState {
  boundScoreId: string | null;
  clef: Track['clef'];
  activeTrackIndex: number;
  activeVoiceIndex: 0 | 1;
  tracks: Track[];
  noteExtrasById: Record<string, NoteNotationExtra>;
  measureExtrasByIndex: Record<number, MeasureNotationExtra>;
  referenceSource: ReferenceAttachment | null;
  showReferencePanel: boolean;
  referenceZoom: number;
  activeKeypadTab: KeypadTabId;
  isKeypadCollapsed: boolean;
  lastError: AppError | null;

  bindScoreId: (scoreId: string) => void;
  resetForScore: (scoreId?: string | null) => void;
  loadFromV2Document: (v2: ScoreDocumentV2) => void;
  buildV2Document: (doc: ScoreDocument, meta?: ScoreMetadata) => ScoreDocumentV2;
  setClef: (clef: Track['clef'], measureCount?: number) => void;
  setActiveVoice: (voiceIndex: 0 | 1, measureCount?: number) => void;
  insertVoice2Note: (params: InsertVoice2Params) => Result<Beat>;
  deleteVoice2Note: (measureIndex: number, beatIndex?: number) => Result<void>;
  deleteVoice2NoteById: (beatId: string) => Result<void>;
  setNoteExtra: (noteId: string, patch: Partial<NoteNotationExtra>) => void;
  toggleGuitarTechnique: (noteId: string, technique: GuitarTechnique) => void;
  clearNoteExtra: (noteId: string) => void;
  setMeasureExtra: (
    measureIndex: number,
    patch: Partial<MeasureNotationExtra>
  ) => void;
  addTrack: (
    name: string,
    instrumentId?: InstrumentId,
    clef?: Track['clef'],
    measureCount?: number
  ) => Result<Track>;
  switchActiveTrack: (trackIndex: number) => void;
  removeTrack: (trackId: string) => Result<void>;
  setReferenceSource: (ref: ReferenceAttachment | null) => void;
  toggleReferencePanel: (show?: boolean) => void;
  setReferenceZoom: (zoom: number) => void;
  setActiveKeypadTab: (tab: KeypadTabId) => void;
  setKeypadCollapsed: (collapsed?: boolean) => void;
  clearError: () => void;
}

export type NotationStoreApi = StoreApi<NotationStoreState>;

function createEmptyVoiceMeasures(count: number, prefix: string): V2Measure[] {
  const safeCount = Math.max(1, count);
  const out: V2Measure[] = [];
  for (let i = 0; i < safeCount; i += 1) {
    out.push({
      id: `${prefix}_m_${i}`,
      index: i,
      beats: [],
    });
  }
  return out;
}

function createDefaultTrack(clef: Track['clef'] = 'treble', measureCount = 1): Track {
  const voices = [
    {
      id: 'voice_1',
      index: 0,
      measures: createEmptyVoiceMeasures(measureCount, 'v1'),
    },
  ];
  if (clef === 'grand') {
    voices.push({
      id: 'voice_2',
      index: 1,
      measures: createEmptyVoiceMeasures(measureCount, 'v2'),
    });
  }
  return {
    id: 'track_main',
    name: clef === 'grand' ? '钢琴' : '主旋律',
    instrumentId: 'piano',
    clef,
    enabledViews: ['staff', 'jianpu'],
    voices,
  };
}

function cloneTrack(track: Track): Track {
  return {
    ...track,
    enabledViews: [...track.enabledViews],
    tuning: track.tuning ? [...track.tuning] : undefined,
    voices: track.voices.map((v) => ({
      ...v,
      measures: v.measures.map((m) => ({
        ...m,
        beats: m.beats.map((b) => ({
          ...b,
          notes: b.notes.map((n) => ({
            ...n,
            guitar: n.guitar
              ? {
                  ...n.guitar,
                  techniques: n.guitar.techniques
                    ? [...n.guitar.techniques]
                    : undefined,
                }
              : undefined,
          })),
        })),
      })),
    })),
  };
}

function ensureVoice1OnTrack(track: Track, measureCount: number): Track {
  const cloned = cloneTrack(track);
  if (cloned.voices.length < 2) {
    cloned.voices.push({
      id: `${cloned.id}_voice_2`,
      index: 1,
      measures: createEmptyVoiceMeasures(measureCount, `${cloned.id}_v2`),
    });
  } else {
    const v2 = cloned.voices[1]!;
    while (v2.measures.length < measureCount) {
      const idx = v2.measures.length;
      v2.measures.push({
        id: `${cloned.id}_v2_m_${idx}`,
        index: idx,
        beats: [],
      });
    }
  }
  return cloned;
}

function applyNoteExtraToBeat(beat: Beat, extra: NoteNotationExtra | undefined): Beat {
  if (!extra) return beat;
  const next: Beat = {
    ...beat,
    notes: beat.notes.map((n) => ({
      ...n,
      guitar: n.guitar
        ? {
            ...n.guitar,
            techniques: n.guitar.techniques ? [...n.guitar.techniques] : undefined,
          }
        : undefined,
    })),
  };
  if (extra.lyric !== undefined) {
    if (extra.lyric.trim().length > 0) next.lyric = extra.lyric;
    else delete next.lyric;
  }
  if (extra.chordSymbol !== undefined) {
    if (extra.chordSymbol.trim().length > 0) next.chordSymbol = extra.chordSymbol;
    else delete next.chordSymbol;
  }
  if (extra.dynamic !== undefined) next.dynamic = extra.dynamic;
  if (extra.ornament !== undefined) next.ornament = extra.ornament;
  if (extra.tieStart !== undefined) next.tieStart = extra.tieStart;
  if (extra.tieEnd !== undefined) next.tieEnd = extra.tieEnd;
  if (extra.slurStart !== undefined) next.slurStart = extra.slurStart;
  if (extra.slurEnd !== undefined) next.slurEnd = extra.slurEnd;
  if (extra.fingering !== undefined && next.notes[0]) {
    if (extra.fingering.trim().length > 0) {
      next.notes[0].fingering = extra.fingering.trim();
    } else {
      delete next.notes[0].fingering;
    }
  }
  if (next.notes[0]) {
    const normalizedTechs = normalizeGuitarTechniques(extra.guitarTechniques);
    const pos = extra.guitarPosition;
    if (pos || normalizedTechs.length > 0 || next.notes[0].guitar) {
      const existing = next.notes[0].guitar;
      const mergedStr = pos?.string ?? existing?.string ?? 1;
      const mergedFret = pos?.fret ?? existing?.fret ?? 0;
      if (extra.guitarTechniques !== undefined || normalizedTechs.length > 0 || pos) {
        next.notes[0].guitar = {
          string: mergedStr,
          fret: mergedFret,
          ...(normalizedTechs.length > 0 ? { techniques: normalizedTechs } : {}),
        };
      }
    }
  }
  return next;
}

function applyMeasureExtra(
  measure: V2Measure,
  extra: MeasureNotationExtra | undefined
): V2Measure {
  if (!extra) return measure;
  const next: V2Measure = { ...measure };
  if (extra.repeatStart !== undefined) next.repeatStart = extra.repeatStart;
  if (extra.repeatEnd !== undefined) next.repeatEnd = extra.repeatEnd;
  if (extra.barline !== undefined) next.barline = extra.barline;
  if (extra.ending !== undefined) next.ending = extra.ending;
  return next;
}

export function createNotationStore(): NotationStoreApi {
  return createStore<NotationStoreState>((set, get) => ({
    boundScoreId: null,
    clef: 'treble',
    activeTrackIndex: 0,
    activeVoiceIndex: 0,
    tracks: [createDefaultTrack('treble', 1)],
    noteExtrasById: {},
    measureExtrasByIndex: {},
    referenceSource: null,
    showReferencePanel: false,
    referenceZoom: 100,
    activeKeypadTab: 'input',
    isKeypadCollapsed: false,
    lastError: null,

    bindScoreId: (scoreId) => {
      set({ boundScoreId: scoreId });
    },

    resetForScore: (scoreId = null) => {
      set({
        boundScoreId: scoreId,
        clef: 'treble',
        activeTrackIndex: 0,
        activeVoiceIndex: 0,
        tracks: [createDefaultTrack('treble', 1)],
        noteExtrasById: {},
        measureExtrasByIndex: {},
        referenceSource: null,
        showReferencePanel: false,
        referenceZoom: 100,
        lastError: null,
      });
    },

    loadFromV2Document: (v2) => {
      const noteExtrasById: Record<string, NoteNotationExtra> = {};
      const measureExtrasByIndex: Record<number, MeasureNotationExtra> = {};

      for (const track of v2.tracks) {
        for (const voice of track.voices) {
          for (const measure of voice.measures) {
            if (track === v2.tracks[0] && voice.index === 0) {
              const mExtra: MeasureNotationExtra = {};
              if (measure.repeatStart) mExtra.repeatStart = true;
              if (measure.repeatEnd) mExtra.repeatEnd = true;
              if (measure.barline) mExtra.barline = measure.barline;
              if (measure.ending) mExtra.ending = measure.ending;
              if (Object.keys(mExtra).length > 0) {
                measureExtrasByIndex[measure.index] = mExtra;
              }
            }

            for (const beat of measure.beats) {
              const extra: NoteNotationExtra = {};
              if (beat.lyric) extra.lyric = beat.lyric;
              if (beat.chordSymbol) extra.chordSymbol = beat.chordSymbol;
              if (beat.dynamic) extra.dynamic = beat.dynamic;
              if (beat.ornament) extra.ornament = beat.ornament;
              if (beat.tieStart) extra.tieStart = true;
              if (beat.tieEnd) extra.tieEnd = true;
              if (beat.slurStart) extra.slurStart = true;
              if (beat.slurEnd) extra.slurEnd = true;
              const fg = beat.notes[0]?.fingering;
              if (fg) extra.fingering = fg;
              const guitarMeta = beat.notes[0]?.guitar;
              if (guitarMeta) {
                if (
                  Number.isInteger(guitarMeta.string) &&
                  guitarMeta.string >= 1 &&
                  Number.isInteger(guitarMeta.fret) &&
                  guitarMeta.fret >= 0
                ) {
                  extra.guitarPosition = {
                    string: guitarMeta.string,
                    fret: guitarMeta.fret,
                  };
                }
                const techs = normalizeGuitarTechniques(guitarMeta.techniques);
                if (techs.length > 0) {
                  extra.guitarTechniques = techs;
                }
              }
              if (Object.keys(extra).length > 0) {
                noteExtrasById[beat.id] = extra;
              }
            }
          }
        }
      }

      const mainClef = v2.tracks[0]?.clef ?? 'treble';
      const clonedTracks = v2.tracks.length > 0
        ? v2.tracks.map(cloneTrack)
        : [createDefaultTrack(mainClef, 1)];

      set({
        boundScoreId: v2.id,
        clef: mainClef,
        activeTrackIndex: 0,
        activeVoiceIndex: 0,
        tracks: clonedTracks,
        noteExtrasById,
        measureExtrasByIndex,
        referenceSource: v2.referenceSource ? { ...v2.referenceSource } : null,
        lastError: null,
      });
    },

    buildV2Document: (doc, meta) => {
      const state = get();
      const baseV2 = migrateV1ToV2(doc, meta);
      const isSameScore = state.boundScoreId === null || state.boundScoreId === doc.id;

      if (!isSameScore) {
        return baseV2;
      }

      const baseMainTrack = baseV2.tracks[0]!;
      const storedMainTrack = state.tracks[0];
      const mainVoice0 = baseMainTrack.voices[0]!;

      const enrichedVoice0Measures = mainVoice0.measures.map((m, mIdx) => {
        const enrichedBeats = m.beats.map((b) =>
          applyNoteExtraToBeat(b, state.noteExtrasById[b.id])
        );
        return applyMeasureExtra(
          { ...m, beats: enrichedBeats },
          state.measureExtrasByIndex[mIdx]
        );
      });

      const voices = [{ ...mainVoice0, measures: enrichedVoice0Measures }];
      const storedVoice1 = storedMainTrack?.voices[1];
      if (storedVoice1) {
        const paddedV1Measures: V2Measure[] = [];
        for (let i = 0; i < enrichedVoice0Measures.length; i += 1) {
          const srcM = storedVoice1.measures[i];
          paddedV1Measures.push({
            id: srcM?.id ?? `v2_m_${i}`,
            index: i,
            beats: (srcM?.beats ?? []).map((b) =>
              applyNoteExtraToBeat(b, state.noteExtrasById[b.id])
            ),
          });
        }
        voices.push({
          ...storedVoice1,
          index: 1,
          measures: paddedV1Measures,
        });
      }

      const mainTrack: Track = {
        ...baseMainTrack,
        name: storedMainTrack?.name ?? (state.clef === 'grand' ? '钢琴' : baseMainTrack.name),
        instrumentId: storedMainTrack?.instrumentId ?? baseMainTrack.instrumentId,
        clef: state.clef,
        voices,
      };

      const extraTracks = state.tracks.slice(1).map(cloneTrack);
      const out: ScoreDocumentV2 = {
        ...baseV2,
        tracks: [mainTrack, ...extraTracks],
      };

      if (state.referenceSource) {
        out.referenceSource = { ...state.referenceSource };
      }

      return out;
    },

    setClef: (clef, measureCount = 1) => {
      set((state) => {
        const baseTracks =
          state.tracks.length > 0
            ? state.tracks.map(cloneTrack)
            : [createDefaultTrack(clef, measureCount)];
        const idx = Math.min(state.activeTrackIndex, baseTracks.length - 1);
        let target = baseTracks[idx]!;
        target.clef = clef;
        if (clef === 'grand') {
          target = ensureVoice1OnTrack(target, measureCount);
        }
        baseTracks[idx] = target;
        return {
          clef: idx === 0 ? clef : state.clef,
          tracks: baseTracks,
          activeVoiceIndex: clef !== 'grand' && state.activeVoiceIndex === 1 && target.voices.length < 2
            ? 0
            : state.activeVoiceIndex,
        };
      });
    },

    setActiveVoice: (voiceIndex, measureCount = 1) => {
      set((state) => {
        if (voiceIndex === 0) {
          return { activeVoiceIndex: 0 };
        }
        const tracks = state.tracks.map(cloneTrack);
        const idx = Math.min(state.activeTrackIndex, tracks.length - 1);
        tracks[idx] = ensureVoice1OnTrack(tracks[idx]!, measureCount);
        return {
          tracks,
          activeVoiceIndex: 1,
        };
      });
    },

    insertVoice2Note: (params) => {
      if (params.measureIndex < 0) {
        const err = createAppError('SCORE_MEASURE_NOT_FOUND', '小节索引无效，无法录入第二声部');
        set({ lastError: err });
        return { ok: false, error: err };
      }

      const durationTicks = calculateDurationTicks(params.baseDuration, params.dotted);
      const beatId = `v2_n_${createRequestId().slice(0, 8)}`;

      let beat: Beat;
      if (params.isRest || params.degree === 0) {
        beat = {
          id: beatId,
          isRest: true,
          baseDuration: params.baseDuration,
          dotted: params.dotted,
          durationTicks,
          notes: [],
        };
      } else {
        const resolved = resolveNotePitch(
          {
            id: beatId,
            isRest: false,
            degree: params.degree,
            octaveOffset: params.octaveOffset,
            accidental: params.accidental,
            baseDuration: params.baseDuration,
            dotted: params.dotted,
            durationTicks,
          },
          params.keySignature
        );
        const pitchNode: PitchNode = {
          id: `${beatId}_p0`,
          midiPitch: resolved ? resolved.midiPitch : 48,
          degree: params.degree,
          octaveOffset: params.octaveOffset,
          accidental: params.accidental,
        };
        beat = {
          id: beatId,
          isRest: false,
          baseDuration: params.baseDuration,
          dotted: params.dotted,
          durationTicks,
          notes: [pitchNode],
        };
      }

      set((state) => {
        const tracks = state.tracks.map(cloneTrack);
        const tIdx = Math.min(state.activeTrackIndex, tracks.length - 1);
        const updatedTrack = ensureVoice1OnTrack(
          tracks[tIdx]!,
          params.measureIndex + 1
        );
        const voice2 = updatedTrack.voices[1]!;
        const targetMeasure = voice2.measures[params.measureIndex]!;
        const insertAt =
          params.noteIndex !== undefined
            ? Math.max(0, Math.min(params.noteIndex, targetMeasure.beats.length))
            : targetMeasure.beats.length;
        targetMeasure.beats.splice(insertAt, 0, beat);
        tracks[tIdx] = updatedTrack;
        return { tracks, lastError: null };
      });

      return { ok: true, value: beat };
    },

    deleteVoice2Note: (measureIndex, beatIndex) => {
      const state = get();
      const tIdx = Math.min(state.activeTrackIndex, state.tracks.length - 1);
      const voice2 = state.tracks[tIdx]?.voices[1];
      const measure = voice2?.measures[measureIndex];
      if (!measure) {
        const err = createAppError('SCORE_MEASURE_NOT_FOUND', '未找到第二声部对应小节');
        set({ lastError: err });
        return { ok: false, error: err };
      }
      if (measure.beats.length === 0) {
        return { ok: true, value: undefined };
      }

      set((curr) => {
        const tracks = curr.tracks.map(cloneTrack);
        const v2 = tracks[tIdx]?.voices[1];
        const m = v2?.measures[measureIndex];
        if (m && m.beats.length > 0) {
          const rmIdx =
            beatIndex !== undefined
              ? Math.max(0, Math.min(beatIndex, m.beats.length - 1))
              : m.beats.length - 1;
          m.beats.splice(rmIdx, 1);
        }
        return { tracks, lastError: null };
      });
      return { ok: true, value: undefined };
    },

    deleteVoice2NoteById: (beatId) => {
      set((state) => {
        const tracks = state.tracks.map(cloneTrack);
        for (const track of tracks) {
          const v2 = track.voices[1];
          if (!v2) continue;
          for (const m of v2.measures) {
            const idx = m.beats.findIndex((b) => b.id === beatId);
            if (idx !== -1) {
              m.beats.splice(idx, 1);
              return { tracks, lastError: null };
            }
          }
        }
        return { lastError: null };
      });
      return { ok: true, value: undefined };
    },

    setNoteExtra: (noteId, patch) => {
      set((state) => {
        const prev = state.noteExtrasById[noteId] ?? {};
        const merged: NoteNotationExtra = { ...prev, ...patch };
        return {
          noteExtrasById: {
            ...state.noteExtrasById,
            [noteId]: merged,
          },
        };
      });
    },

    toggleGuitarTechnique: (noteId, technique) => {
      set((state) => {
        const prev = state.noteExtrasById[noteId] ?? {};
        const current = normalizeGuitarTechniques(prev.guitarTechniques);
        const exists = current.includes(technique);
        const nextTechs = exists
          ? current.filter((t) => t !== technique)
          : normalizeGuitarTechniques([...current, technique]);
        const merged: NoteNotationExtra = {
          ...prev,
          guitarTechniques: nextTechs.length > 0 ? nextTechs : undefined,
        };
        return {
          noteExtrasById: {
            ...state.noteExtrasById,
            [noteId]: merged,
          },
        };
      });
    },

    clearNoteExtra: (noteId) => {
      set((state) => {
        const next = { ...state.noteExtrasById };
        delete next[noteId];
        return { noteExtrasById: next };
      });
    },

    setMeasureExtra: (measureIndex, patch) => {
      set((state) => {
        const prev = state.measureExtrasByIndex[measureIndex] ?? {};
        return {
          measureExtrasByIndex: {
            ...state.measureExtrasByIndex,
            [measureIndex]: { ...prev, ...patch },
          },
        };
      });
    },

    addTrack: (name, instrumentId = 'piano', clef = 'treble', measureCount = 1) => {
      const trimmed = name.trim();
      if (!trimmed) {
        const err = createAppError('STORAGE_SCHEMA_CORRUPTED', '轨道名称不能为空', 'name');
        set({ lastError: err });
        return { ok: false, error: err };
      }
      const newTrack: Track = {
        id: `track_${createRequestId().slice(0, 8)}`,
        name: trimmed,
        instrumentId,
        clef,
        enabledViews: ['staff', 'jianpu'],
        voices: [
          {
            id: `voice_${createRequestId().slice(0, 6)}_1`,
            index: 0,
            measures: createEmptyVoiceMeasures(measureCount, 'tr_v1'),
          },
        ],
      };
      set((state) => ({
        tracks: [...state.tracks.map(cloneTrack), newTrack],
        lastError: null,
      }));
      return { ok: true, value: newTrack };
    },

    switchActiveTrack: (trackIndex) => {
      set((state) => {
        const clamped = Math.max(0, Math.min(trackIndex, state.tracks.length - 1));
        return { activeTrackIndex: clamped };
      });
    },

    removeTrack: (trackId) => {
      const state = get();
      if (state.tracks.length <= 1 || state.tracks[0]?.id === trackId) {
        const err = createAppError(
          'STATE_INVALID_TRANSITION',
          '至少保留一条主旋律轨道，不可删除主轨道'
        );
        set({ lastError: err });
        return { ok: false, error: err };
      }
      set((curr) => ({
        tracks: curr.tracks.filter((t) => t.id !== trackId).map(cloneTrack),
        activeTrackIndex: 0,
        lastError: null,
      }));
      return { ok: true, value: undefined };
    },

    setReferenceSource: (ref) => {
      set({
        referenceSource: ref ? { ...ref } : null,
      });
    },

    toggleReferencePanel: (show) => {
      set((state) => ({
        showReferencePanel: show !== undefined ? show : !state.showReferencePanel,
      }));
    },

    setReferenceZoom: (zoom) => {
      const clamped = Math.max(50, Math.min(200, Math.round(zoom)));
      set({ referenceZoom: clamped });
    },

    setActiveKeypadTab: (activeKeypadTab) => {
      set({ activeKeypadTab, isKeypadCollapsed: false });
    },

    setKeypadCollapsed: (collapsed) => {
      set((state) => ({
        isKeypadCollapsed:
          collapsed !== undefined ? collapsed : !state.isKeypadCollapsed,
      }));
    },

    clearError: () => {
      set({ lastError: null });
    },
  }));
}

export const notationStore: NotationStoreApi = createNotationStore();

export function useNotationStore<T>(
  selector: (state: NotationStoreState) => T,
  store: NotationStoreApi = notationStore
): T {
  return useStore(store, selector);
}
