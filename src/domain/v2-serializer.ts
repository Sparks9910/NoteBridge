import { normalizeGuitarTechniques } from './v2-instruments.ts';
import {
  calculateDurationTicks,
  VALID_BASE_DURATIONS,
  VALID_TIME_SIGNATURES,
} from './rhythm.ts';
import {
  createAppError,
  validateScoreDocument,
} from './serializer.ts';
import { resolveNotePitch, VALID_KEY_SIGNATURES } from './theory.ts';
import { midiToJianpuNoteSpec } from './transpose.ts';
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
import type {
  Beat,
  DynamicMarking,
  InstrumentId,
  LibraryBackupBundle,
  MeasureBarlineType,
  OrnamentType,
  PitchNode,
  ScoreDocumentV2,
  ScoreMetadata,
  Track,
  V2Measure,
  ViewLayerType,
  Voice,
} from './v2-types.ts';

const VALID_VIEW_MODES: ReadonlySet<ViewMode> = new Set(['dual', 'jianpu', 'staff']);
const VALID_VIEW_LAYERS: ReadonlySet<ViewLayerType> = new Set([
  'staff',
  'jianpu',
  'tab',
]);
const VALID_INSTRUMENTS: ReadonlySet<InstrumentId> = new Set([
  'piano',
  'electric-guitar-clean',
  'electric-guitar-od',
  'acoustic-guitar',
  'bass',
  'melody',
]);
const VALID_CLEFS: ReadonlySet<Track['clef']> = new Set(['treble', 'bass', 'grand']);
const VALID_ACCIDENTALS: ReadonlySet<Accidental> = new Set([
  'sharp',
  'flat',
  'natural',
  null,
]);
const VALID_OCTAVES: ReadonlySet<number> = new Set([-2, -1, 0, 1, 2]);
const VALID_DEGREES: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6, 7]);
const VALID_DYNAMICS: ReadonlySet<DynamicMarking> = new Set([
  'pp',
  'p',
  'mp',
  'mf',
  'f',
  'ff',
  'fp',
]);
const VALID_ORNAMENTS: ReadonlySet<OrnamentType> = new Set([
  'trill',
  'staccato',
  'accent',
  'fermata',
]);
const VALID_BARLINES: ReadonlySet<MeasureBarlineType> = new Set([
  'single',
  'double',
  'final',
]);

const DURATION_CANDIDATES: ReadonlyArray<{
  baseDuration: BaseDuration;
  dotted: boolean;
  ticks: number;
}> = [
  { baseDuration: 'whole', dotted: false, ticks: 1920 },
  { baseDuration: 'half', dotted: true, ticks: 1440 },
  { baseDuration: 'half', dotted: false, ticks: 960 },
  { baseDuration: 'quarter', dotted: true, ticks: 720 },
  { baseDuration: 'quarter', dotted: false, ticks: 480 },
  { baseDuration: 'eighth', dotted: true, ticks: 360 },
  { baseDuration: 'eighth', dotted: false, ticks: 240 },
  { baseDuration: 'sixteenth', dotted: true, ticks: 180 },
  { baseDuration: 'sixteenth', dotted: false, ticks: 120 },
];

/** 将任意正整数 Ticks 量化为最接近的标准基础时值与附点组合 */
export function quantizeTicksToDuration(ticks: number): {
  baseDuration: BaseDuration;
  dotted: boolean;
  durationTicks: number;
} {
  const safeTicks = Math.max(120, Math.round(ticks));
  let best = DURATION_CANDIDATES[4]!;
  let minDiff = Math.abs(safeTicks - best.ticks);

  for (const candidate of DURATION_CANDIDATES) {
    const diff = Math.abs(safeTicks - candidate.ticks);
    if (diff < minDiff) {
      minDiff = diff;
      best = candidate;
    }
  }

  return {
    baseDuration: best.baseDuration,
    dotted: best.dotted,
    durationTicks: calculateDurationTicks(best.baseDuration, best.dotted),
  };
}

