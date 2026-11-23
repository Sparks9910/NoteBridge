import { calculateDurationTicks, VALID_TIME_SIGNATURES } from './rhythm.ts';
import { createAppError } from './state-machines.ts';
import { VALID_KEY_SIGNATURES } from './theory.ts';
import type {
  Accidental,
  BaseDuration,
  KeySignature,
  Result,
  TimeSignature,
} from './types.ts';
import { mapMidiToPitchNode, quantizeTicksToDuration, validateScoreDocumentV2 } from './v2-serializer.ts';
import type {
  Beat,
  PitchNode,
  ScoreDocumentV2,
  Track,
  V2Measure,
} from './v2-types.ts';

export interface JianpuTextParseOptions {
  title?: string;
  keySignature?: KeySignature;
  timeSignature?: TimeSignature;
  bpm?: number;
  nowMs?: number;
  id?: string;
}

const KEY_SET: ReadonlySet<string> = new Set(VALID_KEY_SIGNATURES);
const TIME_SET: ReadonlySet<string> = new Set(VALID_TIME_SIGNATURES);

const KEY_NORMALIZE_MAP: Readonly<Record<string, KeySignature>> = {
  C: 'C',
  G: 'G',
  D: 'D',
  A: 'A',
  E: 'E',
  B: 'B',
  F: 'F',
  BB: 'Bb',
  'B♭': 'Bb',
  EB: 'Eb',
  'E♭': 'Eb',
  AB: 'Ab',
  'A♭': 'Ab',
  DB: 'Db',
  'D♭': 'Db',
  GB: 'Gb',
  'G♭': 'Gb',
  'F#': 'Gb',
  'F♯': 'Gb',
  'C#': 'Db',
  'C♯': 'Db',
};

function normalizeKeyToken(raw: string): KeySignature | null {
  const cleaned = raw.trim().replace(/^1\s*=\s*/i, '');
  const upper = cleaned.toUpperCase();
  if (KEY_NORMALIZE_MAP[upper]) {
    return KEY_NORMALIZE_MAP[upper] ?? null;
  }
  if (KEY_SET.has(cleaned)) {
    return cleaned as KeySignature;
  }
  return null;
}

