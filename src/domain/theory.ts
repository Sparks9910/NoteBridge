import type {
  Accidental,
  BaseDuration,
  KeySignature,
  Measure,
  NoteEvent,
  ResolvedNote,
  ScoreDocument,
} from './types.ts';
import {
  computeMeasureDisplayAccidentals,
  type AccidentalOffset,
  type MeasureAccidentalInput,
  type StaffLetter,
} from './accidental.ts';

export const VALID_KEY_SIGNATURES: readonly KeySignature[] = [
  'C',
  'G',
  'D',
  'A',
  'E',
  'B',
  'F',
  'Bb',
  'Eb',
  'Ab',
  'Db',
  'Gb',
];

/**
 * 12 大调简谱 "1" 对应的默认基准 MIDI 音高。
 * 严格遵循假设 A-05：Ab/A/Bb/B 落第 3 八度（56..59），其余落第 4 八度（60..67）。
 */
export const KEY_BASE_MIDI_MAP: Record<KeySignature, number> = {
  Ab: 56,
  A: 57,
  Bb: 58,
  B: 59,
  C: 60,
  Db: 61,
  D: 62,
  Eb: 63,
  E: 64,
  F: 65,
  Gb: 66,
  G: 67,
};

interface ScaleDegreeSpec {
  letter: StaffLetter;
  octaveDelta: 0 | 1;
  keyOffset: AccidentalOffset;
  semitoneFromTonic: number;
}

const MAJOR_SCALE_SEMITONES = [0, 2, 4, 5, 7, 9, 11] as const;