/** 将 MIDI 绝对音高反解为 V2 PitchNode */
export function mapMidiToPitchNode(
  midiPitch: number,
  keySignature: KeySignature,
  id: string,
  preferFlat?: boolean
): PitchNode {
  const clampedMidi = Math.max(24, Math.min(108, Math.round(midiPitch)));
  const spec = midiToJianpuNoteSpec(clampedMidi, keySignature, preferFlat);
  return {
    id,
    midiPitch: clampedMidi,
    degree: spec.degree,
    octaveOffset: spec.octaveOffset,
    accidental: spec.accidental,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failV2<T>(
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

function viewModeToLayers(viewMode: ViewMode): ViewLayerType[] {
  if (viewMode === 'dual') {
    return ['staff', 'jianpu'];
  }
  return [viewMode];
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 将 P0 v1 乐谱无损迁移为 V2 多轨 AST 模型 */
export function migrateV1ToV2(
  v1: ScoreDocument,
  meta?: ScoreMetadata
): ScoreDocumentV2 {
  const measures: V2Measure[] = v1.measures.map((m) => ({
    id: m.id,
    index: m.index,
    beats: m.notes.map((note): Beat => {
      if (note.isRest || note.degree === 0) {
        return {
          id: note.id,
          isRest: true,
          baseDuration: note.baseDuration,
          dotted: note.dotted,
          durationTicks: note.durationTicks,
          notes: [],
        };
      }
      const spelling = resolveNotePitch(note, v1.keySignature);
      const pitchNode: PitchNode = {
        id: `${note.id}_p0`,
        midiPitch: spelling ? spelling.midiPitch : 60,
        degree: note.degree,
        octaveOffset: note.octaveOffset,
        accidental: note.accidental,
      };
      return {
        id: note.id,
        isRest: false,
        baseDuration: note.baseDuration,
        dotted: note.dotted,
        durationTicks: note.durationTicks,
        notes: [pitchNode],
      };
    }),
  }));

  const mainVoice: Voice = {
    id: 'voice_1',
    index: 0,
    measures,
  };

  const mainTrack: Track = {
    id: 'track_main',
    name: '主旋律',
    instrumentId: 'piano',
    clef: 'treble',
    enabledViews: viewModeToLayers(v1.viewMode),
    voices: [mainVoice],
  };

  const docV2: ScoreDocumentV2 = {
    schemaVersion: 2,
    id: v1.id,
    title: v1.title,
    keySignature: v1.keySignature,
    timeSignature: v1.timeSignature,
    bpm: v1.bpm,
    viewMode: v1.viewMode,
    tracks: [mainTrack],
    updatedAtEpochMs: v1.updatedAtEpochMs,
  };

  const subtitle = normalizeOptionalString(meta?.subtitle);
  const composer = normalizeOptionalString(meta?.composer);
  const lyricist = normalizeOptionalString(meta?.lyricist);
  if (subtitle) {
    docV2.subtitle = subtitle;
  }
  if (composer) {
    docV2.composer = composer;
  }
  if (lyricist) {
    docV2.lyricist = lyricist;
  }

  return docV2;
}

/** 将 V2 指定轨道与声部无损投影回 P0 v1 视图模型 */
export function projectTrackVoiceToV1(
  v2: ScoreDocumentV2,
  trackIndex = 0,
  voiceIndex = 0
): ScoreDocument {
  const targetTrack = v2.tracks[trackIndex] ?? v2.tracks[0];
  const targetVoice = targetTrack?.voices[voiceIndex] ?? targetTrack?.voices[0];
  const sourceMeasures = targetVoice?.measures ?? [];

  const measures: Measure[] = sourceMeasures.map((m, idx) => {
    const notes: NoteEvent[] = m.beats.map((beat) => {
      const lead = beat.notes[0];
      if (beat.isRest || !lead) {
        return {
          id: beat.id,
          isRest: true,
          degree: 0,
          octaveOffset: 0,
          accidental: null,
          baseDuration: beat.baseDuration,
          dotted: beat.dotted,
          durationTicks: beat.durationTicks,
        };
      }
      return {
        id: beat.id,
        isRest: false,
        degree: lead.degree,
        octaveOffset: lead.octaveOffset,
        accidental: lead.accidental,
        baseDuration: beat.baseDuration,
        dotted: beat.dotted,
        durationTicks: beat.durationTicks,
      };
    });

    return {
      id: m.id,
      index: idx,
      notes,
    };
  });

  if (measures.length === 0) {
    measures.push({
      id: 'm_0',
      index: 0,
      notes: [],
    });
  }

  return {
    schemaVersion: 1,
    id: v2.id,
    title: v2.title,
    keySignature: v2.keySignature,
    timeSignature: v2.timeSignature,
    bpm: v2.bpm,
    viewMode: v2.viewMode,
    measures,
    updatedAtEpochMs: v2.updatedAtEpochMs,
  };
}

/** 将 V2 主轨主声部无损投影回 P0 v1 视图模型 */
export function projectV2ToV1(v2: ScoreDocumentV2): ScoreDocument {
  return projectTrackVoiceToV1(v2, 0, 0);
}

/** 从多轨 V2 乐谱提取选定轨道生成独立分谱 */
export function extractPartsFromScoreV2(
  v2: ScoreDocumentV2,
  trackIds: readonly string[]
): Result<ScoreDocumentV2> {
  const idSet = new Set(trackIds);
  const selectedTracks = v2.tracks
    .filter((t) => idSet.has(t.id))
    .map((t) => ({
      ...t,
      enabledViews: [...t.enabledViews],
      voices: t.voices.map((v) => ({
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
    }));

  if (selectedTracks.length === 0) {
    return {
      ok: false,
      error: createAppError(
        'RESOURCE_NOT_FOUND',
        '未找到勾选的分谱轨道，请至少保留一条有效轨道',
        'trackIds'
      ),
    };
  }

  const partLabel =
    selectedTracks.length === 1
      ? `${selectedTracks[0]!.name}分谱`
      : `分谱（${selectedTracks.map((t) => t.name).join(' + ')}）`;

  return {
    ok: true,
    value: {
      ...v2,
      id: `${v2.id}_part`,
      title: `${v2.title} - ${partLabel}`,
      tracks: selectedTracks,
    },
  };
}

/** 从指定轨道中提取单个声部作为独立分谱（例如钢琴右手 Voice 1 或左手 Voice 2） */
export function extractVoiceAsPartV2(
  v2: ScoreDocumentV2,
  trackId: string,
  voiceIndex: number
): Result<ScoreDocumentV2> {
  const track = v2.tracks.find((t) => t.id === trackId);
  if (!track) {
    return {
      ok: false,
      error: createAppError('RESOURCE_NOT_FOUND', '未找到指定分谱轨道', 'trackId'),
    };
  }
  const voice = track.voices[voiceIndex];
  if (!voice) {
    return {
      ok: false,
      error: createAppError(
        'RESOURCE_NOT_FOUND',
        `轨道「${track.name}」中不存在第 ${voiceIndex + 1} 声部`,
        'voiceIndex'
      ),
    };
  }

  const voiceLabel = voiceIndex === 0 ? '高音/右手声部' : `第 ${voiceIndex + 1} 声部`;
  const clonedTrack: Track = {
    ...track,
    name: `${track.name}（${voiceLabel}）`,
    clef: voiceIndex === 1 && track.clef === 'grand' ? 'bass' : track.clef === 'grand' ? 'treble' : track.clef,
    enabledViews: [...track.enabledViews],
    voices: [
      {
        ...voice,
        index: 0,
        measures: voice.measures.map((m) => ({
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
      },
    ],
  };

  return {
    ok: true,
    value: {
      ...v2,
      id: `${v2.id}_part_v${voiceIndex + 1}`,
      title: `${v2.title} - ${clonedTrack.name}`,
      tracks: [clonedTrack],
    },
  };
}

function validatePitchNode(raw: unknown, path: string): Result<PitchNode> {
  if (!isRecord(raw)) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', 'V2 音高节点格式损坏', path);
  }
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '音高节点缺少有效标识', `${path}.id`);
  }
  if (
    typeof raw.midiPitch !== 'number' ||
    !Number.isInteger(raw.midiPitch) ||
    raw.midiPitch < 0 ||
    raw.midiPitch > 127
  ) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '音高 MIDI 数值无效', `${path}.midiPitch`);
  }
  if (typeof raw.degree !== 'number' || !VALID_DEGREES.has(raw.degree)) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '音级必须为 1 到 7 的整数', `${path}.degree`);
  }
  if (
    typeof raw.octaveOffset !== 'number' ||
    !VALID_OCTAVES.has(raw.octaveOffset)
  ) {
    return failV2(
      'STORAGE_SCHEMA_CORRUPTED',
      '八度偏移必须为 -2 到 2 的整数',
      `${path}.octaveOffset`
    );
  }
  if (!VALID_ACCIDENTALS.has(raw.accidental as Accidental)) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '临时升降号类型无效', `${path}.accidental`);
  }

  const node: PitchNode = {
    id: raw.id,
    midiPitch: raw.midiPitch,
    degree: raw.degree as PitchNode['degree'],
    octaveOffset: raw.octaveOffset as PitchNode['octaveOffset'],
    accidental: raw.accidental as Accidental,
  };
  if (typeof raw.fingering === 'string' && raw.fingering.length > 0) {
    node.fingering = raw.fingering;
  }
  if (isRecord(raw.guitar)) {
    if (
      typeof raw.guitar.string === 'number' &&
      Number.isInteger(raw.guitar.string) &&
      typeof raw.guitar.fret === 'number' &&
      Number.isInteger(raw.guitar.fret)
    ) {
      const normalizedTechs = Array.isArray(raw.guitar.techniques)
        ? normalizeGuitarTechniques(
            raw.guitar.techniques.filter(
              (t): t is string => typeof t === 'string'
            )
          )
        : [];
      node.guitar = {
        string: raw.guitar.string,
        fret: raw.guitar.fret,
        ...(normalizedTechs.length > 0 ? { techniques: normalizedTechs } : {}),
      };
    }
  }

  return { ok: true, value: node };
}

function validateBeat(raw: unknown, path: string): Result<Beat> {
  if (!isRecord(raw)) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', 'V2 节拍节点格式损坏', path);
  }
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '节拍缺少有效标识', `${path}.id`);
  }
  if (typeof raw.isRest !== 'boolean') {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '休止标记必须为布尔值', `${path}.isRest`);
  }
  if (
    typeof raw.baseDuration !== 'string' ||
    !VALID_BASE_DURATIONS.includes(raw.baseDuration as BaseDuration)
  ) {
    return failV2('SCORE_INVALID_DURATION', '音符基础时值档位无效', `${path}.baseDuration`);
  }
  if (typeof raw.dotted !== 'boolean') {
    return failV2('SCORE_INVALID_DURATION', '附点标记必须为布尔值', `${path}.dotted`);
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
    return failV2(
      'SCORE_INVALID_DURATION',
      `音符时值数值异常，期望 ${expectedTicks} Ticks`,
      `${path}.durationTicks`
    );
  }
  if (!Array.isArray(raw.notes)) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '节拍音高列表格式无效', `${path}.notes`);
  }
  if (raw.isRest && raw.notes.length > 0) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '休止符不允许携带音高节点', `${path}.notes`);
  }
  if (!raw.isRest && raw.notes.length === 0) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '非休止节拍至少需要一个音高节点', `${path}.notes`);
  }

  const notes: PitchNode[] = [];
  for (let i = 0; i < raw.notes.length; i += 1) {
    const pRes = validatePitchNode(raw.notes[i], `${path}.notes[${i}]`);
    if (!pRes.ok) {
      return pRes;
    }
    notes.push(pRes.value);
  }

  const beat: Beat = {
    id: raw.id,
    isRest: raw.isRest,
    baseDuration: raw.baseDuration as BaseDuration,
    dotted: raw.dotted,
    durationTicks: raw.durationTicks,
    notes,
  };
  if (typeof raw.lyric === 'string') {
    beat.lyric = raw.lyric;
  }
  if (typeof raw.chordSymbol === 'string') {
    beat.chordSymbol = raw.chordSymbol;
  }
  if (
    typeof raw.dynamic === 'string' &&
    VALID_DYNAMICS.has(raw.dynamic as DynamicMarking)
  ) {
    beat.dynamic = raw.dynamic as DynamicMarking;
  }
  if (
    typeof raw.ornament === 'string' &&
    VALID_ORNAMENTS.has(raw.ornament as OrnamentType)
  ) {
    beat.ornament = raw.ornament as OrnamentType;
  }
  if (typeof raw.tieStart === 'boolean') {
    beat.tieStart = raw.tieStart;
  }
  if (typeof raw.tieEnd === 'boolean') {
    beat.tieEnd = raw.tieEnd;
  }
  if (typeof raw.slurStart === 'boolean') {
    beat.slurStart = raw.slurStart;
  }
  if (typeof raw.slurEnd === 'boolean') {
    beat.slurEnd = raw.slurEnd;
  }
  if (
    isRecord(raw.tuplet) &&
    typeof raw.tuplet.actual === 'number' &&
    Number.isInteger(raw.tuplet.actual) &&
    raw.tuplet.actual > 1 &&
    typeof raw.tuplet.normal === 'number' &&
    Number.isInteger(raw.tuplet.normal) &&
    raw.tuplet.normal > 0
  ) {
    beat.tuplet = {
      actual: raw.tuplet.actual,
      normal: raw.tuplet.normal,
    };
  }

  return { ok: true, value: beat };
}

