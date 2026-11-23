import { getMeasureCapacityTicks, VALID_TIME_SIGNATURES } from '../../domain/rhythm.ts';
import { createAppError } from '../../domain/state-machines.ts';
import { VALID_KEY_SIGNATURES } from '../../domain/theory.ts';
import type {
  BaseDuration,
  KeySignature,
  Result,
  TimeSignature,
} from '../../domain/types.ts';
import { normalizeGuitarTechniques } from '../../domain/v2-instruments.ts';
import {
  mapMidiToPitchNode,
  quantizeTicksToDuration,
  validateScoreDocumentV2,
} from '../../domain/v2-serializer.ts';
import type {
  Beat,
  DynamicMarking,
  GuitarTechnique,
  InstrumentId,
  PitchNode,
  ScoreDocumentV2,
  Track,
  V2Measure,
  Voice,
} from '../../domain/v2-types.ts';
import {
  childText,
  findChild,
  findChildren,
  parseXml,
  type XmlElement,
} from './xml-parser.ts';
import { unpackZip } from './zip-codec.ts';

export interface GuitarProImportOptions {
  title?: string;
  nowMs?: number;
  id?: string;
}

const STANDARD_GUITAR_TUNING = [64, 59, 55, 50, 45, 40];
const STANDARD_BASS4_TUNING = [43, 38, 33, 28];

const FIFTHS_TO_KEY: Record<number, KeySignature> = {
  [-6]: 'Gb',
  [-5]: 'Db',
  [-4]: 'Ab',
  [-3]: 'Eb',
  [-2]: 'Bb',
  [-1]: 'F',
  0: 'C',
  1: 'G',
  2: 'D',
  3: 'A',
  4: 'E',
  5: 'B',
  6: 'Gb',
  7: 'Db',
  [-7]: 'B',
};

const FLAT_KEY_SET: ReadonlySet<KeySignature> = new Set([
  'F',
  'Bb',
  'Eb',
  'Ab',
  'Db',
  'Gb',
]);

const GPIF_DURATION_TO_BASE: Record<string, BaseDuration> = {
  Whole: 'whole',
  Half: 'half',
  Quarter: 'quarter',
  Eighth: 'eighth',
  '16th': 'sixteenth',
  '32nd': 'sixteenth',
  '64th': 'sixteenth',
};

const VALID_DYNAMICS: ReadonlySet<string> = new Set([
  'pp',
  'p',
  'mp',
  'mf',
  'f',
  'ff',
  'fp',
]);

function gpFail<T>(detail: string): Result<T> {
  return {
    ok: false,
    error: createAppError('STORAGE_SCHEMA_CORRUPTED', detail),
  };
}

function mapAccidentalCountToKey(count: number): KeySignature {
  const clamped = Math.max(-7, Math.min(7, Math.round(count)));
  return FIFTHS_TO_KEY[clamped] ?? 'C';
}

function normalizeTimeSignature(raw: string | undefined): TimeSignature {
  if (!raw) return '4/4';
  const cleaned = raw.trim();
  if (VALID_TIME_SIGNATURES.includes(cleaned as TimeSignature)) {
    return cleaned as TimeSignature;
  }
  return '4/4';
}

function normalizeTuningHighToLow(rawPitches: number[]): number[] {
  if (rawPitches.length === 0) {
    return [...STANDARD_GUITAR_TUNING];
  }
  const first = rawPitches[0]!;
  const last = rawPitches[rawPitches.length - 1]!;
  // GPIF & GP5 通常由低音弦到高音弦排列（如 40..64），领域层统一高音弦到低音弦（64..40）
  if (first < last) {
    return [...rawPitches].reverse();
  }
  return [...rawPitches];
}

function inferInstrumentId(
  name: string,
  stringCount: number,
  soundHint = ''
): InstrumentId {
  const hay = `${name} ${soundHint}`.toLowerCase();
  if (
    stringCount === 4 ||
    stringCount === 5 ||
    /\bbass\b|贝斯/.test(hay)
  ) {
    return 'bass';
  }
  if (/piano|keyboard|grand|keys|钢琴|键盘/.test(hay)) {
    return 'piano';
  }
  if (/acoustic|nylon|steel|folk|classical|木吉他|原声/.test(hay)) {
    return 'acoustic-guitar';
  }
  if (/overdrive|distortion|dist|lead|metal|rock|solo|过载|失真|主音/.test(hay)) {
    return 'electric-guitar-od';
  }
  if (/melody|vocal|flute|voice|人声|旋律/.test(hay)) {
    return 'melody';
  }
  return 'electric-guitar-clean';
}

function buildRestBeat(
  id: string,
  baseDuration: BaseDuration,
  dotted: boolean,
  durationTicks: number
): Beat {
  return {
    id,
    isRest: true,
    baseDuration,
    dotted,
    durationTicks,
    notes: [],
  };
}

