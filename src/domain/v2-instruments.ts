import type {
  GuitarTechnique,
  InstrumentId,
  Track,
  ViewLayerType,
} from './v2-types.ts';

export interface GuitarTechniqueMeta {
  id: GuitarTechnique;
  label: string;
  shortLabel: string;
  tabSymbol: string;
  staffSymbol: string;
}

export const GUITAR_TECHNIQUE_OPTIONS: readonly GuitarTechniqueMeta[] = [
  {
    id: 'bend',
    label: '推弦 (Bend)',
    shortLabel: '推弦',
    tabSymbol: '↑',
    staffSymbol: 'bend',
  },
  {
    id: 'slide',
    label: '滑音 (Slide)',
    shortLabel: '滑音',
    tabSymbol: '/',
    staffSymbol: 'sl.',
  },
  {
    id: 'hammer',
    label: '击弦 (H)',
    shortLabel: '击弦',
    tabSymbol: 'H',
    staffSymbol: 'H',
  },
  {
    id: 'pull',
    label: '勾弦 (P)',
    shortLabel: '勾弦',
    tabSymbol: 'P',
    staffSymbol: 'P',
  },
  {
    id: 'palm-mute',
    label: '闷音 (P.M.)',
    shortLabel: '闷音',
    tabSymbol: 'P.M.',
    staffSymbol: 'P.M.',
  },
  {
    id: 'vibrato',
    label: '震音 (Vib)',
    shortLabel: '震音',
    tabSymbol: '~~~',
    staffSymbol: '~~~',
  },
];

export const VALID_GUITAR_TECHNIQUES: ReadonlySet<GuitarTechnique> = new Set(
  GUITAR_TECHNIQUE_OPTIONS.map((item) => item.id)
);

export function normalizeGuitarTechniques(
  input: readonly string[] | undefined
): GuitarTechnique[] {
  if (!input || input.length === 0) {
    return [];
  }
  const seen = new Set<GuitarTechnique>();
  for (const raw of input) {
    if (VALID_GUITAR_TECHNIQUES.has(raw as GuitarTechnique)) {
      seen.add(raw as GuitarTechnique);
    }
  }
  return GUITAR_TECHNIQUE_OPTIONS.map((item) => item.id).filter((id) =>
    seen.has(id)
  );
}

export type PracticeDockType = 'fretboard' | 'piano-keys' | 'melody-bar';

export type TuningPresetId =
  | 'standard-6'
  | 'drop-d-6'
  | 'eb-standard-6'
  | 'bass-4-standard'
  | 'bass-5-standard';

export interface TuningPreset {
  id: TuningPresetId;
  label: string;
  instrumentCategory: 'guitar' | 'bass';
  stringCount: 4 | 5 | 6;
  openStringMidis: readonly number[];
  stringLabels: readonly string[];
}

export interface InstrumentProfile {
  id: InstrumentId;
  name: string;
  shortName: string;
  category: 'guitar' | 'piano' | 'bass' | 'melody';
  defaultViews: readonly ViewLayerType[];
  defaultClef: Track['clef'];
  dockType: PracticeDockType;
  stringCount: number;
  maxFret: number;
  defaultTuningId?: TuningPresetId;
  availableTuningIds: readonly TuningPresetId[];
  supportsCapo: boolean;
  supportsGuitarTone: boolean;
  midiRange: readonly [number, number];
  description: string;
}

export const TUNING_PRESETS: Readonly<Record<TuningPresetId, TuningPreset>> = {
  'standard-6': {
    id: 'standard-6',
    label: '标准调弦 (EADGBE)',
    instrumentCategory: 'guitar',
    stringCount: 6,
    openStringMidis: [64, 59, 55, 50, 45, 40],
    stringLabels: ['e', 'B', 'G', 'D', 'A', 'E'],
  },
  'drop-d-6': {
    id: 'drop-d-6',
    label: 'Drop D (DADGBE)',
    instrumentCategory: 'guitar',
    stringCount: 6,
    openStringMidis: [64, 59, 55, 50, 45, 38],
    stringLabels: ['e', 'B', 'G', 'D', 'A', 'D'],
  },
  'eb-standard-6': {
    id: 'eb-standard-6',
    label: '降半音 (Eb)',
    instrumentCategory: 'guitar',
    stringCount: 6,
    openStringMidis: [63, 58, 54, 49, 44, 39],
    stringLabels: ['eb', 'Bb', 'Gb', 'Db', 'Ab', 'Eb'],
  },
  'bass-4-standard': {
    id: 'bass-4-standard',
    label: '4弦标准 (EADG)',
    instrumentCategory: 'bass',
    stringCount: 4,
    openStringMidis: [43, 38, 33, 28],
    stringLabels: ['G', 'D', 'A', 'E'],
  },
  'bass-5-standard': {
    id: 'bass-5-standard',
    label: '5弦标准 (BEADG)',
    instrumentCategory: 'bass',
    stringCount: 5,
    openStringMidis: [43, 38, 33, 28, 23],
    stringLabels: ['G', 'D', 'A', 'E', 'B'],
  },
};