function validateV2Measure(raw: unknown, path: string): Result<V2Measure> {
  if (!isRecord(raw)) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', 'V2 小节结构损坏', path);
  }
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '小节缺少有效标识', `${path}.id`);
  }
  if (typeof raw.index !== 'number' || !Number.isInteger(raw.index) || raw.index < 0) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '小节序号必须为非负整数', `${path}.index`);
  }
  if (!Array.isArray(raw.beats)) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '小节节拍列表格式损坏', `${path}.beats`);
  }

  const beats: Beat[] = [];
  for (let i = 0; i < raw.beats.length; i += 1) {
    const bRes = validateBeat(raw.beats[i], `${path}.beats[${i}]`);
    if (!bRes.ok) {
      return bRes;
    }
    beats.push(bRes.value);
  }

  const measure: V2Measure = {
    id: raw.id,
    index: raw.index,
    beats,
  };
  if (typeof raw.repeatStart === 'boolean') {
    measure.repeatStart = raw.repeatStart;
  }
  if (typeof raw.repeatEnd === 'boolean') {
    measure.repeatEnd = raw.repeatEnd;
  }
  if (
    typeof raw.barline === 'string' &&
    VALID_BARLINES.has(raw.barline as MeasureBarlineType)
  ) {
    measure.barline = raw.barline as MeasureBarlineType;
  }
  if (raw.ending === 1 || raw.ending === 2) {
    measure.ending = raw.ending;
  }

  return {
    ok: true,
    value: measure,
  };
}

