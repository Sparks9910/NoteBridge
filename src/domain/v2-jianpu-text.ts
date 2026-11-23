import {
  calculateDurationTicks,
  getMeasureCapacityTicks,
  VALID_TIME_SIGNATURES,
  validateMeasureRhythm,
} from './rhythm.ts';
import { createAppError } from './state-machines.ts';
import { resolveNotePitch, VALID_KEY_SIGNATURES } from './theory.ts';
import type {
  Accidental,
  BaseDuration,
  KeySignature,
  Measure,
  Result,
  TimeSignature,
} from './types.ts';
import {
  mapMidiToPitchNode,
  projectV2ToV1,
  quantizeTicksToDuration,
  validateScoreDocumentV2,
} from './v2-serializer.ts';
import type {
  Beat,
  MeasureBarlineType,
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

export interface JianpuParseDiagnostics {
  ok: boolean;
  title: string;
  keySignature: KeySignature;
  timeSignature: TimeSignature;
  bpm: number;
  measureCount: number;
  noteCount: number;
  skippedTokens: string[];
  overflowMeasures: number[];
  underflowMeasures: number[];
  errorDetail?: string;
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
  EB: 'Eb',
  AB: 'Ab',
  DB: 'Db',
  GB: 'Gb',
  BE: 'Eb',
  BA: 'Ab',
  BD: 'Db',
  BG: 'Gb',
  BC: 'B',
  BF: 'E',
  CB: 'B',
  FB: 'E',
  'F#': 'Gb',
  'C#': 'Db',
  'G#': 'Ab',
  'D#': 'Eb',
  'A#': 'Bb',
  'E#': 'F',
  'B#': 'C',
  '#F': 'Gb',
  '#C': 'Db',
  '#G': 'Ab',
  '#D': 'Eb',
  '#A': 'Bb',
  '#E': 'F',
  '#B': 'C',
};

const DURATION_DECOMPOSITION_TABLE: ReadonlyArray<{
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

const FULLWIDTH_MAP: Readonly<Record<string, string>> = {
  '０': '0',
  '１': '1',
  '２': '2',
  '３': '3',
  '４': '4',
  '５': '5',
  '６': '6',
  '７': '7',
  '８': '8',
  '９': '9',
  '｜': '|',
  '＿': '_',
  '－': '-',
  '—': '-',
  '–': '-',
  '─': '-',
  '−': '-',
  '．': '.',
  '·': '.',
  '•': '.',
  '＃': '#',
  '＝': '=',
  '／': '/',
  '：': ':',
  '＋': '+',
  '（': '(',
  '）': ')',
  '［': '[',
  '］': ']',
  '【': '[',
  '】': ']',
  '’': "'",
  '‘': "'",
  '′': "'",
  '，': ',',
};

function normalizeFullwidthSymbols(input: string): string {
  let out = '';
  for (const ch of input) {
    out += FULLWIDTH_MAP[ch] ?? ch;
  }
  return out;
}

function normalizeKeyToken(raw: string): KeySignature | null {
  const cleaned = normalizeFullwidthSymbols(raw)
    .trim()
    .replace(/♭/g, 'b')
    .replace(/♯/g, '#')
    .replace(/^1\s*=\s*/i, '')
    .replace(/(?:大调|调|major|maj)$/i, '')
    .trim();
  const upper = cleaned.toUpperCase();
  if (KEY_NORMALIZE_MAP[upper]) {
    return KEY_NORMALIZE_MAP[upper] ?? null;
  }
  if (KEY_SET.has(cleaned)) {
    return cleaned as KeySignature;
  }
  return null;
}

function extractLyricSyllables(raw: string): string[] {
  const withoutVersePrefix = raw.trim().replace(/^\d+[.、)）]\s*/, '');
  const cleaned = withoutVersePrefix.replace(
    /[|｜,，。、！!？?；;：:“”‘’"'「」『』()（）[\]【】—–\-~_]+/g,
    ' '
  );
  const words = cleaned
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const syllables: string[] = [];
  for (const word of words) {
    const parts = word.match(/[\u4e00-\u9fa5]|[^\u4e00-\u9fa5]+/g);
    if (parts) {
      for (const part of parts) {
        if (part.trim().length > 0) {
          syllables.push(part);
        }
      }
    }
  }
  return syllables;
}

type BodySegment =
  | { kind: 'melody'; raw: string }
  | { kind: 'lyric'; syllables: string[] };

const SECTION_LABEL_RE =
  /^(?:\[[^\]]*\]|【[^】]*】|\([^)]*\)|（[^）]*）|(?:verse|chorus|intro|outro|bridge|pre-?chorus|solo|interlude|前奏|间奏|尾奏|主歌|副歌|桥段|[A-Z]段)\s*\d*\s*[:：]?)$/i;

const EXTRA_METADATA_LABEL_RE =
  /^(?:编曲|演唱|原唱|歌手|专辑|来源|出处|备注|说明|乐器|调弦|变调夹|arranger|artist|singer|album|source|note)\s*[:：=＝]/i;