export const INSTRUMENT_PROFILES: Readonly<
  Record<InstrumentId, InstrumentProfile>
> = {
  'electric-guitar-clean': {
    id: 'electric-guitar-clean',
    name: '电吉他（清音）',
    shortName: '电吉他',
    category: 'guitar',
    defaultViews: ['staff', 'tab'],
    defaultClef: 'treble',
    dockType: 'fretboard',
    stringCount: 6,
    maxFret: 24,
    defaultTuningId: 'standard-6',
    availableTuningIds: ['standard-6', 'drop-d-6', 'eb-standard-6'],
    supportsCapo: true,
    supportsGuitarTone: true,
    midiRange: [40, 88],
    description: '6 线谱 TAB + 24 品实时指板，支持清音/过载音色与调弦/变调夹',
  },
  'electric-guitar-od': {
    id: 'electric-guitar-od',
    name: '电吉他（过载）',
    shortName: '电吉他',
    category: 'guitar',
    defaultViews: ['staff', 'tab'],
    defaultClef: 'treble',
    dockType: 'fretboard',
    stringCount: 6,
    maxFret: 24,
    defaultTuningId: 'standard-6',
    availableTuningIds: ['standard-6', 'drop-d-6', 'eb-standard-6'],
    supportsCapo: true,
    supportsGuitarTone: true,
    midiRange: [40, 88],
    description: '6 线谱 TAB + 24 品实时指板，过载失真箱头效果链',
  },
  'acoustic-guitar': {
    id: 'acoustic-guitar',
    name: '木吉他',
    shortName: '木吉他',
    category: 'guitar',
    defaultViews: ['staff', 'tab'],
    defaultClef: 'treble',
    dockType: 'fretboard',
    stringCount: 6,
    maxFret: 20,
    defaultTuningId: 'standard-6',
    availableTuningIds: ['standard-6', 'drop-d-6', 'eb-standard-6'],
    supportsCapo: true,
    supportsGuitarTone: false,
    midiRange: [40, 84],
    description: '原声吉他拨弦音色 + 6 线谱 TAB 与 20 品指板把位提示',
  },
  piano: {
    id: 'piano',
    name: '钢琴',
    shortName: '钢琴',
    category: 'piano',
    defaultViews: ['staff', 'jianpu'],
    defaultClef: 'grand',
    dockType: 'piano-keys',
    stringCount: 0,
    maxFret: 0,
    availableTuningIds: [],
    supportsCapo: false,
    supportsGuitarTone: false,
    midiRange: [21, 108],
    description: '88 键实时高亮键盘，区分右手 Voice 1 与左手 Voice 2 并支持单手静音',
  },
  bass: {
    id: 'bass',
    name: '电贝斯',
    shortName: '电贝斯',
    category: 'bass',
    defaultViews: ['staff', 'tab'],
    defaultClef: 'bass',
    dockType: 'fretboard',
    stringCount: 4,
    maxFret: 24,
    defaultTuningId: 'bass-4-standard',
    availableTuningIds: ['bass-4-standard', 'bass-5-standard'],
    supportsCapo: false,
    supportsGuitarTone: false,
    midiRange: [23, 67],
    description: '低音谱号 + 4/5 弦 TAB 与 24 品贝斯指板实时高亮',
  },
  melody: {
    id: 'melody',
    name: '通用旋律',
    shortName: '通用旋律',
    category: 'melody',
    defaultViews: ['staff', 'jianpu'],
    defaultClef: 'treble',
    dockType: 'melody-bar',
    stringCount: 0,
    maxFret: 0,
    availableTuningIds: [],
    supportsCapo: false,
    supportsGuitarTone: false,
    midiRange: [36, 96],
    description: '简谱 + 五线谱经典双谱视图，带实时歌词字幕与音名提示',
  },
};