function validateVoice(raw: unknown, path: string): Result<Voice> {
  if (!isRecord(raw)) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '声部结构损坏', path);
  }
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '声部缺少有效标识', `${path}.id`);
  }
  if (typeof raw.index !== 'number' || !Number.isInteger(raw.index) || raw.index < 0) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '声部序号无效', `${path}.index`);
  }
  if (!Array.isArray(raw.measures) || raw.measures.length === 0) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '声部至少需要包含一个小节', `${path}.measures`);
  }

  const measures: V2Measure[] = [];
  for (let i = 0; i < raw.measures.length; i += 1) {
    const mRes = validateV2Measure(raw.measures[i], `${path}.measures[${i}]`);
    if (!mRes.ok) {
      return mRes;
    }
    measures.push(mRes.value);
  }

  return {
    ok: true,
    value: {
      id: raw.id,
      index: raw.index,
      measures,
    },
  };
}

function validateTrack(raw: unknown, path: string): Result<Track> {
  if (!isRecord(raw)) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '轨道结构损坏', path);
  }
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '轨道缺少有效标识', `${path}.id`);
  }
  if (typeof raw.name !== 'string' || raw.name.trim().length === 0) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '轨道缺少名称', `${path}.name`);
  }
  if (
    typeof raw.instrumentId !== 'string' ||
    !VALID_INSTRUMENTS.has(raw.instrumentId as InstrumentId)
  ) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '轨道乐器配置无效', `${path}.instrumentId`);
  }
  if (typeof raw.clef !== 'string' || !VALID_CLEFS.has(raw.clef as Track['clef'])) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '轨道谱号类型无效', `${path}.clef`);
  }
  if (!Array.isArray(raw.enabledViews) || raw.enabledViews.length === 0) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '轨道视图图层配置无效', `${path}.enabledViews`);
  }
  for (const v of raw.enabledViews) {
    if (typeof v !== 'string' || !VALID_VIEW_LAYERS.has(v as ViewLayerType)) {
      return failV2('STORAGE_SCHEMA_CORRUPTED', '轨道包含不支持的谱面图层', `${path}.enabledViews`);
    }
  }
  if (!Array.isArray(raw.voices) || raw.voices.length === 0) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '轨道至少需要包含一个声部', `${path}.voices`);
  }

  const voices: Voice[] = [];
  for (let i = 0; i < raw.voices.length; i += 1) {
    const vRes = validateVoice(raw.voices[i], `${path}.voices[${i}]`);
    if (!vRes.ok) {
      return vRes;
    }
    voices.push(vRes.value);
  }

  const track: Track = {
    id: raw.id,
    name: raw.name,
    instrumentId: raw.instrumentId as InstrumentId,
    clef: raw.clef as Track['clef'],
    enabledViews: [...(raw.enabledViews as ViewLayerType[])],
    voices,
  };
  if (Array.isArray(raw.tuning)) {
    track.tuning = raw.tuning.filter((n): n is number => typeof n === 'number' && Number.isInteger(n));
  }
  if (typeof raw.capo === 'number' && Number.isInteger(raw.capo) && raw.capo >= 0) {
    track.capo = raw.capo;
  }

  return { ok: true, value: track };
}