const LETTERS: readonly StaffLetter[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

const LETTER_INDEX: Record<StaffLetter, number> = {
  C: 0,
  D: 1,
  E: 2,
  F: 3,
  G: 4,
  A: 5,
  B: 6,
};

const KEY_SPELLING_TABLE: Record<
  KeySignature,
  readonly [
    ScaleDegreeSpec,
    ScaleDegreeSpec,
    ScaleDegreeSpec,
    ScaleDegreeSpec,
    ScaleDegreeSpec,
    ScaleDegreeSpec,
    ScaleDegreeSpec,
  ]
> = (() => {
  const buildScale = (
    tonicLetter: StaffLetter,
    offsets: readonly [
      AccidentalOffset,
      AccidentalOffset,
      AccidentalOffset,
      AccidentalOffset,
      AccidentalOffset,
      AccidentalOffset,
      AccidentalOffset,
    ]
  ) => {
    const startIdx = LETTER_INDEX[tonicLetter];
    const specs: ScaleDegreeSpec[] = [];
    for (let i = 0; i < 7; i += 1) {
      const rawIndex = startIdx + i;
      const letter = LETTERS[rawIndex % 7] ?? 'C';
      const octaveDelta: 0 | 1 = rawIndex >= 7 ? 1 : 0;
      const keyOffset = offsets[i] ?? 0;
      const semitoneFromTonic = MAJOR_SCALE_SEMITONES[i] ?? 0;
      specs.push({ letter, octaveDelta, keyOffset, semitoneFromTonic });
    }
    return specs as unknown as readonly [
      ScaleDegreeSpec,
      ScaleDegreeSpec,
      ScaleDegreeSpec,
      ScaleDegreeSpec,
      ScaleDegreeSpec,
      ScaleDegreeSpec,
      ScaleDegreeSpec,
    ];
  };

  return {
    C: buildScale('C', [0, 0, 0, 0, 0, 0, 0]),
    G: buildScale('G', [0, 0, 0, 0, 0, 0, 1]),
    D: buildScale('D', [0, 0, 1, 0, 0, 0, 1]),
    A: buildScale('A', [0, 0, 1, 0, 0, 1, 1]),
    E: buildScale('E', [0, 1, 1, 0, 0, 1, 1]),
    B: buildScale('B', [0, 1, 1, 0, 1, 1, 1]),
    F: buildScale('F', [0, 0, 0, -1, 0, 0, 0]),
    Bb: buildScale('B', [-1, 0, 0, -1, 0, 0, 0]),
    Eb: buildScale('E', [-1, 0, 0, -1, -1, 0, 0]),
    Ab: buildScale('A', [-1, -1, 0, -1, -1, 0, 0]),
    Db: buildScale('D', [-1, -1, 0, -1, -1, -1, 0]),
    Gb: buildScale('G', [-1, -1, -1, -1, -1, -1, 0]),
  };
})();

const FLAT_KEY_PREFERENCE: ReadonlySet<KeySignature> = new Set([
  'F',
  'Bb',
  'Eb',
  'Ab',
  'Db',
  'Gb',
]);

const SHARP_SPELLING_FROM_PC: readonly {
  letter: StaffLetter;
  offset: AccidentalOffset;
}[] = [
  { letter: 'C', offset: 0 },
  { letter: 'C', offset: 1 },
  { letter: 'D', offset: 0 },
  { letter: 'D', offset: 1 },
  { letter: 'E', offset: 0 },
  { letter: 'F', offset: 0 },
  { letter: 'F', offset: 1 },
  { letter: 'G', offset: 0 },
  { letter: 'G', offset: 1 },
  { letter: 'A', offset: 0 },
  { letter: 'A', offset: 1 },
  { letter: 'B', offset: 0 },
];

const FLAT_SPELLING_FROM_PC: readonly {
  letter: StaffLetter;
  offset: AccidentalOffset;
}[] = [
  { letter: 'C', offset: 0 },
  { letter: 'D', offset: -1 },
  { letter: 'D', offset: 0 },
  { letter: 'E', offset: -1 },
  { letter: 'E', offset: 0 },
  { letter: 'F', offset: 0 },
  { letter: 'G', offset: -1 },
  { letter: 'G', offset: 0 },
  { letter: 'A', offset: -1 },
  { letter: 'A', offset: 0 },
  { letter: 'B', offset: -1 },
  { letter: 'B', offset: 0 },
];

export interface PitchSpelling {
  midiPitch: number;
  letter: StaffLetter;
  octave: number;
  effectiveOffset: AccidentalOffset;
  staffPitchName: string;
}

function formatStaffPitchName(
  letter: StaffLetter,
  offset: AccidentalOffset,
  octave: number
): string {
  const symbol = offset === 1 ? '#' : offset === -1 ? 'b' : '';
  return `${letter}${symbol}/${octave}`;
}

function clampMidi(midi: number): number {
  return Math.max(0, Math.min(127, midi));
}

function spellMidiEnharmonic(
  midiPitch: number,
  preferFlat: boolean
): { letter: StaffLetter; octave: number; effectiveOffset: AccidentalOffset } {
  const pc = ((midiPitch % 12) + 12) % 12;
  const octave = Math.floor(midiPitch / 12) - 1;
  const table = preferFlat ? FLAT_SPELLING_FROM_PC : SHARP_SPELLING_FROM_PC;
  const entry = table[pc] ?? { letter: 'C' as StaffLetter, offset: 0 as AccidentalOffset };
  return {
    letter: entry.letter,
    octave,
    effectiveOffset: entry.offset,
  };
}

function getAccidentalDelta(accidental: Accidental): AccidentalOffset {
  if (accidental === 'sharp') {
    return 1;
  }
  if (accidental === 'flat') {
    return -1;
  }
  return 0;
}

/** 将简谱音符按当前调号解析为绝对 MIDI 音高与五线谱拼写 */
export function resolveNotePitch(
  note: NoteEvent,
  keySignature: KeySignature
): PitchSpelling | null {
  if (note.isRest || note.degree === 0) {
    return null;
  }

  const baseMidi = KEY_BASE_MIDI_MAP[keySignature];
  const baseOctave = Math.floor(baseMidi / 12) - 1;
  const scale = KEY_SPELLING_TABLE[keySignature];
  const degreeSpec = scale[note.degree - 1];
  if (!degreeSpec) {
    return null;
  }

  const accidentalDelta = getAccidentalDelta(note.accidental);
  const rawMidi =
    baseMidi +
    degreeSpec.semitoneFromTonic +
    note.octaveOffset * 12 +
    accidentalDelta;
  const midiPitch = clampMidi(rawMidi);

  const rawOffset = degreeSpec.keyOffset + accidentalDelta;
  let letter = degreeSpec.letter;
  let octave = baseOctave + degreeSpec.octaveDelta + note.octaveOffset;
  let effectiveOffset: AccidentalOffset;

  if (
    rawMidi !== midiPitch ||
    rawOffset < -1 ||
    rawOffset > 1
  ) {
    const preferFlat = FLAT_KEY_PREFERENCE.has(keySignature) || accidentalDelta < 0;
    const enharmonic = spellMidiEnharmonic(midiPitch, preferFlat);
    letter = enharmonic.letter;
    octave = enharmonic.octave;
    effectiveOffset = enharmonic.effectiveOffset;
  } else {
    effectiveOffset = rawOffset as AccidentalOffset;
  }

  return {
    midiPitch,
    letter,
    octave,
    effectiveOffset,
    staffPitchName: formatStaffPitchName(letter, effectiveOffset, octave),
  };
}

/** 计算高音谱号下的符干方向（第三线 B4 及以上朝下，以下朝上，全音符无符干） */
export function computeStemDirection(
  letter: StaffLetter,
  octave: number,
  baseDuration: BaseDuration
): 'up' | 'down' | null {
  if (baseDuration === 'whole') {
    return null;
  }
  const diatonicStep = octave * 7 + LETTER_INDEX[letter];
  const b4Step = 4 * 7 + LETTER_INDEX.B; // 34
  return diatonicStep < b4Step ? 'up' : 'down';
}

/** 解析单个小节内所有音符的渲染与发声信息 */
export function resolveMeasureNotes(
  measure: Measure,
  keySignature: KeySignature,
  measureStartTick: number
): ResolvedNote[] {
  const spellings = measure.notes.map((note) =>
    resolveNotePitch(note, keySignature)
  );
  const accidentalInputs: MeasureAccidentalInput[] = spellings.map((s) =>
    s
      ? {
          letter: s.letter,
          octave: s.octave,
          effectiveOffset: s.effectiveOffset,
        }
      : null
  );
  const displayAccidentals = computeMeasureDisplayAccidentals(
    keySignature,
    accidentalInputs
  );

  const resolved: ResolvedNote[] = [];
  let cursorTick = measureStartTick;

  for (let i = 0; i < measure.notes.length; i += 1) {
    const note = measure.notes[i];
    if (!note) {
      continue;
    }
    const spelling = spellings[i] ?? null;
    const displayAccidental = displayAccidentals[i] ?? null;

    resolved.push({
      noteId: note.id,
      measureIndex: measure.index,
      startTickInScore: cursorTick,
      durationTicks: note.durationTicks,
      midiPitch: spelling ? spelling.midiPitch : null,
      staffPitchName: spelling ? spelling.staffPitchName : null,
      displayAccidental: spelling ? displayAccidental : null,
      stemDirection: spelling
        ? computeStemDirection(
            spelling.letter,
            spelling.octave,
            note.baseDuration
          )
        : null,
    });

    cursorTick += note.durationTicks;
  }

  return resolved;
}

/** 解析整份 ScoreDocument，输出按全局 Tick 排列的 ResolvedNote 列表 */
export function resolveScoreNotes(doc: ScoreDocument): ResolvedNote[] {
  const result: ResolvedNote[] = [];
  let currentTick = 0;

  for (const measure of doc.measures) {
    const measureResolved = resolveMeasureNotes(
      measure,
      doc.keySignature,
      currentTick
    );
    result.push(...measureResolved);
    for (const note of measure.notes) {
      currentTick += note.durationTicks;
    }
  }

  return result;
}