function parseDocumentLines(
  lines: string[],
  options?: JianpuTextParseOptions
): {
  title: string;
  subtitle?: string;
  composer?: string;
  lyricist?: string;
  keySignature: KeySignature;
  timeSignature: TimeSignature;
  bpm: number;
  lyricsQueue: string[];
  bodySegments: BodySegment[];
} {
  let title = options?.title?.trim() || '简谱导入曲谱';
  let subtitle: string | undefined;
  let composer: string | undefined;
  let lyricist: string | undefined;
  let keySignature: KeySignature = options?.keySignature ?? 'C';
  let timeSignature: TimeSignature = options?.timeSignature ?? '4/4';
  let bpm = options?.bpm ?? 90;
  const lyricsQueue: string[] = [];
  const bodySegments: BodySegment[] = [];
  let hasSeenMelody = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//') || /^#(?:\s|$|[^0-7０-７])/.test(line)) {
      continue;
    }

    const titleMatch = line.match(/^(?:标题|曲名|歌名|title)\s*[:：=＝]\s*(.+)$/i);
    if (titleMatch?.[1]) {
      title = titleMatch[1].trim();
      continue;
    }
    const subMatch = line.match(/^(?:副标题|subtitle)\s*[:：=＝]\s*(.+)$/i);
    if (subMatch?.[1]) {
      subtitle = subMatch[1].trim();
      continue;
    }
    const compMatch = line.match(/^(?:作曲|曲|composer)\s*[:：=＝]\s*(.+)$/i);
    if (compMatch?.[1]) {
      composer = compMatch[1].trim();
      continue;
    }
    const lyrByMatch = line.match(/^(?:作词|词|lyricist)\s*[:：=＝]\s*(.+)$/i);
    if (lyrByMatch?.[1]) {
      lyricist = lyrByMatch[1].trim();
      continue;
    }
    const lyricsLineMatch = line.match(/^(?:歌词|lyrics?)\s*[:：=＝]\s*(.+)$/i);
    if (lyricsLineMatch?.[1]) {
      lyricsQueue.push(...extractLyricSyllables(lyricsLineMatch[1]));
      continue;
    }

    const keyLabelMatch = line.match(/^(?:调号|调性|key)\s*[:：=＝]\s*(.+)$/i);
    if (keyLabelMatch?.[1]) {
      const parsedKey = normalizeKeyToken(keyLabelMatch[1]);
      if (parsedKey) {
        keySignature = parsedKey;
      }
      continue;
    }

    const timeLabelMatch = line.match(/^(?:拍号|节拍|time)\s*[:：=＝]\s*(.+)$/i);
    if (timeLabelMatch?.[1]) {
      const normTime = normalizeFullwidthSymbols(timeLabelMatch[1]).match(/(2\/4|3\/4|4\/4|6\/8)/);
      if (normTime?.[1] && TIME_SET.has(normTime[1])) {
        timeSignature = normTime[1] as TimeSignature;
      }
      continue;
    }

    const bpmLabelMatch = line.match(/^(?:速度|节奏|tempo|bpm)\s*[:：=＝]\s*(.+)$/i);
    if (bpmLabelMatch?.[1]) {
      const normBpm = normalizeFullwidthSymbols(bpmLabelMatch[1]).match(/(\d{2,3})/);
      if (normBpm?.[1]) {
        const val = Number(normBpm[1]);
        if (Number.isInteger(val) && val >= 40 && val <= 200) {
          bpm = val;
        }
      }
      continue;
    }

    if (EXTRA_METADATA_LABEL_RE.test(line)) {
      continue;
    }

    let remaining = normalizeFullwidthSymbols(line);
    let extractedHeaderToken = false;

    const keyInline = remaining.match(
      /(?:^|[\s,;(|])(1\s*=\s*(?:[#♯b♭][A-Ga-g]|[A-Ga-g][#♯b♭]?))(?=$|[\s,;)|拍调])/
    );
    if (keyInline?.[1]) {
      const parsedKey = normalizeKeyToken(keyInline[1]);
      if (parsedKey) {
        keySignature = parsedKey;
      }
      remaining = remaining.replace(keyInline[1], ' ').trim();
      extractedHeaderToken = true;
    }

    const bpmInline = remaining.match(
      /(?:^|[\s,;(|])((?:BPM|tempo|速度|♩|q)\s*[:=]?\s*(\d{2,3}))(?=$|[\s,;)|拍])/i
    );
    if (bpmInline?.[1] && bpmInline[2]) {
      const val = Number(bpmInline[2]);
      if (Number.isInteger(val) && val >= 40 && val <= 200) {
        bpm = val;
      }
      remaining = remaining.replace(bpmInline[1], ' ').trim();
      extractedHeaderToken = true;
    }

    const hasBarline = remaining.includes('|');
    const isPureTimeLine = /^\s*(2\/4|3\/4|4\/4|6\/8)(?:\s*拍)?\s*$/.test(remaining);
    if (!hasBarline || extractedHeaderToken || isPureTimeLine) {
      const timeInline = remaining.match(
        /(?:^|[\s,;(|])(2\/4|3\/4|4\/4|6\/8)(?=$|[\s,;)|拍])/
      );
      if (timeInline?.[1] && TIME_SET.has(timeInline[1])) {
        timeSignature = timeInline[1] as TimeSignature;
        remaining = remaining.replace(timeInline[1], ' ').trim();
        extractedHeaderToken = true;
      }
    }

    if (!/[0-7]/.test(remaining)) {
      const chineseKey = remaining.match(
        /(?:^|[\s,;(|])([#♯b♭]?[A-Ga-g][#♯b♭]?\s*(?:大调|调))(?=$|[\s,;)|])/
      );
      if (chineseKey?.[1]) {
        const parsedKey = normalizeKeyToken(chineseKey[1]);
        if (parsedKey) {
          keySignature = parsedKey;
        }
        remaining = remaining.replace(chineseKey[1], ' ').trim();
      }
    }

    if (
      remaining.length === 0 ||
      /^(?:调号|调性|拍号|节拍|速度|节奏)\s*[:=]?$/.test(remaining) ||
      /^[,.;:!?，。；：！？()[\]\s]+$/.test(remaining)
    ) {
      continue;
    }

    if (SECTION_LABEL_RE.test(remaining)) {
      continue;
    }

    const withoutVerse = remaining.replace(/^\d+[.、)]\s*/, '');
    const hasCjk = /[\u4e00-\u9fa5]/.test(withoutVerse);
    const isInterleavedLyric = hasSeenMelody && hasCjk && !/[0-7]/.test(withoutVerse);

    if (isInterleavedLyric) {
      const syllables = extractLyricSyllables(remaining);
      if (syllables.length > 0) {
        bodySegments.push({ kind: 'lyric', syllables });
      }
      continue;
    }

    const hasMelodyDigits = /[0-7]/.test(remaining);
    const hasContinuationSymbols = !hasCjk && !/[A-Za-z]/.test(remaining) && /[|\-:]/.test(remaining);
    if (hasMelodyDigits || (hasSeenMelody && hasContinuationSymbols)) {
      hasSeenMelody = true;
      bodySegments.push({ kind: 'melody', raw: remaining });
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
    bodySegments,
  };
}

type BarlineKind = 'single' | 'double' | 'repeatStart' | 'repeatEnd' | 'repeatBoth';

type MelodyToken =
  | { type: 'barline'; kind: BarlineKind }
  | { type: 'ending'; ending: 1 | 2 }
  | { type: 'chord'; symbol: string }
  | { type: 'slurStart' }
  | { type: 'slurEnd' }
  | { type: 'tie' }
  | { type: 'dash' }
  | { type: 'dot' }
  | {
      type: 'note';
      digit: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
      accidental: Accidental;
      octaveOffset: -2 | -1 | 0 | 1 | 2;
      underlineCount: 0 | 1 | 2;
      dotted: boolean;
    };

const CHORD_SYMBOL_CORE_RE =
  /^[A-G](?:#|♯|b|♭)?(?:m|min|maj|dim|aug|sus|add|M)?[0-9]{0,2}(?:[#♯b♭][0-9])?(?:\/[A-G](?:#|♯|b|♭)?)?$/;

const BARE_CHORD_RE =
  /^[A-G](?:#|♯|b|♭)?(?:m|min|maj|dim|aug|sus|add|M)?[0-9]{0,2}(?:[#♯b♭][0-9])?(?:\/[A-G](?:#|♯|b|♭)?)?(?=$|[\s|])/;

function isPrefixModifierChar(ch: string): boolean {
  return (
    ch === '+' ||
    ch === '↑' ||
    ch === '↓' ||
    ch === '#' ||
    ch === '♯' ||
    ch === 'b' ||
    ch === '♭' ||
    ch === '=' ||
    ch === '♮'
  );
}

function isAccidentalChar(ch: string): boolean {
  return ch === '#' || ch === '♯' || ch === 'b' || ch === '♭' || ch === '=' || ch === '♮';
}

function charToAccidental(ch: string): Accidental {
  if (ch === '#' || ch === '♯') return 'sharp';
  if (ch === 'b' || ch === '♭') return 'flat';
  if (ch === '=' || ch === '♮') return 'natural';
  return null;
}

function isNoteDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '7';
}

function tokenizeMelodyLine(rawLine: string, skippedTokens: string[]): MelodyToken[] {
  const s = normalizeFullwidthSymbols(rawLine);
  const tokens: MelodyToken[] = [];
  let pos = 0;

  while (pos < s.length) {
    const ch = s[pos]!;

    if (/\s/.test(ch)) {
      pos += 1;
      continue;
    }

    // Barlines (longest-first)
    if (s.startsWith(':||:', pos)) {
      tokens.push({ type: 'barline', kind: 'repeatBoth' });
      pos += 4;
      continue;
    }
    if (s.startsWith(':|:', pos)) {
      tokens.push({ type: 'barline', kind: 'repeatBoth' });
      pos += 3;
      continue;
    }
    if (s.startsWith('||:', pos)) {
      tokens.push({ type: 'barline', kind: 'repeatStart' });
      pos += 3;
      continue;
    }
    if (s.startsWith('|:', pos)) {
      tokens.push({ type: 'barline', kind: 'repeatStart' });
      pos += 2;
      continue;
    }
    if (s.startsWith(':||', pos)) {
      tokens.push({ type: 'barline', kind: 'repeatEnd' });
      pos += 3;
      continue;
    }
    if (s.startsWith(':|', pos)) {
      tokens.push({ type: 'barline', kind: 'repeatEnd' });
      pos += 2;
      continue;
    }
    if (s.startsWith('||', pos)) {
      tokens.push({ type: 'barline', kind: 'double' });
      pos += 2;
      continue;
    }
    if (ch === '|') {
      tokens.push({ type: 'barline', kind: 'single' });
      pos += 1;
      continue;
    }

    // Brackets: volta endings, chord symbols, section tags, or bracketed notes
    if (ch === '[') {
      const closeIdx = s.indexOf(']', pos + 1);
      if (closeIdx !== -1) {
        const inner = s.slice(pos + 1, closeIdx).trim();
        const voltaMatch = inner.match(/^([12])[.、]?$/);
        if (voltaMatch?.[1]) {
          tokens.push({ type: 'ending', ending: Number(voltaMatch[1]) as 1 | 2 });
          pos = closeIdx + 1;
          continue;
        }
        if (CHORD_SYMBOL_CORE_RE.test(inner)) {
          tokens.push({ type: 'chord', symbol: inner });
          pos = closeIdx + 1;
          continue;
        }
        if (!/[0-7]/.test(inner)) {
          pos = closeIdx + 1;
          continue;
        }
        const innerTokens = tokenizeMelodyLine(inner, skippedTokens);
        tokens.push(...innerTokens);
        pos = closeIdx + 1;
        continue;
      }
      pos += 1;
      continue;
    }

    if (ch === ']') {
      pos += 1;
      continue;
    }

    // Parentheses: slur groups or non-note annotations
    if (ch === '(') {
      const closeIdx = s.indexOf(')', pos + 1);
      if (closeIdx !== -1) {
        const inner = s.slice(pos + 1, closeIdx).trim();
        if (!/[0-7]/.test(inner)) {
          pos = closeIdx + 1;
          continue;
        }
        const innerTokens = tokenizeMelodyLine(inner, skippedTokens);
        const noteCount = innerTokens.filter((t) => t.type === 'note').length;
        if (noteCount >= 2) {
          tokens.push({ type: 'slurStart' });
          tokens.push(...innerTokens);
          tokens.push({ type: 'slurEnd' });
        } else {
          tokens.push(...innerTokens);
        }
        pos = closeIdx + 1;
        continue;
      }
      pos += 1;
      continue;
    }

    if (ch === ')') {
      pos += 1;
      continue;
    }

    // Bare chord symbols (uppercase A-G only so lowercase b7 stays flat-7)
    if (ch >= 'A' && ch <= 'G') {
      const chordMatch = s.slice(pos).match(BARE_CHORD_RE);
      if (chordMatch?.[0]) {
        tokens.push({ type: 'chord', symbol: chordMatch[0] });
        pos += chordMatch[0].length;
        continue;
      }
    }

    if (ch === '~' || ch === '⌒') {
      tokens.push({ type: 'tie' });
      pos += 1;
      continue;
    }

    if (ch === '-') {
      tokens.push({ type: 'dash' });
      pos += 1;
      continue;
    }

    if (ch === '.') {
      tokens.push({ type: 'dot' });
      pos += 1;
      continue;
    }

    // Note token (with optional prefix modifiers)
    let scan = pos;
    let accidental: Accidental = null;
    let octaveOffset = 0;

    while (scan < s.length && isPrefixModifierChar(s[scan]!)) {
      const pCh = s[scan]!;
      if (pCh === '+' || pCh === '↑') {
        octaveOffset += 1;
      } else if (pCh === '↓') {
        octaveOffset -= 1;
      } else {
        const acc = charToAccidental(pCh);
        if (acc !== null) {
          accidental = acc;
        }
      }
      scan += 1;
    }

    if (scan < s.length && isNoteDigit(s[scan])) {
      const digit = Number(s[scan]) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
      scan += 1;
      let underlineCount = 0;
      let dotted = false;

      while (scan < s.length) {
        const post = s[scan]!;
        if (post === "'" || post === '˙' || post === '\u0307' || post === '+' || post === '↑') {
          octaveOffset += 1;
          scan += 1;
        } else if (post === ',' || post === '\u0323' || post === '↓') {
          octaveOffset -= 1;
          scan += 1;
        } else if (post === '_' || post === '/') {
          underlineCount += 1;
          scan += 1;
        } else if (post === '.') {
          dotted = true;
          scan += 1;
        } else if (
          isAccidentalChar(post) &&
          accidental === null &&
          !isNoteDigit(s[scan + 1])
        ) {
          accidental = charToAccidental(post);
          scan += 1;
        } else {
          break;
        }
      }

      tokens.push({
        type: 'note',
        digit,
        accidental: digit === 0 ? null : accidental,
        octaveOffset: Math.max(-2, Math.min(2, octaveOffset)) as -2 | -1 | 0 | 1 | 2,
        underlineCount: Math.max(0, Math.min(2, underlineCount)) as 0 | 1 | 2,
        dotted,
      });
      pos = scan;
      continue;
    }

    // Consume unrecognized token safely so we never loop forever
    let badEnd = pos + 1;
    while (
      badEnd < s.length &&
      !/[\s|()[\]~⌒.\-0-7]/.test(s[badEnd]!) &&
      !isPrefixModifierChar(s[badEnd]!)
    ) {
      badEnd += 1;
    }
    const badTok = s.slice(pos, badEnd).trim();
    if (badTok.length > 0) {
      skippedTokens.push(badTok);
    }
    pos = badEnd;
  }

  return tokens;
}

function decomposeTicksToDurations(
  totalTicks: number
): Array<{ baseDuration: BaseDuration; dotted: boolean; durationTicks: number }> {
  let remaining = Math.max(120, Math.round(totalTicks));
  const result: Array<{ baseDuration: BaseDuration; dotted: boolean; durationTicks: number }> = [];

  while (remaining >= 120) {
    let chosen = DURATION_DECOMPOSITION_TABLE[DURATION_DECOMPOSITION_TABLE.length - 1]!;
    for (const candidate of DURATION_DECOMPOSITION_TABLE) {
      if (candidate.ticks <= remaining) {
        chosen = candidate;
        break;
      }
    }
    result.push({
      baseDuration: chosen.baseDuration,
      dotted: chosen.dotted,
      durationTicks: chosen.ticks,
    });
    remaining -= chosen.ticks;
  }

  if (result.length === 0) {
    result.push({ baseDuration: 'quarter', dotted: false, durationTicks: 480 });
  }
  return result;
}

function buildBeatFromSpec(
  digit: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7,
  accidental: Accidental,
  octaveOffset: -2 | -1 | 0 | 1 | 2,
  baseDuration: BaseDuration,
  dotted: boolean,
  keySignature: KeySignature,
  beatId: string
): Beat {
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
  const resolved = resolveNotePitch(
    {
      id: beatId,
      isRest: false,
      degree,
      octaveOffset,
      accidental,
      baseDuration,
      dotted,
      durationTicks,
    },
    keySignature
  );

  const midiPitch = Math.max(24, Math.min(108, resolved ? resolved.midiPitch : 60));
  const pitchNode: PitchNode = {
    id: `${beatId}_p0`,
    midiPitch,
    degree,
    octaveOffset,
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

function resolveNoteDurations(
  underlineCount: 0 | 1 | 2,
  initialDotted: boolean,
  dashCount: number,
  extraDotAfterDash: boolean
): Array<{ baseDuration: BaseDuration; dotted: boolean; durationTicks: number }> {
  const hasDot = initialDotted || extraDotAfterDash;

  if (dashCount === 0) {
    const baseDuration: BaseDuration =
      underlineCount >= 2 ? 'sixteenth' : underlineCount === 1 ? 'eighth' : 'quarter';
    return [
      {
        baseDuration,
        dotted: hasDot,
        durationTicks: calculateDurationTicks(baseDuration, hasDot),
      },
    ];
  }

  if (dashCount === 1) {
    if (underlineCount === 1 && !hasDot) {
      return [{ baseDuration: 'quarter', dotted: true, durationTicks: 720 }];
    }
    if (hasDot) {
      return [{ baseDuration: 'half', dotted: true, durationTicks: 1440 }];
    }
    return [{ baseDuration: 'half', dotted: false, durationTicks: 960 }];
  }

  if (dashCount === 2) {
    if (!hasDot) {
      return [{ baseDuration: 'half', dotted: true, durationTicks: 1440 }];
    }
    return decomposeTicksToDurations(1680);
  }

  if (dashCount === 3) {
    if (!hasDot) {
      return [{ baseDuration: 'whole', dotted: false, durationTicks: 1920 }];
    }
    return decomposeTicksToDurations(2160);
  }

  const totalTicks = (1 + dashCount) * 480 + (hasDot ? 240 : 0);
  return decomposeTicksToDurations(totalTicks);
}

interface InternalParseResult {
  docV2: ScoreDocumentV2 | null;
  error: ReturnType<typeof createAppError> | null;
  diagnostics: JianpuParseDiagnostics;
}

function parseJianpuInternal(
  text: string,
  options?: JianpuTextParseOptions
): InternalParseResult {
  const fallbackTitle = options?.title?.trim() || '简谱导入曲谱';
  const fallbackKey = options?.keySignature ?? 'C';
  const fallbackTime = options?.timeSignature ?? '4/4';
  const fallbackBpm = options?.bpm ?? 90;

  if (typeof text !== 'string' || text.trim().length === 0) {
    const err = createAppError('STORAGE_SCHEMA_CORRUPTED', '简谱文本内容为空，请输入简谱音符后再导入');
    return {
      docV2: null,
      error: err,
      diagnostics: {
        ok: false,
        title: fallbackTitle,
        keySignature: fallbackKey,
        timeSignature: fallbackTime,
        bpm: fallbackBpm,
        measureCount: 0,
        noteCount: 0,
        skippedTokens: [],
        overflowMeasures: [],
        underflowMeasures: [],
        errorDetail: err.detail,
      },
    };
  }

  const lines = text.split(/\r?\n/);
  const header = parseDocumentLines(lines, options);
  const melodySegments = header.bodySegments.filter((seg) => seg.kind === 'melody');

  if (melodySegments.length === 0) {
    const err = createAppError('STORAGE_SCHEMA_CORRUPTED', '简谱文本中未找到可识别的音符内容');
    return {
      docV2: null,
      error: err,
      diagnostics: {
        ok: false,
        title: header.title,
        keySignature: header.keySignature,
        timeSignature: header.timeSignature,
        bpm: header.bpm,
        measureCount: 0,
        noteCount: 0,
        skippedTokens: [],
        overflowMeasures: [],
        underflowMeasures: [],
        errorDetail: err.detail,
      },
    };
  }

  const skippedTokens: string[] = [];
  const tokenizedSegments = header.bodySegments.map((seg) =>
    seg.kind === 'melody'
      ? { kind: 'melody' as const, tokens: tokenizeMelodyLine(seg.raw, skippedTokens) }
      : seg
  );

  const hasExplicitBarlines = tokenizedSegments.some(
    (seg) => seg.kind === 'melody' && seg.tokens.some((t) => t.type === 'barline')
  );
  const measureCapacity = getMeasureCapacityTicks(header.timeSignature);

  const measures: V2Measure[] = [];
  let currentBeats: Beat[] = [];
  let currentMeasureTicks = 0;
  let pendingRepeatStart = false;
  let pendingEnding: 1 | 2 | undefined;
  let pendingChordSymbol: string | undefined;
  let pendingTie = false;
  let pendingSlurStart = false;
  const beatTracker: { lastEmittedBeat: Beat | null; lastNonRestBeat: Beat | null } = {
    lastEmittedBeat: null,
    lastNonRestBeat: null,
  };
  let beatSeq = 1;
  let noteTotalCount = 0;

  const flushMeasure = (extra?: {
    repeatEnd?: boolean;
    barline?: MeasureBarlineType;
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
    if (pendingEnding !== undefined) {
      m.ending = pendingEnding;
      pendingEnding = undefined;
    }
    if (extra?.repeatEnd) {
      m.repeatEnd = true;
    }
    if (extra?.barline && extra.barline !== 'single') {
      m.barline = extra.barline;
    }
    measures.push(m);
    currentBeats = [];
    currentMeasureTicks = 0;
  };

  const pushBeat = (beat: Beat) => {
    if (
      !hasExplicitBarlines &&
      currentBeats.length > 0 &&
      currentMeasureTicks + beat.durationTicks > measureCapacity
    ) {
      flushMeasure();
    }
    currentBeats.push(beat);
    currentMeasureTicks += beat.durationTicks;
    beatTracker.lastEmittedBeat = beat;
    if (!beat.isRest) {
      beatTracker.lastNonRestBeat = beat;
    }
    noteTotalCount += 1;
  };

  let lastMelodyLineStartIdx = 0;
  const allEmittedBeats: Beat[] = [];

  for (const seg of tokenizedSegments) {
    if (seg.kind === 'lyric') {
      const targetBeats = allEmittedBeats
        .slice(lastMelodyLineStartIdx)
        .filter((b) => !b.isRest && !b.tieEnd && !b.lyric);
      for (let i = 0; i < Math.min(targetBeats.length, seg.syllables.length); i += 1) {
        targetBeats[i]!.lyric = seg.syllables[i]!;
      }
      continue;
    }

    lastMelodyLineStartIdx = allEmittedBeats.length;
    const tokens = seg.tokens;

    for (let i = 0; i < tokens.length; i += 1) {
      const tok = tokens[i]!;

      if (tok.type === 'barline') {
        if (tok.kind === 'single') {
          if (currentBeats.length > 0) {
            flushMeasure();
          }
        } else if (tok.kind === 'double') {
          if (currentBeats.length > 0) {
            flushMeasure({ barline: 'double' });
          } else if (measures.length > 0) {
            measures[measures.length - 1]!.barline = 'double';
          }
        } else if (tok.kind === 'repeatStart') {
          if (currentBeats.length > 0) {
            flushMeasure();
          }
          pendingRepeatStart = true;
        } else if (tok.kind === 'repeatEnd') {
          if (currentBeats.length > 0) {
            flushMeasure({ repeatEnd: true });
          } else if (measures.length > 0) {
            measures[measures.length - 1]!.repeatEnd = true;
          }
        } else if (tok.kind === 'repeatBoth') {
          if (currentBeats.length > 0) {
            flushMeasure({ repeatEnd: true });
          } else if (measures.length > 0) {
            measures[measures.length - 1]!.repeatEnd = true;
          }
          pendingRepeatStart = true;
        }
        continue;
      }

      if (tok.type === 'ending') {
        pendingEnding = tok.ending;
        continue;
      }

      if (tok.type === 'chord') {
        pendingChordSymbol = tok.symbol;
        continue;
      }

      if (tok.type === 'tie') {
        pendingTie = true;
        continue;
      }

      if (tok.type === 'slurStart') {
        pendingSlurStart = true;
        continue;
      }

      if (tok.type === 'slurEnd') {
        if (beatTracker.lastNonRestBeat) {
          beatTracker.lastNonRestBeat.slurEnd = true;
        }
        pendingSlurStart = false;
        continue;
      }

      if (tok.type === 'dot') {
        continue;
      }

      if (tok.type === 'dash') {
        let dashCount = 1;
        let hasDot = false;
        while (i + 1 < tokens.length) {
          const nxt = tokens[i + 1]!;
          if (nxt.type === 'dash') {
            dashCount += 1;
            i += 1;
          } else if (nxt.type === 'dot') {
            hasDot = true;
            i += 1;
          } else {
            break;
          }
        }

        if (!beatTracker.lastEmittedBeat) {
          continue;
        }

        const totalTicks = dashCount * 480 + (hasDot ? 240 : 0);
        const parts = decomposeTicksToDurations(totalTicks);
        const prevBeat = beatTracker.lastEmittedBeat;
        const leadPitch = prevBeat.notes[0];

        for (let pIdx = 0; pIdx < parts.length; pIdx += 1) {
          const part = parts[pIdx]!;
          const beatId = `jp_n_${beatSeq++}`;
          let contBeat: Beat;
          if (prevBeat.isRest || !leadPitch) {
            contBeat = buildBeatFromSpec(
              0,
              null,
              0,
              part.baseDuration,
              part.dotted,
              header.keySignature,
              beatId
            );
          } else {
            contBeat = buildBeatFromSpec(
              leadPitch.degree,
              leadPitch.accidental,
              leadPitch.octaveOffset,
              part.baseDuration,
              part.dotted,
              header.keySignature,
              beatId
            );
            const anchorPrev = pIdx === 0 ? prevBeat : beatTracker.lastEmittedBeat;
            if (anchorPrev && !anchorPrev.isRest) {
              anchorPrev.tieStart = true;
              contBeat.tieEnd = true;
            }
          }
          if (pIdx === 0 && pendingChordSymbol) {
            contBeat.chordSymbol = pendingChordSymbol;
            pendingChordSymbol = undefined;
          }
          pushBeat(contBeat);
          allEmittedBeats.push(contBeat);
        }
        continue;
      }

      // Note token
      let dashCount = 0;
      let extraDotAfterDash = false;
      while (i + 1 < tokens.length) {
        const nxt = tokens[i + 1]!;
        if (nxt.type === 'dash') {
          dashCount += 1;
          i += 1;
        } else if (nxt.type === 'dot') {
          extraDotAfterDash = true;
          i += 1;
        } else {
          break;
        }
      }

      const durParts = resolveNoteDurations(
        tok.underlineCount,
        tok.dotted,
        dashCount,
        extraDotAfterDash
      );

      for (let pIdx = 0; pIdx < durParts.length; pIdx += 1) {
        const part = durParts[pIdx]!;
        const beatId = `jp_n_${beatSeq++}`;
        const beat = buildBeatFromSpec(
          tok.digit,
          tok.accidental,
          tok.octaveOffset,
          part.baseDuration,
          part.dotted,
          header.keySignature,
          beatId
        );

        if (!beat.isRest) {
          if (
            pIdx === 0 &&
            pendingTie &&
            beatTracker.lastNonRestBeat &&
            beatTracker.lastNonRestBeat === beatTracker.lastEmittedBeat
          ) {
            beatTracker.lastNonRestBeat.tieStart = true;
            beat.tieEnd = true;
          }
          if (pIdx === 0 && pendingSlurStart) {
            beat.slurStart = true;
            pendingSlurStart = false;
          }
          if (pIdx > 0 && beatTracker.lastNonRestBeat) {
            beatTracker.lastNonRestBeat.tieStart = true;
            beat.tieEnd = true;
          }
        }
        if (pIdx === 0) {
          pendingTie = false;
          if (pendingChordSymbol) {
            beat.chordSymbol = pendingChordSymbol;
            pendingChordSymbol = undefined;
          }
        }

        pushBeat(beat);
        allEmittedBeats.push(beat);
      }
    }

    if (hasExplicitBarlines && currentBeats.length > 0) {
      flushMeasure();
    }
  }

  if (currentBeats.length > 0) {
    flushMeasure();
  }

  // Attach global header lyrics to any remaining non-rest, non-tieEnd beats without lyrics
  if (header.lyricsQueue.length > 0) {
    let lyricIdx = 0;
    for (const beat of allEmittedBeats) {
      if (lyricIdx >= header.lyricsQueue.length) {
        break;
      }
      if (!beat.isRest && !beat.tieEnd && !beat.lyric) {
        beat.lyric = header.lyricsQueue[lyricIdx]!;
        lyricIdx += 1;
      }
    }
  }

  if (measures.length > 0) {
    const lastMeasure = measures[measures.length - 1]!;
    if (lastMeasure.barline === 'double') {
      lastMeasure.barline = 'final';
    }
  }

  if (noteTotalCount === 0 || measures.length === 0) {
    const err = createAppError(
      'STORAGE_SCHEMA_CORRUPTED',
      '未能从输入文本中解析出有效简谱音符（支持 1-7、0、_ 减时线、- 增时线与 | 小节线）'
    );
    return {
      docV2: null,
      error: err,
      diagnostics: {
        ok: false,
        title: header.title,
        keySignature: header.keySignature,
        timeSignature: header.timeSignature,
        bpm: header.bpm,
        measureCount: 0,
        noteCount: 0,
        skippedTokens,
        overflowMeasures: [],
        underflowMeasures: [],
        errorDetail: err.detail,
      },
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

  const validated = validateScoreDocumentV2(docV2);
  if (!validated.ok) {
    return {
      docV2: null,
      error: validated.error,
      diagnostics: {
        ok: false,
        title: header.title,
        keySignature: header.keySignature,
        timeSignature: header.timeSignature,
        bpm: header.bpm,
        measureCount: measures.length,
        noteCount: noteTotalCount,
        skippedTokens,
        overflowMeasures: [],
        underflowMeasures: [],
        errorDetail: validated.error.detail,
      },
    };
  }

  const v1Projected = projectV2ToV1(validated.value);
  const overflowMeasures: number[] = [];
  const underflowMeasures: number[] = [];
  v1Projected.measures.forEach((m: Measure, idx: number) => {
    const rhythm = validateMeasureRhythm(m, validated.value.timeSignature);
    if (rhythm.ok) {
      if (rhythm.value.state === 'OVERFLOW') {
        overflowMeasures.push(idx + 1);
      } else if (rhythm.value.state === 'UNDERFLOW') {
        underflowMeasures.push(idx + 1);
      }
    }
  });

  return {
    docV2: validated.value,
    error: null,
    diagnostics: {
      ok: true,
      title: validated.value.title,
      keySignature: validated.value.keySignature,
      timeSignature: validated.value.timeSignature,
      bpm: validated.value.bpm,
      measureCount: measures.length,
      noteCount: noteTotalCount,
      skippedTokens,
      overflowMeasures,
      underflowMeasures,
    },
  };
}

/**
 * 预检简谱文本解析结果，返回识别出的调号、拍号、BPM、小节数、音符数及超拍/忽略片段提示。
 */
export function inspectJianpuText(
  text: string,
  options?: JianpuTextParseOptions
): JianpuParseDiagnostics {
  return parseJianpuInternal(text, options).diagnostics;
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
  const internal = parseJianpuInternal(text, options);
  if (!internal.docV2) {
    return {
      ok: false,
      error:
        internal.error ??
        createAppError('STORAGE_SCHEMA_CORRUPTED', '简谱文本解析失败，请检查输入格式'),
    };
  }
  return {
    ok: true,
    value: internal.docV2,
  };
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
    const suffix = m.repeatEnd
      ? ' :||'
      : m.barline === 'final' || m.barline === 'double'
        ? ' ||'
        : '';
    return `${prefix}${tokens.join(' ')}${suffix}`;
  });

  let joinedBody = '';
  for (let i = 0; i < measureStrings.length; i += 1) {
    const curr = measureStrings[i]!;
    if (i === 0) {
      joinedBody = curr;
      continue;
    }
    const prev = measureStrings[i - 1]!;
    const prevEndsWithSpecialBar = prev.endsWith(':||') || prev.endsWith('||');
    const currStartsWithRepeat = curr.startsWith('||:');
    if (prevEndsWithSpecialBar || currStartsWithRepeat) {
      joinedBody += ` ${curr}`;
    } else {
      joinedBody += ` | ${curr}`;
    }
  }

  lines.push(joinedBody);
  return lines.join('\n');
}

export { mapMidiToPitchNode, quantizeTicksToDuration };