export const PRACTICE_INSTRUMENT_IDS: readonly InstrumentId[] = [
  'electric-guitar-clean',
  'acoustic-guitar',
  'piano',
  'bass',
  'melody',
];

export function getInstrumentProfile(id: InstrumentId): InstrumentProfile {
  return INSTRUMENT_PROFILES[id] ?? INSTRUMENT_PROFILES.piano;
}

export function getTuningPreset(id: TuningPresetId): TuningPreset {
  return TUNING_PRESETS[id] ?? TUNING_PRESETS['standard-6'];
}

export function clampCapo(capo: number | undefined): number {
  if (typeof capo !== 'number' || !Number.isFinite(capo)) {
    return 0;
  }
  return Math.max(0, Math.min(12, Math.round(capo)));
}

export function getEffectiveOpenMidis(
  openStringMidis: readonly number[],
  capo = 0
): number[] {
  const safeCapo = clampCapo(capo);
  return openStringMidis.map((m) => m + safeCapo);
}

const NOTE_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
];

export function midiToNoteLabel(midi: number): string {
  const rounded = Math.round(midi);
  const pc = ((rounded % 12) + 12) % 12;
  const octave = Math.floor(rounded / 12) - 1;
  return `${NOTE_NAMES[pc] ?? 'C'}${octave}`;
}

export interface FretboardNoteInput {
  noteId: string;
  midiPitch: number | null;
  manualPosition?: { string: number; fret: number } | null;
}

export interface FretboardPosition {
  noteId: string;
  midiPitch: number;
  effectiveMidiPitch: number;
  string: number;
  fret: number;
  physicalFret: number;
  isManual: boolean;
  octaveAdjusted: boolean;
}

export interface FretboardAssignOptions {
  openStringMidis: readonly number[];
  capo?: number;
  maxFret?: number;
  manualPositions?: Readonly<
    Record<string, { string: number; fret: number } | undefined>
  >;
}

export interface ValidFretCandidate {
  string: number;
  fret: number;
  physicalFret: number;
}

export function getValidFretPositions(
  midiPitch: number,
  openStringMidis: readonly number[],
  capo = 0,
  maxFret = 24
): ValidFretCandidate[] {
  const safeCapo = clampCapo(capo);
  const maxRelativeFret = Math.max(0, maxFret - safeCapo);
  const candidates: ValidFretCandidate[] = [];

  for (let i = 0; i < openStringMidis.length; i += 1) {
    const openMidi = openStringMidis[i];
    if (openMidi === undefined) {
      continue;
    }
    const relativeFret = Math.round(midiPitch) - (openMidi + safeCapo);
    if (relativeFret >= 0 && relativeFret <= maxRelativeFret) {
      candidates.push({
        string: i + 1,
        fret: relativeFret,
        physicalFret: safeCapo + relativeFret,
      });
    }
  }

  return candidates;
}

function foldMidiIntoRange(
  midiPitch: number,
  minMidi: number,
  maxMidi: number
): number {
  let current = Math.round(midiPitch);
  while (current < minMidi && current + 12 <= maxMidi) {
    current += 12;
  }
  while (current > maxMidi && current - 12 >= minMidi) {
    current -= 12;
  }
  if (current < minMidi) {
    current = minMidi;
  } else if (current > maxMidi) {
    current = maxMidi;
  }
  return current;
}

function scoreCandidate(
  candidate: ValidFretCandidate,
  prev: { string: number; fret: number } | null
): number {
  let cost = 0;
  if (candidate.fret === 0) {
    cost -= 0.4;
  } else {
    cost += candidate.fret * 0.25;
  }
  if (candidate.fret > 12) {
    cost += (candidate.fret - 12) * 1.5;
  }
  if (prev) {
    cost += Math.abs(candidate.fret - prev.fret) * 1.2;
    cost += Math.abs(candidate.string - prev.string) * 0.35;
  }
  return cost;
}