function padMeasuresToCount(
  measures: V2Measure[],
  targetCount: number,
  timeSignature: TimeSignature,
  prefix: string
): V2Measure[] {
  const cap = getMeasureCapacityTicks(timeSignature);
  const restSpec = quantizeTicksToDuration(cap);
  const out = [...measures];
  while (out.length < targetCount) {
    const idx = out.length;
    out.push({
      id: `${prefix}_m_${idx}`,
      index: idx,
      beats: [
        buildRestBeat(
          `${prefix}_m_${idx}_r0`,
          restSpec.baseDuration,
          restSpec.dotted,
          restSpec.durationTicks
        ),
      ],
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  GP6 BCFZ / BCFS 容器解压（用于 .gpx）                                    */
/* -------------------------------------------------------------------------- */

class GpxBitReader {
  private byteOffset = 0;
  private bitOffset = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array, startOffset = 0) {
    this.bytes = bytes;
    this.byteOffset = startOffset;
  }

  public hasMore(): boolean {
    return this.byteOffset < this.bytes.length;
  }

  public readBit(): number {
    if (this.byteOffset >= this.bytes.length) {
      return 0;
    }
    const bit = (this.bytes[this.byteOffset]! >> (7 - this.bitOffset)) & 1;
    this.bitOffset += 1;
    if (this.bitOffset >= 8) {
      this.bitOffset = 0;
      this.byteOffset += 1;
    }
    return bit;
  }

  public readBits(count: number): number {
    let val = 0;
    for (let i = 0; i < count; i += 1) {
      val = (val << 1) | this.readBit();
    }
    return val >>> 0;
  }

  public readBitsReversed(count: number): number {
    let val = 0;
    for (let i = 0; i < count; i += 1) {
      val |= this.readBit() << i;
    }
    return val >>> 0;
  }
}

export function decompressBcfz(bytes: Uint8Array): Result<Uint8Array> {
  if (bytes.byteLength < 8) {
    return gpFail('GPX 压缩头长度不足，文件已损坏');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const expectedSize = dv.getUint32(4, true);
  if (expectedSize <= 0 || expectedSize > 64 * 1024 * 1024) {
    return gpFail('GPX 解压尺寸异常，文件可能已损坏');
  }

  const reader = new GpxBitReader(bytes, 8);
  const out: number[] = [];

  try {
    while (out.length < expectedSize && reader.hasMore()) {
      const flag = reader.readBit();
      if (flag === 1) {
        const wordSize = reader.readBits(4);
        const offset = reader.readBitsReversed(wordSize);
        const len = reader.readBitsReversed(wordSize);
        if (offset === 0 || offset > out.length) {
          return gpFail('GPX 压缩块回溯偏移越界，文件已损坏');
        }
        const start = out.length - offset;
        for (let i = 0; i < len && out.length < expectedSize; i += 1) {
          out.push(out[start + i]!);
        }
      } else {
        const len = reader.readBitsReversed(2);
        for (let i = 0; i < len && out.length < expectedSize; i += 1) {
          out.push(reader.readBits(8) & 0xff);
        }
      }
    }
  } catch {
    return gpFail('解压 GPX 压缩容器失败，文件结构已损坏');
  }

  return { ok: true, value: new Uint8Array(out) };
}

export function extractFilesFromBcfs(
  bcfsBytes: Uint8Array
): Result<Map<string, Uint8Array>> {
  const SECTOR_SIZE = 0x1000;
  if (bcfsBytes.byteLength < SECTOR_SIZE) {
    return gpFail('GPX 文件系统长度不足，文件已损坏');
  }

  const dv = new DataView(
    bcfsBytes.buffer,
    bcfsBytes.byteOffset,
    bcfsBytes.byteLength
  );
  if (dv.getUint32(0, false) !== 0x42434653) {
    return gpFail('GPX 缺少 BCFS 文件系统签名');
  }

  const decoder = new TextDecoder('utf-8');
  const files = new Map<string, Uint8Array>();

  for (
    let sectorOffset = SECTOR_SIZE;
    sectorOffset + 0x98 <= bcfsBytes.byteLength;
    sectorOffset += SECTOR_SIZE
  ) {
    const entryType = dv.getInt32(sectorOffset, true);
    if (entryType !== 2) {
      continue;
    }

    let nameEnd = sectorOffset + 4;
    const maxNameEnd = Math.min(sectorOffset + 0x8b, bcfsBytes.byteLength);
    while (nameEnd < maxNameEnd && bcfsBytes[nameEnd] !== 0) {
      nameEnd += 1;
    }
    const name = decoder.decode(bcfsBytes.subarray(sectorOffset + 4, nameEnd));
    const fileSize = dv.getUint32(sectorOffset + 0x8c, true);
    if (!name || fileSize > 32 * 1024 * 1024) {
      continue;
    }

    const chunks: Uint8Array[] = [];
    let remaining = fileSize;
    let idxCursor = sectorOffset + 0x94;
    while (remaining > 0 && idxCursor + 4 <= sectorOffset + SECTOR_SIZE) {
      const dataSector = dv.getUint32(idxCursor, true);
      idxCursor += 4;
      if (dataSector === 0) {
        break;
      }
      const dataStart = dataSector * SECTOR_SIZE;
      if (dataStart >= bcfsBytes.byteLength) {
        return gpFail('GPX 扇区索引越界，文件已损坏');
      }
      const take = Math.min(remaining, SECTOR_SIZE, bcfsBytes.byteLength - dataStart);
      chunks.push(bcfsBytes.subarray(dataStart, dataStart + take));
      remaining -= take;
    }

    const merged = new Uint8Array(fileSize - remaining);
    let pos = 0;
    for (const chunk of chunks) {
      merged.set(chunk, pos);
      pos += chunk.byteLength;
    }
    files.set(name, merged);
  }

  return { ok: true, value: files };
}

/* -------------------------------------------------------------------------- */
/*  GPIF XML 解析器（.gp / .gpx 内部核心模型）                                */
/* -------------------------------------------------------------------------- */

function getPropertyNode(
  parent: XmlElement,
  propName: string
): XmlElement | undefined {
  const props = findChild(parent, 'Properties');
  if (!props) return undefined;
  return findChildren(props, 'Property').find(
    (p) => p.attrs.name === propName
  );
}

function parseIntList(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .trim()
    .split(/\s+/)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
}

function parseGpifTechniques(noteEl: XmlElement, beatEl: XmlElement): {
  techniques: GuitarTechnique[];
  tieOrigin: boolean;
  tieDestination: boolean;
} {
  const found: GuitarTechnique[] = [];
  const propsEl = findChild(noteEl, 'Properties');
  const noteProps = propsEl ? findChildren(propsEl, 'Property') : [];

  const hasProp = (name: string): XmlElement | undefined =>
    noteProps.find((p) => p.attrs.name === name);

  const bendedProp = hasProp('Bended') ?? hasProp('Bend');
  if (bendedProp) {
    const flag = childText(bendedProp, 'Enable');
    if (flag === undefined || flag === 'true' || flag === '1') {
      found.push('bend');
    }
  }
  if (hasProp('Slide')) {
    found.push('slide');
  }
  if (hasProp('HopoOrigin')) {
    found.push('hammer');
  }
  if (hasProp('HopoDestination')) {
    found.push('pull');
  }
  if (hasProp('PalmMuted') || hasProp('PalmMute') || findChild(beatEl, 'PalmMute')) {
    found.push('palm-mute');
  }
  if (findChild(noteEl, 'Vibrato') || hasProp('Vibrato')) {
    found.push('vibrato');
  }

  const tieEl = findChild(noteEl, 'Tie');
  const tieOrigin = tieEl?.attrs.origin === 'true';
  const tieDestination = tieEl?.attrs.destination === 'true';

  return {
    techniques: normalizeGuitarTechniques(found),
    tieOrigin,
    tieDestination,
  };
}

function parseGpifXmlToScoreV2(
  xmlText: string,
  options?: GuitarProImportOptions
): Result<ScoreDocumentV2> {
  const xmlRes = parseXml(xmlText);
  if (!xmlRes.ok) {
    return xmlRes;
  }
  const root = xmlRes.value;
  if (root.tag !== 'GPIF') {
    return gpFail('Guitar Pro 文件缺少 GPIF 根节点，格式不受支持');
  }

  const scoreEl = findChild(root, 'Score');
  const rawTitle =
    (scoreEl ? childText(scoreEl, 'Title') : undefined)?.trim() ||
    options?.title?.trim() ||
    '导入 Guitar Pro 曲谱';
  const subtitle = scoreEl ? childText(scoreEl, 'SubTitle')?.trim() : undefined;
  const composer =
    (scoreEl ? childText(scoreEl, 'Music') ?? childText(scoreEl, 'Artist') : undefined)?.trim();
  const lyricist = scoreEl ? childText(scoreEl, 'Words')?.trim() : undefined;

  let bpm = 100;
  const masterTrackEl = findChild(root, 'MasterTrack');
  const automationsEl = masterTrackEl ? findChild(masterTrackEl, 'Automations') : undefined;
  if (automationsEl) {
    for (const auto of findChildren(automationsEl, 'Automation')) {
      if (childText(auto, 'Type') === 'Tempo') {
        const valText = childText(auto, 'Value') ?? '';
        const firstNum = Number.parseFloat(valText.trim().split(/\s+/)[0] ?? '100');
        if (Number.isFinite(firstNum) && firstNum > 0) {
          bpm = Math.max(40, Math.min(200, Math.round(firstNum)));
          break;
        }
      }
    }
  }

  const rhythmsById = new Map<string, XmlElement>();
  const rhythmsEl = findChild(root, 'Rhythms');
  if (rhythmsEl) {
    for (const r of findChildren(rhythmsEl, 'Rhythm')) {
      if (r.attrs.id) rhythmsById.set(r.attrs.id, r);
    }
  }

  const notesById = new Map<string, XmlElement>();
  const notesEl = findChild(root, 'Notes');
  if (notesEl) {
    for (const n of findChildren(notesEl, 'Note')) {
      if (n.attrs.id) notesById.set(n.attrs.id, n);
    }
  }

  const beatsById = new Map<string, XmlElement>();
  const beatsEl = findChild(root, 'Beats');
  if (beatsEl) {
    for (const b of findChildren(beatsEl, 'Beat')) {
      if (b.attrs.id) beatsById.set(b.attrs.id, b);
    }
  }

  const voicesById = new Map<string, XmlElement>();
  const voicesEl = findChild(root, 'Voices');
  if (voicesEl) {
    for (const v of findChildren(voicesEl, 'Voice')) {
      if (v.attrs.id) voicesById.set(v.attrs.id, v);
    }
  }

  const barsById = new Map<string, XmlElement>();
  const barsEl = findChild(root, 'Bars');
  if (barsEl) {
    for (const bar of findChildren(barsEl, 'Bar')) {
      if (bar.attrs.id) barsById.set(bar.attrs.id, bar);
    }
  }

  const masterBarsEl = findChild(root, 'MasterBars');
  const masterBars = masterBarsEl ? findChildren(masterBarsEl, 'MasterBar') : [];
  if (masterBars.length === 0) {
    return gpFail('Guitar Pro 文件未包含任何有效小节');
  }

  const firstMb = masterBars[0]!;
  const keyEl = findChild(firstMb, 'Key');
  const accCount = keyEl
    ? Number.parseInt(childText(keyEl, 'AccidentalCount') ?? '0', 10)
    : 0;
  const keySignature: KeySignature = VALID_KEY_SIGNATURES.includes(
    mapAccidentalCountToKey(Number.isFinite(accCount) ? accCount : 0)
  )
    ? mapAccidentalCountToKey(Number.isFinite(accCount) ? accCount : 0)
    : 'C';
  const preferFlat = FLAT_KEY_SET.has(keySignature);
  const timeSignature = normalizeTimeSignature(childText(firstMb, 'Time'));

  const tracksEl = findChild(root, 'Tracks');
  const trackEls = tracksEl ? findChildren(tracksEl, 'Track') : [];
  if (trackEls.length === 0) {
    return gpFail('Guitar Pro 文件未包含任何音轨');
  }

  const tracks: Track[] = [];
  for (let tIdx = 0; tIdx < trackEls.length; tIdx += 1) {
    const trEl = trackEls[tIdx]!;
    const trName =
      childText(trEl, 'Name')?.trim() ||
      childText(trEl, 'ShortName')?.trim() ||
      `吉他轨 ${tIdx + 1}`;
    const tuningProp = getPropertyNode(trEl, 'Tuning');
    const rawTuningPitches = parseIntList(
      tuningProp ? childText(tuningProp, 'Pitches') : undefined
    );
    const capoProp = getPropertyNode(trEl, 'CapoFret');
    const capoVal = capoProp
      ? Number.parseInt(childText(capoProp, 'Fret') ?? '0', 10)
      : 0;
    const capo = Number.isFinite(capoVal) ? Math.max(0, Math.min(12, capoVal)) : 0;

    const soundHint = childText(trEl, 'ShortName') ?? '';
    const stringCount =
      rawTuningPitches.length > 0 ? rawTuningPitches.length : 6;
    const instrumentId = inferInstrumentId(trName, stringCount, soundHint);
    const normalizedTuning =
      rawTuningPitches.length > 0
        ? normalizeTuningHighToLow(rawTuningPitches)
        : instrumentId === 'bass'
          ? [...STANDARD_BASS4_TUNING]
          : [...STANDARD_GUITAR_TUNING];

    const voice0Measures: V2Measure[] = [];
    const voice1Measures: V2Measure[] = [];
    let hasVoice1Notes = false;

    for (let mIdx = 0; mIdx < masterBars.length; mIdx += 1) {
      const mb = masterBars[mIdx]!;
      const barIds = (childText(mb, 'Bars') ?? '')
        .trim()
        .split(/\s+/)
        .filter((s) => s.length > 0);
      const barId = barIds[tIdx];
      const barEl = barId ? barsById.get(barId) : undefined;
      const barVoiceIds = (barEl ? childText(barEl, 'Voices') ?? '' : '')
        .trim()
        .split(/\s+/)
        .filter((s) => s.length > 0 && s !== '-1');

      const repeatEl = findChild(mb, 'Repeat');
      const repeatStart = repeatEl?.attrs.start === 'true';
      const repeatEnd = repeatEl?.attrs.end === 'true';
      const altEndText = childText(mb, 'AlternateEndings')?.trim();
      const ending =
        altEndText === '1' ? 1 : altEndText === '2' ? 2 : undefined;

      const convertVoiceBar = (vId: string | undefined, vIdx: number): Beat[] => {
        if (!vId) return [];
        const voiceEl = voicesById.get(vId);
        if (!voiceEl) return [];
        const beatIds = (childText(voiceEl, 'Beats') ?? '')
          .trim()
          .split(/\s+/)
          .filter((s) => s.length > 0);

        const outBeats: Beat[] = [];
        for (let bIdx = 0; bIdx < beatIds.length; bIdx += 1) {
          const beatEl = beatsById.get(beatIds[bIdx]!);
          if (!beatEl) continue;

          const rhythmRef = findChild(beatEl, 'Rhythm')?.attrs.ref;
          const rhythmEl = rhythmRef ? rhythmsById.get(rhythmRef) : undefined;
          const noteValText = rhythmEl ? childText(rhythmEl, 'NoteValue') : undefined;
          const baseDuration: BaseDuration =
            (noteValText && GPIF_DURATION_TO_BASE[noteValText]) || 'quarter';
          const dotted = Boolean(
            rhythmEl && findChild(rhythmEl, 'AugmentationDot')
          );
          const durSpec = quantizeTicksToDuration(
            baseDuration === 'whole'
              ? dotted
                ? 1920
                : 1920
              : baseDuration === 'half'
                ? dotted
                  ? 1440
                  : 960
                : baseDuration === 'quarter'
                  ? dotted
                    ? 720
                    : 480
                  : baseDuration === 'eighth'
                    ? dotted
                      ? 360
                      : 240
                    : dotted
                      ? 180
                      : 120
          );

          const beatId = `gp_t${tIdx}_v${vIdx}_m${mIdx}_b${bIdx}`;
          const noteIdList = (childText(beatEl, 'Notes') ?? '')
            .trim()
            .split(/\s+/)
            .filter((s) => s.length > 0);

          const pitchNodes: PitchNode[] = [];
          let anyTieStart = false;
          let anyTieEnd = false;

          for (let nIdx = 0; nIdx < noteIdList.length; nIdx += 1) {
            const noteEl = notesById.get(noteIdList[nIdx]!);
            if (!noteEl) continue;
            const strProp = getPropertyNode(noteEl, 'String');
            const fretProp = getPropertyNode(noteEl, 'Fret');
            const midiProp = getPropertyNode(noteEl, 'Midi');

            const rawStringIdx = strProp
              ? Number.parseInt(childText(strProp, 'String') ?? '0', 10)
              : 0;
            const fretVal = fretProp
              ? Number.parseInt(childText(fretProp, 'Fret') ?? '0', 10)
              : 0;
            const safeFret = Number.isFinite(fretVal)
              ? Math.max(0, Math.min(24, fretVal))
              : 0;

            let midiPitch: number | null = null;
            if (midiProp) {
              const mNum = Number.parseInt(childText(midiProp, 'Number') ?? '', 10);
              if (Number.isFinite(mNum)) {
                midiPitch = mNum;
              }
            }

            let displayString = 1;
            if (rawTuningPitches.length > 0) {
              const clampedRawIdx = Math.max(
                0,
                Math.min(rawTuningPitches.length - 1, rawStringIdx)
              );
              const isLowToHigh =
                rawTuningPitches[0]! <
                rawTuningPitches[rawTuningPitches.length - 1]!;
              displayString = isLowToHigh
                ? rawTuningPitches.length - clampedRawIdx
                : clampedRawIdx + 1;
              if (midiPitch === null) {
                midiPitch =
                  (rawTuningPitches[clampedRawIdx] ?? 40) + safeFret + capo;
              }
            } else if (midiPitch === null) {
              const openMidi =
                normalizedTuning[
                  Math.max(0, Math.min(normalizedTuning.length - 1, rawStringIdx))
                ] ?? 64;
              displayString = Math.max(
                1,
                Math.min(normalizedTuning.length, rawStringIdx + 1)
              );
              midiPitch = openMidi + safeFret + capo;
            }

            const { techniques, tieOrigin, tieDestination } =
              parseGpifTechniques(noteEl, beatEl);
            if (tieOrigin) anyTieStart = true;
            if (tieDestination) anyTieEnd = true;

            const pn = mapMidiToPitchNode(
              midiPitch,
              keySignature,
              `${beatId}_p${nIdx}`,
              preferFlat
            );
            pn.guitar = {
              string: displayString,
              fret: safeFret,
              ...(techniques.length > 0 ? { techniques } : {}),
            };
            pitchNodes.push(pn);
          }

          if (pitchNodes.length === 0) {
            outBeats.push(
              buildRestBeat(
                beatId,
                durSpec.baseDuration,
                durSpec.dotted,
                durSpec.durationTicks
              )
            );
          } else {
            const beat: Beat = {
              id: beatId,
              isRest: false,
              baseDuration: durSpec.baseDuration,
              dotted: durSpec.dotted,
              durationTicks: durSpec.durationTicks,
              notes: pitchNodes,
            };
            const dyn = childText(beatEl, 'Dynamic')?.trim().toLowerCase();
            if (dyn && VALID_DYNAMICS.has(dyn)) {
              beat.dynamic = dyn as DynamicMarking;
            }
            const freeText = childText(beatEl, 'FreeText')?.trim();
            if (freeText) {
              beat.lyric = freeText;
            }
            if (anyTieStart) beat.tieStart = true;
            if (anyTieEnd) beat.tieEnd = true;
            outBeats.push(beat);
          }
        }
        return outBeats;
      };

      const v0Beats = convertVoiceBar(barVoiceIds[0], 0);
      const fallbackCap = quantizeTicksToDuration(
        getMeasureCapacityTicks(timeSignature)
      );
      const m0: V2Measure = {
        id: `gp_t${tIdx}_m_${mIdx}`,
        index: mIdx,
        beats:
          v0Beats.length > 0
            ? v0Beats
            : [
                buildRestBeat(
                  `gp_t${tIdx}_m_${mIdx}_r0`,
                  fallbackCap.baseDuration,
                  fallbackCap.dotted,
                  fallbackCap.durationTicks
                ),
              ],
      };
      if (repeatStart) m0.repeatStart = true;
      if (repeatEnd) m0.repeatEnd = true;
      if (ending) m0.ending = ending;
      voice0Measures.push(m0);

      if (barVoiceIds[1]) {
        const v1Beats = convertVoiceBar(barVoiceIds[1], 1);
        if (v1Beats.length > 0) {
          hasVoice1Notes = true;
        }
        voice1Measures.push({
          id: `gp_t${tIdx}_v1_m_${mIdx}`,
          index: mIdx,
          beats: v1Beats,
        });
      } else {
        voice1Measures.push({
          id: `gp_t${tIdx}_v1_m_${mIdx}`,
          index: mIdx,
          beats: [],
        });
      }
    }

    const voices: Voice[] = [
      {
        id: `gp_t${tIdx}_v0`,
        index: 0,
        measures: padMeasuresToCount(
          voice0Measures,
          masterBars.length,
          timeSignature,
          `gp_t${tIdx}`
        ),
      },
    ];
    if (hasVoice1Notes) {
      voices.push({
        id: `gp_t${tIdx}_v1`,
        index: 1,
        measures: voice1Measures,
      });
    }

    tracks.push({
      id: `gp_track_${tIdx + 1}`,
      name: trName,
      instrumentId,
      clef: instrumentId === 'bass' ? 'bass' : 'treble',
      enabledViews: instrumentId === 'piano' ? ['staff', 'jianpu'] : ['staff', 'tab'],
      tuning: normalizedTuning,
      ...(capo > 0 ? { capo } : {}),
      voices,
    });
  }

  const doc: ScoreDocumentV2 = {
    schemaVersion: 2,
    id: options?.id ?? `gp_${Math.trunc(options?.nowMs ?? Date.now())}`,
    title: rawTitle,
    ...(subtitle ? { subtitle } : {}),
    ...(composer ? { composer } : {}),
    ...(lyricist ? { lyricist } : {}),
    keySignature,
    timeSignature,
    bpm,
    viewMode: 'dual',
    tracks,
    updatedAtEpochMs: Math.trunc(options?.nowMs ?? Date.now()),
  };

  return validateScoreDocumentV2(doc);
}

/* -------------------------------------------------------------------------- */
/*  GP5 二进制解析器（FICHIER GUITAR PRO v5.xx）                              */
/* -------------------------------------------------------------------------- */

class Gp5Reader {
  private pos = 0;
  private readonly bytes: Uint8Array;
  private readonly dv: DataView;
  private readonly utf8 = new TextDecoder('utf-8');

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private ensure(need: number): void {
    if (this.pos + need > this.bytes.byteLength) {
      throw new Error('GP5_TRUNCATED');
    }
  }

  public skip(n: number): void {
    this.ensure(n);
    this.pos += n;
  }

  public readU8(): number {
    this.ensure(1);
    const v = this.bytes[this.pos]!;
    this.pos += 1;
    return v;
  }

  public readI8(): number {
    this.ensure(1);
    const v = this.dv.getInt8(this.pos);
    this.pos += 1;
    return v;
  }

  public readBool(): boolean {
    return this.readU8() !== 0;
  }

  public readI32(): number {
    this.ensure(4);
    const v = this.dv.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  public readU32(): number {
    this.ensure(4);
    const v = this.dv.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  public readHeaderString(fixedSize: number): string {
    this.ensure(1 + fixedSize);
    const len = Math.min(fixedSize, this.readU8());
    const str = this.utf8.decode(this.bytes.subarray(this.pos, this.pos + len));
    this.pos += fixedSize;
    return str;
  }

  public readByteSizeString(len: number): string {
    this.ensure(len);
    const str = this.utf8.decode(this.bytes.subarray(this.pos, this.pos + len));
    this.pos += len;
    return str;
  }

  public readIntByteSizeString(): string {
    const totalLen = this.readI32();
    if (totalLen <= 0 || totalLen > 1024 * 1024) {
      if (totalLen === 0) return '';
      throw new Error('GP5_BAD_STRING');
    }
    this.ensure(totalLen);
    const strLen = Math.min(totalLen - 1, this.readU8());
    const str = this.utf8.decode(this.bytes.subarray(this.pos, this.pos + strLen));
    this.pos += totalLen - 1;
    return str;
  }

  public readIntSizeString(): string {
    const len = this.readI32();
    if (len < 0 || len > 1024 * 1024) {
      throw new Error('GP5_BAD_STRING');
    }
    if (len === 0) return '';
    return this.readByteSizeString(len);
  }
}

function gp5DurationToBase(durByte: number): BaseDuration {
  // GP5 duration: -2=whole, -1=half, 0=quarter, 1=eighth, 2=16th, 3=32nd, 4=64th
  if (durByte <= -2) return 'whole';
  if (durByte === -1) return 'half';
  if (durByte === 0) return 'quarter';
  if (durByte === 1) return 'eighth';
  return 'sixteenth';
}

function parseGp5BinaryToScoreV2(
  bytes: Uint8Array,
  options?: GuitarProImportOptions
): Result<ScoreDocumentV2> {
  try {
    const r = new Gp5Reader(bytes);
    const versionStr = r.readHeaderString(30);
    const isGp510 = versionStr.includes('5.10');

    // Score metadata (9 int-byte-size strings in GP5)
    const rawTitle = r.readIntByteSizeString().trim() || options?.title?.trim() || '导入 GP5 曲谱';
    const subtitle = r.readIntByteSizeString().trim();
    const artist = r.readIntByteSizeString().trim();
    r.readIntByteSizeString(); // album
    const lyricist = r.readIntByteSizeString().trim();
    const composer = r.readIntByteSizeString().trim() || artist;
    r.readIntByteSizeString(); // copyright
    r.readIntByteSizeString(); // tabAuthor
    r.readIntByteSizeString(); // instructions

    const noticeLines = r.readI32();
    if (noticeLines < 0 || noticeLines > 1000) {
      return gpFail('GP5 曲谱注释块长度异常，文件可能已损坏');
    }
    for (let i = 0; i < noticeLines; i += 1) {
      r.readIntByteSizeString();
    }

    // Triplet feel (1 byte)
    r.readBool();

    // Lyrics block (track index + 5 pairs of (startMeasure, text))
    r.readI32();
    for (let i = 0; i < 5; i += 1) {
      r.readI32();
      r.readIntSizeString();
    }

    // RSE Master Effect (GP5.10 only: 19 bytes)
    if (isGp510) {
      r.skip(19);
    }

    // Page setup (7 ints + 10 header/footer strings)
    r.skip(7 * 4);
    r.readI32(); // page flags
    for (let i = 0; i < 10; i += 1) {
      r.readIntByteSizeString();
    }

    // Tempo + optional tempo name (GP5.10)
    const rawTempo = r.readI32();
    const bpm = Math.max(40, Math.min(200, Math.round(rawTempo || 100)));
    if (isGp510) {
      r.readIntByteSizeString();
    }

    // Key signature (signed int8) + 3 padding bytes + octave (1 int32)
    const rawKey = r.readI8();
    r.skip(3);
    r.readI32(); // octave
    const keySignature = mapAccidentalCountToKey(rawKey);
    const preferFlat = FLAT_KEY_SET.has(keySignature);

    // 64 MIDI channels (each 12 bytes: instrument(4), volume..balance(6), padding(2))
    r.skip(64 * 12);

    // Directions (19 x int16 = 38 bytes) + master reverb (4 bytes)
    r.skip(38 + 4);

    const measureCount = r.readI32();
    const trackCount = r.readI32();
    if (
      measureCount <= 0 ||
      measureCount > 2000 ||
      trackCount <= 0 ||
      trackCount > 64
    ) {
      return gpFail('GP5 小节或音轨数量越界，文件可能已损坏');
    }

    interface Gp5MeasureHeader {
      numerator: number;
      denominator: number;
      repeatStart: boolean;
      repeatEnd: boolean;
      ending?: 1 | 2;
      doubleBar: boolean;
    }

    const measureHeaders: Gp5MeasureHeader[] = [];
    let lastNum = 4;
    let lastDen = 4;
    for (let m = 0; m < measureCount; m += 1) {
      if (m > 0) {
        r.skip(1); // GP5 measure placeholder byte
      }
      const flags = r.readU8();
      let numerator = lastNum;
      let denominator = lastDen;
      if ((flags & 0x01) !== 0) numerator = r.readI8();
      if ((flags & 0x02) !== 0) denominator = r.readI8();
      lastNum = numerator;
      lastDen = denominator;

      const repeatStart = (flags & 0x04) !== 0;
      let repeatEnd = false;
      if ((flags & 0x08) !== 0) {
        r.readI8(); // repeat count
        repeatEnd = true;
      }
      if ((flags & 0x40) !== 0) {
        r.readI8(); // key sig change
        r.readI8(); // minor
      }
      let ending: 1 | 2 | undefined;
      if ((flags & 0x10) !== 0) {
        const altMask = r.readU8();
        if ((altMask & 0x01) !== 0) ending = 1;
        else if ((altMask & 0x02) !== 0) ending = 2;
      }
      if ((flags & 0x20) !== 0) {
        r.readIntByteSizeString(); // marker name
        r.skip(4); // color
      }
      const doubleBar = (flags & 0x80) !== 0;
      if ((flags & 0x01) !== 0 || (flags & 0x02) !== 0) {
        r.skip(4); // beam 8th notes
      }
      if ((flags & 0x10) === 0) {
        r.skip(1);
      }
      r.skip(1); // triplet feel
      measureHeaders.push({
        numerator,
        denominator,
        repeatStart,
        repeatEnd,
        ending,
        doubleBar,
      });
    }

    const firstHeader = measureHeaders[0]!;
    const timeSignature = normalizeTimeSignature(
      `${firstHeader.numerator}/${firstHeader.denominator}`
    );

    interface Gp5TrackMeta {
      name: string;
      stringCount: number;
      tuningsHighToLow: number[];
      capo: number;
      instrumentId: InstrumentId;
    }

    const trackMetas: Gp5TrackMeta[] = [];
    for (let t = 0; t < trackCount; t += 1) {
      if (t === 0 || !isGp510) {
        r.skip(1);
      }
      r.readU8(); // track flags1
      const name = r.readHeaderString(40).trim() || `轨道 ${t + 1}`;
      const stringCount = Math.max(1, Math.min(7, r.readI32()));
      const rawTunings: number[] = [];
      for (let s = 0; s < 7; s += 1) {
        const pitch = r.readI32();
        if (s < stringCount) {
          rawTunings.push(pitch);
        }
      }
      r.readI32(); // midi port
      r.readI32(); // channel
      r.readI32(); // effect channel
      r.readI32(); // fret count
      const capo = Math.max(0, Math.min(12, r.readI32()));
      r.readI32(); // color
      // GP5 track display/RSE properties (49 bytes in GP5.00, 58+ bytes in GP5.10)
      r.skip(isGp510 ? 58 : 49);
      if (isGp510) {
        r.readIntByteSizeString();
        r.readIntByteSizeString();
      }

      const instrumentId = inferInstrumentId(name, stringCount);
      trackMetas.push({
        name,
        stringCount,
        tuningsHighToLow: rawTunings,
        capo,
        instrumentId,
      });
    }

    r.skip(2); // GP5 post-track padding

    const trackVoice0Measures: V2Measure[][] = trackMetas.map(() => []);

    for (let m = 0; m < measureCount; m += 1) {
      const mh = measureHeaders[m]!;
      for (let t = 0; t < trackCount; t += 1) {
        const tMeta = trackMetas[t]!;
        const collectedBeats: Beat[] = [];

        // GP5 stores 2 voices per measure/track
        for (let v = 0; v < 2; v += 1) {
          const beatCount = r.readI32();
          if (beatCount < 0 || beatCount > 512) {
            return gpFail('GP5 节拍数量异常，文件可能已损坏');
          }

          for (let b = 0; b < beatCount; b += 1) {
            const bFlags = r.readU8();
            const dotted = (bFlags & 0x01) !== 0;
            let isRest = false;
            if ((bFlags & 0x40) !== 0) {
              const status = r.readU8();
              isRest = status === 0 || status === 2;
            }
            const durByte = r.readI8();
            const baseDuration = gp5DurationToBase(durByte);
            const durTicks = quantizeTicksToDuration(
              baseDuration === 'whole'
                ? 1920
                : baseDuration === 'half'
                  ? dotted
                    ? 1440
                    : 960
                  : baseDuration === 'quarter'
                    ? dotted
                      ? 720
                      : 480
                    : baseDuration === 'eighth'
                      ? dotted
                        ? 360
                        : 240
                      : dotted
                        ? 180
                        : 120
            );

            if ((bFlags & 0x20) !== 0) {
              r.readI32(); // tuplet N
            }
            if ((bFlags & 0x02) !== 0) {
              // Chord diagram (simplified GP5 skip: header + name + etc.)
              r.skip(17);
              r.readHeaderString(21);
              r.skip(4);
              r.skip(4 * 7);
              r.skip(32);
            }
            let lyric: string | undefined;
            if ((bFlags & 0x04) !== 0) {
              lyric = r.readIntByteSizeString().trim() || undefined;
            }
            if ((bFlags & 0x08) !== 0) {
              // Beat effects
              const fx1 = r.readU8();
              const fx2 = r.readU8();
              if ((fx1 & 0x20) !== 0) r.skip(1); // slap/pop
              if ((fx2 & 0x04) !== 0) {
                // tremolo bar
                r.skip(1);
                r.readI32();
                const pts = r.readI32();
                r.skip(pts * 9);
              }
              if ((fx1 & 0x40) !== 0) r.skip(2); // stroke
              if ((fx2 & 0x02) !== 0) r.skip(1); // pickstroke
            }
            if ((bFlags & 0x10) !== 0) {
              // MixTableChange
              r.readI8();
              r.skip(16);
              r.readI8();
              r.readI8();
              r.readI8();
              r.readI8();
              r.readI8();
              r.readI8();
              r.readI32();
              r.skip(7);
              if (isGp510) {
                r.skip(1);
                r.readIntByteSizeString();
                r.readIntByteSizeString();
              }
            }

            const stringMask = r.readU8();
            const pitchNodes: PitchNode[] = [];
            let anyTie = false;
            const beatId = `gp5_t${t}_m${m}_b${b}`;

            for (let sBit = 6; sBit >= 0; sBit -= 1) {
              if ((stringMask & (1 << sBit)) === 0) {
                continue;
              }
              const stringIndex = 6 - sBit;
              const nFlags = r.readU8();
              let isTieNote = false;
              if ((nFlags & 0x20) !== 0) {
                const noteType = r.readU8();
                if (noteType === 2) {
                  isTieNote = true;
                  anyTie = true;
                }
              }
              if ((nFlags & 0x10) !== 0) {
                r.readI8(); // dynamic
              }
              let fret = 0;
              if ((nFlags & 0x20) !== 0) {
                fret = Math.max(0, Math.min(24, r.readI8()));
              }
              if ((nFlags & 0x80) !== 0) {
                r.skip(2); // fingering
              }
              if ((nFlags & 0x02) !== 0) {
                r.skip(8); // duration percent
              }
              r.skip(1); // flags2

              const techs: GuitarTechnique[] = [];
              if ((nFlags & 0x40) !== 0) {
                techs.push('vibrato');
              }
              if ((nFlags & 0x08) !== 0) {
                const nFx1 = r.readU8();
                const nFx2 = r.readU8();
                if ((nFx1 & 0x01) !== 0) {
                  techs.push('bend');
                  r.skip(1);
                  r.readI32();
                  const pts = r.readI32();
                  r.skip(pts * 9);
                }
                if ((nFx1 & 0x10) !== 0) {
                  // grace note
                  r.skip(5);
                }
                if ((nFx2 & 0x04) !== 0) {
                  r.skip(1); // tremolo picking
                }
                if ((nFx2 & 0x08) !== 0) {
                  techs.push('slide');
                  r.skip(1);
                }
                if ((nFx2 & 0x10) !== 0) {
                  r.skip(1); // harmonic
                }
                if ((nFx2 & 0x20) !== 0) {
                  r.skip(5); // trill
                }
                if ((nFx1 & 0x02) !== 0) {
                  techs.push('hammer');
                }
                if ((nFx2 & 0x40) !== 0) {
                  techs.push('vibrato');
                }
                if ((nFx2 & 0x02) !== 0) {
                  techs.push('palm-mute');
                }
              }

              const openMidi =
                tMeta.tuningsHighToLow[
                  Math.max(0, Math.min(tMeta.tuningsHighToLow.length - 1, stringIndex))
                ] ?? 64;
              const midiPitch = openMidi + fret + tMeta.capo;
              const pn = mapMidiToPitchNode(
                midiPitch,
                keySignature,
                `${beatId}_p${pitchNodes.length}`,
                preferFlat
              );
              pn.guitar = {
                string: Math.max(1, Math.min(tMeta.stringCount, stringIndex + 1)),
                fret,
                ...(techs.length > 0
                  ? { techniques: normalizeGuitarTechniques(techs) }
                  : {}),
              };
              if (!isTieNote || pitchNodes.length === 0) {
                pitchNodes.push(pn);
              }
            }

            r.skip(2); // GP5 beat flags2 (int16)

            if (v === 0) {
              if (isRest || pitchNodes.length === 0) {
                collectedBeats.push(
                  buildRestBeat(
                    beatId,
                    durTicks.baseDuration,
                    durTicks.dotted,
                    durTicks.durationTicks
                  )
                );
              } else {
                const beat: Beat = {
                  id: beatId,
                  isRest: false,
                  baseDuration: durTicks.baseDuration,
                  dotted: durTicks.dotted,
                  durationTicks: durTicks.durationTicks,
                  notes: pitchNodes,
                };
                if (lyric) beat.lyric = lyric;
                if (anyTie) beat.tieEnd = true;
                collectedBeats.push(beat);
              }
            }
          }
        }

        r.skip(1); // GP5 line break byte

        const capSpec = quantizeTicksToDuration(
          getMeasureCapacityTicks(timeSignature)
        );
        const measure: V2Measure = {
          id: `gp5_t${t}_m_${m}`,
          index: m,
          beats:
            collectedBeats.length > 0
              ? collectedBeats
              : [
                  buildRestBeat(
                    `gp5_t${t}_m_${m}_r0`,
                    capSpec.baseDuration,
                    capSpec.dotted,
                    capSpec.durationTicks
                  ),
                ],
        };
        if (mh.repeatStart) measure.repeatStart = true;
        if (mh.repeatEnd) measure.repeatEnd = true;
        if (mh.ending) measure.ending = mh.ending;
        if (mh.doubleBar) measure.barline = 'double';
        trackVoice0Measures[t]!.push(measure);
      }
    }

    const tracks: Track[] = trackMetas.map((meta, idx) => ({
      id: `gp5_track_${idx + 1}`,
      name: meta.name,
      instrumentId: meta.instrumentId,
      clef: meta.instrumentId === 'bass' ? 'bass' : 'treble',
      enabledViews:
        meta.instrumentId === 'piano' ? ['staff', 'jianpu'] : ['staff', 'tab'],
      tuning:
        meta.tuningsHighToLow.length > 0
          ? [...meta.tuningsHighToLow]
          : [...STANDARD_GUITAR_TUNING],
      ...(meta.capo > 0 ? { capo: meta.capo } : {}),
      voices: [
        {
          id: `gp5_t${idx}_v0`,
          index: 0,
          measures: trackVoice0Measures[idx]!,
        },
      ],
    }));

    const doc: ScoreDocumentV2 = {
      schemaVersion: 2,
      id: options?.id ?? `gp5_${Math.trunc(options?.nowMs ?? Date.now())}`,
      title: rawTitle,
      ...(subtitle ? { subtitle } : {}),
      ...(composer ? { composer } : {}),
      ...(lyricist ? { lyricist } : {}),
      keySignature,
      timeSignature,
      bpm,
      viewMode: 'dual',
      tracks,
      updatedAtEpochMs: Math.trunc(options?.nowMs ?? Date.now()),
    };

    return validateScoreDocumentV2(doc);
  } catch {
    return gpFail('GP5 二进制乐谱结构损坏或版本不兼容，解析失败');
  }
}

/* -------------------------------------------------------------------------- */
/*  统一 Guitar Pro（.gp / .gp5 / .gpx）导入入口                               */
/* -------------------------------------------------------------------------- */

function findGpifBytes(files: Map<string, Uint8Array>): Uint8Array | null {
  for (const [name, data] of files.entries()) {
    const normalized = name.replaceAll('\\', '/').toLowerCase();
    if (normalized === 'score.gpif' || normalized.endsWith('/score.gpif')) {
      return data;
    }
  }
  return null;
}

export async function importGuitarProToScoreV2(
  bytes: Uint8Array,
  options?: GuitarProImportOptions
): Promise<Result<ScoreDocumentV2>> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 16) {
    return gpFail('Guitar Pro 文件数据过短或已损坏');
  }

  // 1. ZIP 封装（.gp / 新版 .gpx）
  if (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  ) {
    const zipRes = await unpackZip(bytes);
    if (!zipRes.ok) {
      return gpFail('Guitar Pro ZIP 压缩包已损坏，无法读取内部乐谱');
    }
    const gpifBytes = findGpifBytes(zipRes.value);
    if (!gpifBytes) {
      return gpFail('Guitar Pro 压缩包内缺少 score.gpif 乐谱文件');
    }
    const xmlText = new TextDecoder('utf-8').decode(gpifBytes);
    return parseGpifXmlToScoreV2(xmlText, options);
  }

  // 2. BCFZ 压缩 GPX 容器（GP6）
  if (
    bytes[0] === 0x42 &&
    bytes[1] === 0x43 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x5a
  ) {
    const decomp = decompressBcfz(bytes);
    if (!decomp.ok) {
      return decomp;
    }
    const fsRes = extractFilesFromBcfs(decomp.value);
    if (!fsRes.ok) {
      return fsRes;
    }
    const gpifBytes = findGpifBytes(fsRes.value);
    if (!gpifBytes) {
      return gpFail('GPX 容器内缺少 score.gpif 乐谱文件');
    }
    return parseGpifXmlToScoreV2(
      new TextDecoder('utf-8').decode(gpifBytes),
      options
    );
  }

  // 3. 未压缩 BCFS 容器
  if (
    bytes[0] === 0x42 &&
    bytes[1] === 0x43 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x53
  ) {
    const fsRes = extractFilesFromBcfs(bytes);
    if (!fsRes.ok) {
      return fsRes;
    }
    const gpifBytes = findGpifBytes(fsRes.value);
    if (!gpifBytes) {
      return gpFail('GPX 容器内缺少 score.gpif 乐谱文件');
    }
    return parseGpifXmlToScoreV2(
      new TextDecoder('utf-8').decode(gpifBytes),
      options
    );
  }

  // 4. 二进制 GP3/GP4/GP5 头部检查
  const headerLen = bytes[0]!;
  if (headerLen > 0 && headerLen <= 30 && headerLen + 1 <= bytes.byteLength) {
    const headerAscii = new TextDecoder('ascii').decode(
      bytes.subarray(1, 1 + headerLen)
    );
    if (headerAscii.startsWith('FICHIER GUITAR PRO v5.')) {
      return parseGp5BinaryToScoreV2(bytes, options);
    }
    if (headerAscii.startsWith('FICHIER GUITAR PRO')) {
      return gpFail(
        '暂不支持该旧版 Guitar Pro 格式，请先另存为 .gp、.gpx 或 .gp5 后导入'
      );
    }
  }

  // 5. 裸 GPIF XML 文本兜底
  const headText = new TextDecoder('utf-8')
    .decode(bytes.subarray(0, Math.min(256, bytes.byteLength)))
    .trimStart();
  if (headText.startsWith('<?xml') || headText.startsWith('<GPIF')) {
    return parseGpifXmlToScoreV2(new TextDecoder('utf-8').decode(bytes), options);
  }

  return gpFail('无法识别的 Guitar Pro 文件格式，文件可能已损坏或不受支持');
}