function parseHeaderDirectives(lines: string[], options?: JianpuTextParseOptions): {
  title: string;
  subtitle?: string;
  composer?: string;
  lyricist?: string;
  keySignature: KeySignature;
  timeSignature: TimeSignature;
  bpm: number;
  lyricsQueue: string[];
  bodyLines: string[];
} {
  let title = options?.title?.trim() || '简谱导入曲谱';
  let subtitle: string | undefined;
  let composer: string | undefined;
  let lyricist: string | undefined;
  let keySignature: KeySignature = options?.keySignature ?? 'C';
  let timeSignature: TimeSignature = options?.timeSignature ?? '4/4';
  let bpm = options?.bpm ?? 90;
  const lyricsQueue: string[] = [];
  const bodyLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) {
      continue;
    }

    const titleMatch = line.match(/^(?:标题|曲名|title)\s*[:：=]\s*(.+)$/i);
    if (titleMatch?.[1]) {
      title = titleMatch[1].trim();
      continue;
    }
    const subMatch = line.match(/^(?:副标题|subtitle)\s*[:：=]\s*(.+)$/i);
    if (subMatch?.[1]) {
      subtitle = subMatch[1].trim();
      continue;
    }
    const compMatch = line.match(/^(?:作曲|曲|composer)\s*[:：=]\s*(.+)$/i);
    if (compMatch?.[1]) {
      composer = compMatch[1].trim();
      continue;
    }
    const lyrByMatch = line.match(/^(?:作词|词|lyricist)\s*[:：=]\s*(.+)$/i);
    if (lyrByMatch?.[1]) {
      lyricist = lyrByMatch[1].trim();
      continue;
    }
    const lyricsLineMatch = line.match(/^(?:歌词|lyrics?)\s*[:：=]\s*(.+)$/i);
    if (lyricsLineMatch?.[1]) {
      const words = lyricsLineMatch[1]
        .trim()
        .split(/\s+/)
        .flatMap((w) => (/[\u4e00-\u9fa5]{2,}/.test(w) ? Array.from(w) : [w]))
        .filter((w) => w.length > 0);
      lyricsQueue.push(...words);
      continue;
    }

    let remaining = line;
    const keyInline = remaining.match(/\b1\s*=\s*([A-G][#♯b♭]?)/i);
    if (keyInline?.[1]) {
      const parsedKey = normalizeKeyToken(keyInline[1]);
      if (parsedKey) {
        keySignature = parsedKey;
      }
      remaining = remaining.replace(keyInline[0], ' ').trim();
    }

    const timeInline = remaining.match(/\b(2\/4|3\/4|4\/4|6\/8)\b/);
    if (timeInline?.[1] && TIME_SET.has(timeInline[1])) {
      timeSignature = timeInline[1] as TimeSignature;
      remaining = remaining.replace(timeInline[0], ' ').trim();
    }

    const bpmInline = remaining.match(/\b(?:BPM|速度|tempo)\s*[:：=]?\s*(\d{2,3})\b/i);
    if (bpmInline?.[1]) {
      const val = Number(bpmInline[1]);
      if (Number.isInteger(val) && val >= 40 && val <= 200) {
        bpm = val;
      }
      remaining = remaining.replace(bpmInline[0], ' ').trim();
    }

    if (remaining.length > 0 && !/^(?:调号|拍号|速度)\s*[:：=]/.test(remaining)) {
      bodyLines.push(remaining);
    }
  }

  return {
    title,
    subtitle,
    composer,
    lyricist,
    keySignature,
    timeSignature,
    bpm,
    lyricsQueue,
    bodyLines,
  };
}

function parseNoteToken(
  token: string,
  dashCount: number,
  keySignature: KeySignature,
  beatId: string
): Beat | null {
  const match = token.match(/^([#♯b♭=♮]?)([0-7])([',，]*)(_*)(\.?)$/);
  if (!match) {
    return null;
  }

  const accSym = match[1] ?? '';
  const digit = Number(match[2]);
  const octaveMarks = match[3] ?? '';
  const underlines = match[4] ?? '';
  const hasDot = (match[5] ?? '') === '.';

  let accidental: Accidental = null;
  if (accSym === '#' || accSym === '♯') {
    accidental = 'sharp';
  } else if (accSym === 'b' || accSym === '♭') {
    accidental = 'flat';
  } else if (accSym === '=' || accSym === '♮') {
    accidental = 'natural';
  }

  let octaveOffset = 0;
  for (const ch of octaveMarks) {
    if (ch === "'") {
      octaveOffset += 1;
    } else if (ch === ',' || ch === '，') {
      octaveOffset -= 1;
    }
  }
  const clampedOctave = Math.max(-2, Math.min(2, octaveOffset)) as -2 | -1 | 0 | 1 | 2;

  let baseDuration: BaseDuration = 'quarter';
  let dotted = hasDot;

  if (dashCount >= 3) {
    baseDuration = 'whole';
    dotted = false;
  } else if (dashCount === 2) {
    baseDuration = 'half';
    dotted = true;
  } else if (dashCount === 1) {
    baseDuration = 'half';
    dotted = false;
  } else if (underlines.length >= 2) {
    baseDuration = 'sixteenth';
  } else if (underlines.length === 1) {
    baseDuration = 'eighth';
  } else {
    baseDuration = 'quarter';
  }

  const durationTicks = calculateDurationTicks(baseDuration, dotted);
  if (digit === 0) {
    return {
      id: beatId,
      isRest: true,
      baseDuration,
      dotted,
      durationTicks,
      notes: [],
    };
  }

  const degree = digit as 1 | 2 | 3 | 4 | 5 | 6 | 7;
  const spec = {
    id: beatId,
    isRest: false,
    degree,
    octaveOffset: clampedOctave,
    accidental,
    baseDuration,
    dotted,
    durationTicks,
  };

  // Compute exact MIDI via standard V2 scale table
  const scaleSemitones = [0, 2, 4, 5, 7, 9, 11];
  const baseMidiMap: Record<KeySignature, number> = {
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
  const accDelta = accidental === 'sharp' ? 1 : accidental === 'flat' ? -1 : 0;
  const rawMidi =
    baseMidiMap[keySignature] +
    (scaleSemitones[degree - 1] ?? 0) +
    clampedOctave * 12 +
    accDelta;
  const midiPitch = Math.max(24, Math.min(108, rawMidi));

  const pitchNode: PitchNode = {
    id: `${spec.id}_p0`,
    midiPitch,
    degree,
    octaveOffset: clampedOctave,
    accidental,
  };

  return {
    id: beatId,
    isRest: false,
    baseDuration,
    dotted,
    durationTicks,
    notes: [pitchNode],
  };
}

/**
 * 将简谱文本快捷语法解析为标准 ScoreDocumentV2。
 * 示例：
 *   标题: 小星星
 *   1=C 4/4 BPM=100
 *   1 1 5 5 | 6 6 5 - | 4_ 4_ 3 3 | 2 2 1 - ||
 */
export function parseJianpuTextToScoreV2(
  text: string,
  options?: JianpuTextParseOptions
): Result<ScoreDocumentV2> {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return {
      ok: false,
      error: createAppError('STORAGE_SCHEMA_CORRUPTED', '简谱文本内容为空，请输入简谱音符后再导入'),
    };
  }

  const lines = text.split(/\r?\n/);
  const header = parseHeaderDirectives(lines, options);
  const rawBody = header.bodyLines.join(' ');
  if (!rawBody.trim()) {
    return {
      ok: false,
      error: createAppError('STORAGE_SCHEMA_CORRUPTED', '简谱文本中未找到可识别的音符内容'),
    };
  }

  // Normalize barlines in a single regex pass so ||: / :|| / || are not split by |
  const normalized = rawBody.replace(/\|\|:|:\|\||\|\||\||—|–/g, (tok) =>
    tok === '—' || tok === '–' ? ' - ' : ` ${tok} `
  );

  const rawTokens = normalized.split(/\s+/).filter((t) => t.length > 0);
  const measures: V2Measure[] = [];
  let currentBeats: Beat[] = [];
  let pendingRepeatStart = false;
  let beatSeq = 1;
  let noteTotalCount = 0;
  let lyricIndex = 0;

  const flushMeasure = (extra?: {
    repeatEnd?: boolean;
    barline?: 'single' | 'double' | 'final';
  }) => {
    const m: V2Measure = {
      id: `m_${measures.length}`,
      index: measures.length,
      beats: currentBeats,
    };
    if (pendingRepeatStart) {
      m.repeatStart = true;
      pendingRepeatStart = false;
    }
    if (extra?.repeatEnd) {
      m.repeatEnd = true;
    }
    if (extra?.barline && extra.barline !== 'single') {
      m.barline = extra.barline;
    }
    measures.push(m);
    currentBeats = [];
  };

  for (let i = 0; i < rawTokens.length; i += 1) {
    const tok = rawTokens[i] ?? '';
    if (tok === '||:') {
      if (currentBeats.length > 0) {
        flushMeasure();
      }
      pendingRepeatStart = true;
      continue;
    }
    if (tok === ':||') {
      flushMeasure({ repeatEnd: true });
      continue;
    }
    if (tok === '||') {
      if (currentBeats.length > 0 || measures.length === 0) {
        flushMeasure({ barline: 'final' });
      } else if (measures.length > 0) {
        const last = measures[measures.length - 1];
        if (last) {
          last.barline = 'final';
        }
      }
      continue;
    }
    if (tok === '|') {
      flushMeasure();
      continue;
    }

    // Check compact note+dashes like "1-" or standalone "-" tokens following a note
    let cleanTok = tok;
    let dashCount = 0;
    while (cleanTok.endsWith('-') && cleanTok.length > 1) {
      dashCount += 1;
      cleanTok = cleanTok.slice(0, -1);
    }
    while (rawTokens[i + 1] === '-') {
      dashCount += 1;
      i += 1;
    }

    if (cleanTok === '-') {
      continue;
    }

    const beatId = `jp_n_${beatSeq++}`;
    const beat = parseNoteToken(cleanTok, dashCount, header.keySignature, beatId);
    if (!beat) {
      continue;
    }
    if (!beat.isRest && lyricIndex < header.lyricsQueue.length) {
      beat.lyric = header.lyricsQueue[lyricIndex];
      lyricIndex += 1;
    }
    currentBeats.push(beat);
    noteTotalCount += 1;
  }

  if (currentBeats.length > 0) {
    flushMeasure();
  }

  if (noteTotalCount === 0 || measures.length === 0) {
    return {
      ok: false,
      error: createAppError(
        'STORAGE_SCHEMA_CORRUPTED',
        '未能从输入文本中解析出有效简谱音符（支持 1-7、0、_ 减时线、- 增时线与 | 小节线）'
      ),
    };
  }

  const track: Track = {
    id: 'track_main',
    name: '主旋律',
    instrumentId: 'piano',
    clef: 'treble',
    enabledViews: ['staff', 'jianpu'],
    voices: [
      {
        id: 'voice_1',
        index: 0,
        measures,
      },
    ],
  };

  const docV2: ScoreDocumentV2 = {
    schemaVersion: 2,
    id: options?.id ?? `jianpu_${Math.trunc(options?.nowMs ?? Date.now())}`,
    title: header.title,
    keySignature: header.keySignature,
    timeSignature: header.timeSignature,
    bpm: header.bpm,
    viewMode: 'dual',
    tracks: [track],
    updatedAtEpochMs: Math.trunc(options?.nowMs ?? Date.now()),
  };
  if (header.subtitle) {
    docV2.subtitle = header.subtitle;
  }
  if (header.composer) {
    docV2.composer = header.composer;
  }
  if (header.lyricist) {
    docV2.lyricist = header.lyricist;
  }

  return validateScoreDocumentV2(docV2);
}

/** 将 ScoreDocumentV2 主声部格式化为简谱快捷文本 */
export function formatScoreV2ToJianpuText(scoreV2: ScoreDocumentV2): string {
  const lines: string[] = [
    `标题: ${scoreV2.title}`,
    `1=${scoreV2.keySignature} ${scoreV2.timeSignature} BPM=${scoreV2.bpm}`,
  ];
  const measures = scoreV2.tracks[0]?.voices[0]?.measures ?? [];
  const measureStrings = measures.map((m) => {
    const tokens = m.beats.map((b) => {
      const lead = b.notes[0];
      if (b.isRest || !lead) {
        const suffix =
          b.baseDuration === 'whole'
            ? ' - - -'
            : b.baseDuration === 'half'
              ? b.dotted
                ? ' - -'
                : ' -'
              : b.baseDuration === 'eighth'
                ? '_'
                : b.baseDuration === 'sixteenth'
                  ? '__'
                  : '';
        return `0${suffix}${b.dotted && b.baseDuration !== 'half' && b.baseDuration !== 'whole' ? '.' : ''}`;
      }
      const acc =
        lead.accidental === 'sharp'
          ? '#'
          : lead.accidental === 'flat'
            ? 'b'
            : lead.accidental === 'natural'
              ? '='
              : '';
      const oct =
        lead.octaveOffset > 0
          ? "'".repeat(lead.octaveOffset)
          : lead.octaveOffset < 0
            ? ','.repeat(Math.abs(lead.octaveOffset))
            : '';
      const under =
        b.baseDuration === 'eighth'
          ? '_'
          : b.baseDuration === 'sixteenth'
            ? '__'
            : '';
      const dot =
        b.dotted && b.baseDuration !== 'half' && b.baseDuration !== 'whole' ? '.' : '';
      const dash =
        b.baseDuration === 'whole'
          ? ' - - -'
          : b.baseDuration === 'half'
            ? b.dotted
              ? ' - -'
              : ' -'
            : '';
      return `${acc}${lead.degree}${oct}${under}${dot}${dash}`;
    });
    const prefix = m.repeatStart ? '||: ' : '';
    const suffix = m.repeatEnd ? ' :||' : m.barline === 'final' ? ' ||' : '';
    return `${prefix}${tokens.join(' ')}${suffix}`;
  });
  lines.push(measureStrings.join(' | '));
  return lines.join('\n');
}

export { mapMidiToPitchNode, quantizeTicksToDuration };