export function assignFretboardPositions(
  notes: readonly FretboardNoteInput[],
  options: FretboardAssignOptions
): Record<string, FretboardPosition> {
  const openStringMidis = options.openStringMidis;
  if (openStringMidis.length === 0) {
    return {};
  }

  const safeCapo = clampCapo(options.capo);
  const maxFret = Math.max(safeCapo, options.maxFret ?? 24);
  const maxRelativeFret = maxFret - safeCapo;
  const effectiveOpens = getEffectiveOpenMidis(openStringMidis, safeCapo);
  const minPlayableMidi = Math.min(...effectiveOpens);
  const maxPlayableMidi = Math.max(...effectiveOpens) + maxRelativeFret;

  const result: Record<string, FretboardPosition> = {};
  let prev: { string: number; fret: number } | null = null;

  for (const note of notes) {
    if (note.midiPitch === null) {
      continue;
    }

    const manual =
      note.manualPosition ?? options.manualPositions?.[note.noteId] ?? null;
    if (
      manual &&
      Number.isInteger(manual.string) &&
      manual.string >= 1 &&
      manual.string <= openStringMidis.length &&
      Number.isInteger(manual.fret) &&
      manual.fret >= 0 &&
      manual.fret <= maxRelativeFret
    ) {
      const openBase = effectiveOpens[manual.string - 1] ?? minPlayableMidi;
      const effectiveMidi = openBase + manual.fret;
      result[note.noteId] = {
        noteId: note.noteId,
        midiPitch: note.midiPitch,
        effectiveMidiPitch: effectiveMidi,
        string: manual.string,
        fret: manual.fret,
        physicalFret: safeCapo + manual.fret,
        isManual: true,
        octaveAdjusted: effectiveMidi !== note.midiPitch,
      };
      prev = { string: manual.string, fret: manual.fret };
      continue;
    }

    let candidates = getValidFretPositions(
      note.midiPitch,
      openStringMidis,
      safeCapo,
      maxFret
    );
    let effectiveMidi = note.midiPitch;
    let octaveAdjusted = false;

    if (candidates.length === 0) {
      effectiveMidi = foldMidiIntoRange(
        note.midiPitch,
        minPlayableMidi,
        maxPlayableMidi
      );
      octaveAdjusted = effectiveMidi !== note.midiPitch;
      candidates = getValidFretPositions(
        effectiveMidi,
        openStringMidis,
        safeCapo,
        maxFret
      );
    }

    if (candidates.length === 0) {
      continue;
    }

    let best = candidates[0]!;
    let bestCost = scoreCandidate(best, prev);
    for (let i = 1; i < candidates.length; i += 1) {
      const cand = candidates[i]!;
      const cost = scoreCandidate(cand, prev);
      if (cost < bestCost) {
        best = cand;
        bestCost = cost;
      }
    }

    result[note.noteId] = {
      noteId: note.noteId,
      midiPitch: note.midiPitch,
      effectiveMidiPitch: effectiveMidi,
      string: best.string,
      fret: best.fret,
      physicalFret: best.physicalFret,
      isManual: false,
      octaveAdjusted,
    };
    prev = { string: best.string, fret: best.fret };
  }

  return result;
}

export function cycleManualFretPosition(
  midiPitch: number,
  current: { string: number; fret: number } | undefined,
  openStringMidis: readonly number[],
  capo = 0,
  maxFret = 24
): ValidFretCandidate | null {
  const safeCapo = clampCapo(capo);
  const maxRelativeFret = Math.max(0, maxFret - safeCapo);
  const effectiveOpens = getEffectiveOpenMidis(openStringMidis, safeCapo);
  if (effectiveOpens.length === 0) {
    return null;
  }

  const minPlayableMidi = Math.min(...effectiveOpens);
  const maxPlayableMidi = Math.max(...effectiveOpens) + maxRelativeFret;
  let candidates = getValidFretPositions(
    midiPitch,
    openStringMidis,
    safeCapo,
    maxFret
  );
  if (candidates.length === 0) {
    const folded = foldMidiIntoRange(
      midiPitch,
      minPlayableMidi,
      maxPlayableMidi
    );
    candidates = getValidFretPositions(
      folded,
      openStringMidis,
      safeCapo,
      maxFret
    );
  }
  if (candidates.length === 0) {
    return null;
  }
  if (!current) {
    return candidates[0] ?? null;
  }
  const currentIdx = candidates.findIndex(
    (c) => c.string === current.string && c.fret === current.fret
  );
  if (currentIdx === -1) {
    return candidates[0] ?? null;
  }
  const nextIdx = (currentIdx + 1) % candidates.length;
  return candidates[nextIdx] ?? candidates[0] ?? null;
}