/** 校验任意未知输入是否为合法的 V2 乐谱模型 */
export function validateScoreDocumentV2(input: unknown): Result<ScoreDocumentV2> {
  if (!isRecord(input)) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', 'V2 乐谱数据根对象格式无效');
  }
  if (input.schemaVersion !== 2) {
    return failV2(
      'STORAGE_SCHEMA_CORRUPTED',
      '不支持的 V2 乐谱版本，仅支持版本 2',
      'schemaVersion'
    );
  }
  if (typeof input.id !== 'string' || input.id.trim().length === 0) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '乐谱缺少有效的唯一标识', 'id');
  }
  if (typeof input.title !== 'string') {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '乐谱标题必须为字符串', 'title');
  }
  if (
    typeof input.keySignature !== 'string' ||
    !VALID_KEY_SIGNATURES.includes(input.keySignature as KeySignature)
  ) {
    return failV2(
      'SCORE_INVALID_KEY_SIGNATURE',
      '不支持的调号设置，请使用 12 个标准大调调号之一',
      'keySignature'
    );
  }
  if (
    typeof input.timeSignature !== 'string' ||
    !VALID_TIME_SIGNATURES.includes(input.timeSignature as TimeSignature)
  ) {
    return failV2(
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
    return failV2(
      'SCORE_INVALID_BPM',
      '速度 BPM 必须为 40 到 200 之间的整数',
      'bpm'
    );
  }
  if (
    typeof input.viewMode !== 'string' ||
    !VALID_VIEW_MODES.has(input.viewMode as ViewMode)
  ) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '谱面视图模式无效', 'viewMode');
  }
  if (
    typeof input.updatedAtEpochMs !== 'number' ||
    !Number.isInteger(input.updatedAtEpochMs) ||
    input.updatedAtEpochMs < 0
  ) {
    return failV2(
      'STORAGE_SCHEMA_CORRUPTED',
      '乐谱更新时间戳必须为非负整数毫秒',
      'updatedAtEpochMs'
    );
  }
  if (!Array.isArray(input.tracks) || input.tracks.length === 0) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', 'V2 乐谱至少需要包含一条轨道', 'tracks');
  }

  const tracks: Track[] = [];
  for (let i = 0; i < input.tracks.length; i += 1) {
    const tRes = validateTrack(input.tracks[i], `tracks[${i}]`);
    if (!tRes.ok) {
      return tRes;
    }
    tracks.push(tRes.value);
  }

  const resultDoc: ScoreDocumentV2 = {
    schemaVersion: 2,
    id: input.id,
    title: input.title,
    keySignature: input.keySignature as KeySignature,
    timeSignature: input.timeSignature as TimeSignature,
    bpm: input.bpm,
    viewMode: input.viewMode as ViewMode,
    tracks,
    updatedAtEpochMs: input.updatedAtEpochMs,
  };

  const subtitle = normalizeOptionalString(input.subtitle);
  const composer = normalizeOptionalString(input.composer);
  const lyricist = normalizeOptionalString(input.lyricist);
  if (subtitle) {
    resultDoc.subtitle = subtitle;
  }
  if (composer) {
    resultDoc.composer = composer;
  }
  if (lyricist) {
    resultDoc.lyricist = lyricist;
  }
  if (
    isRecord(input.referenceSource) &&
    typeof input.referenceSource.id === 'string' &&
    typeof input.referenceSource.name === 'string' &&
    typeof input.referenceSource.mimeType === 'string' &&
    typeof input.referenceSource.sizeBytes === 'number'
  ) {
    resultDoc.referenceSource = {
      id: input.referenceSource.id,
      name: input.referenceSource.name,
      mimeType: input.referenceSource.mimeType,
      sizeBytes: input.referenceSource.sizeBytes,
    };
  }

  return { ok: true, value: resultDoc };
}

