import type {
  Accidental,
  AppError,
  BaseDuration,
  KeySignature,
  Measure,
  NoteEvent,
  Result,
  ScoreDocument,
  TimeSignature,
  ViewMode,
} from './types.ts';

export type {
  Accidental,
  AppError,
  BaseDuration,
  KeySignature,
  Measure,
  NoteEvent,
  Result,
  ScoreDocument,
  TimeSignature,
  ViewMode,
};

/** V2 顶部工作模式 */
export type WorkMode = 'studio' | 'practice';

/** V2 画布视图图层类型 */
export type ViewLayerType = 'staff' | 'jianpu' | 'tab';

/** V2 预设乐器标识 */
export type InstrumentId =
  | 'piano'
  | 'electric-guitar-clean'
  | 'electric-guitar-od'
  | 'acoustic-guitar'
  | 'bass'
  | 'melody';

/** 曲谱排版与署名元信息 */
export interface ScoreMetadata {
  subtitle?: string;
  composer?: string;
  lyricist?: string;
}

/** 吉他弦品与技巧扩展信息（V2.2/V2.3 使用，V2.0 模型预留） */
export interface GuitarNodeMeta {
  string: number;
  fret: number;
  techniques?: string[];
}

/** V2 音高节点（同一份 MIDI 与简谱音级单一数据源） */
export interface PitchNode {
  id: string;
  midiPitch: number;
  degree: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  octaveOffset: -2 | -1 | 0 | 1 | 2;
  accidental: Accidental;
  fingering?: string;
  guitar?: GuitarNodeMeta;
}

/** V2 节奏节拍单元（支持休止符、单音及后续和弦扩展） */
export interface Beat {
  id: string;
  isRest: boolean;
  baseDuration: BaseDuration;
  dotted: boolean;
  durationTicks: number;
  notes: PitchNode[];
  lyric?: string;
  chordSymbol?: string;
}

/** V2 小节 */
export interface V2Measure {
  id: string;
  index: number;
  beats: Beat[];
}

/** V2 声部 */
export interface Voice {
  id: string;
  index: number;
  measures: V2Measure[];
}

/** V2 乐器轨道 */
export interface Track {
  id: string;
  name: string;
  instrumentId: InstrumentId;
  clef: 'treble' | 'bass' | 'grand';
  enabledViews: ViewLayerType[];
  voices: Voice[];
  tuning?: number[];
  capo?: number;
}

/** 原谱对照本地附件引用（V2.1/V2.3 扩展槽） */
export interface ReferenceAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

/** V2 权威乐谱 AST 根模型 */
export interface ScoreDocumentV2 {
  schemaVersion: 2;
  id: string;
  title: string;
  subtitle?: string;
  composer?: string;
  lyricist?: string;
  keySignature: KeySignature;
  timeSignature: TimeSignature;
  bpm: number;
  viewMode: ViewMode;
  tracks: Track[];
  referenceSource?: ReferenceAttachment;
  updatedAtEpochMs: number;
}

/** 乐谱库列表摘要条目 */
export interface LibraryScoreEntry {
  id: string;
  title: string;
  subtitle?: string;
  composer?: string;
  keySignature: KeySignature;
  timeSignature: TimeSignature;
  bpm: number;
  measureCount: number;
  instrumentId: InstrumentId;
  thumbnailSvg: string;
  updatedAtEpochMs: number;
}

/** 整库手动备份 JSON 包格式 */
export interface LibraryBackupBundle {
  format: 'notebridge-backup';
  schemaVersion: 2;
  exportedAtEpochMs: number;
  scores: ScoreDocumentV2[];
}