/** 序列化 V2 乐谱为 JSON 字符串 */
export function serializeScoreDocumentV2(docV2: ScoreDocumentV2): Result<string> {
  const validated = validateScoreDocumentV2(docV2);
  if (!validated.ok) {
    return validated;
  }
  try {
    return { ok: true, value: JSON.stringify(validated.value, null, 2) };
  } catch {
    return failV2('STORAGE_SCHEMA_CORRUPTED', 'V2 乐谱数据序列化失败');
  }
}

/** 反序列化 V2 JSON 字符串 */
export function deserializeScoreDocumentV2(raw: string): Result<ScoreDocumentV2> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '乐谱存储内容为空，无法解析');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '乐谱 JSON 格式已损坏，无法解析');
  }
  return validateScoreDocumentV2(parsed);
}

/** 兼容解析 v1 或 v2 乐谱 JSON，统一输出 ScoreDocumentV2 */
export function deserializeAnyScoreDocument(raw: string): Result<ScoreDocumentV2> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '导入文件内容为空，无法解析');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '导入文件的 JSON 格式已损坏，无法解析');
  }
  if (!isRecord(parsed)) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '导入数据根对象格式无效');
  }
  if (parsed.schemaVersion === 1) {
    const v1Res = validateScoreDocument(parsed);
    if (!v1Res.ok) {
      return v1Res;
    }
    return { ok: true, value: migrateV1ToV2(v1Res.value) };
  }
  if (parsed.schemaVersion === 2) {
    return validateScoreDocumentV2(parsed);
  }
  return failV2(
    'STORAGE_SCHEMA_CORRUPTED',
    '不支持的乐谱数据结构版本，仅支持版本 1 或版本 2',
    'schemaVersion'
  );
}

/** 序列化整库备份 JSON */
export function serializeLibraryBackup(
  scores: readonly ScoreDocumentV2[],
  nowMs = Date.now()
): Result<string> {
  const validScores: ScoreDocumentV2[] = [];
  for (let i = 0; i < scores.length; i += 1) {
    const res = validateScoreDocumentV2(scores[i]);
    if (!res.ok) {
      return res;
    }
    validScores.push(res.value);
  }
  const bundle: LibraryBackupBundle = {
    format: 'notebridge-backup',
    schemaVersion: 2,
    exportedAtEpochMs: Math.trunc(nowMs),
    scores: validScores,
  };
  try {
    return { ok: true, value: JSON.stringify(bundle, null, 2) };
  } catch {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '乐谱库备份序列化失败');
  }
}

/** 反序列化整库备份或单曲 v1/v2 JSON 文件 */
export function deserializeLibraryBackup(raw: string): Result<ScoreDocumentV2[]> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '备份文件内容为空，无法导入');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '备份文件 JSON 格式已损坏，无法解析');
  }
  if (!isRecord(parsed)) {
    return failV2('STORAGE_SCHEMA_CORRUPTED', '备份文件结构无效');
  }

  if (parsed.format === 'notebridge-backup') {
    if (parsed.schemaVersion !== 2 || !Array.isArray(parsed.scores)) {
      return failV2('STORAGE_SCHEMA_CORRUPTED', '乐谱库备份包版本或列表格式损坏');
    }
    const docs: ScoreDocumentV2[] = [];
    for (let i = 0; i < parsed.scores.length; i += 1) {
      const v2Res = validateScoreDocumentV2(parsed.scores[i]);
      if (!v2Res.ok) {
        return v2Res;
      }
      docs.push(v2Res.value);
    }
    return { ok: true, value: docs };
  }

  const singleRes = deserializeAnyScoreDocument(raw);
  if (!singleRes.ok) {
    return singleRes;
  }
  return { ok: true, value: [singleRes.value] };
}
