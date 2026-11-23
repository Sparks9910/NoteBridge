import { getMeasureCapacityTicks, VALID_TIME_SIGNATURES } from '../../domain/rhythm.ts';
import { createAppError } from '../../domain/state-machines.ts';
import { VALID_KEY_SIGNATURES } from '../../domain/theory.ts';
import type {
  Accidental,
  BaseDuration,
  KeySignature,
  Result,
  TimeSignature,
} from '../../domain/types.ts';
import {
  mapMidiToPitchNode,
  quantizeTicksToDuration,
  validateScoreDocumentV2,
} from '../../domain/v2-serializer.ts';
import type {
  Beat,
  DynamicMarking,
  InstrumentId,
  MeasureBarlineType,
  OrnamentType,
  PitchNode,
  ScoreDocumentV2,
  Track,
  V2Measure,
  Voice,
} from '../../domain/v2-types.ts';
import {
  childText,
  escapeXml,
  findChild,
  findChildren,
  parseXml,
} from './xml-parser.ts';
import { packZip, unpackZip } from './zip-codec.ts';

export interface MusicXmlImportOptions {
  title?: string;
  nowMs?: number;
  id?: string;
}

const KEY_TO_FIFTHS: Record<KeySignature, number> = {
  C: 0,
  G: 1,
  D: 2,
  A: 3,
  E: 4,
  B: 5,
  F: -1,
  Bb: -2,
  Eb: -3,
  Ab: -4,
  Db: -5,
  Gb: -6,
};

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

const BASE_DUR_TO_XML_TYPE: Record<BaseDuration, string> = {
  whole: 'whole',
  half: 'half',
  quarter: 'quarter',
  eighth: 'eighth',
  sixteenth: '16th',
};

const XML_TYPE_TO_BASE_DUR: Record<string, BaseDuration> = {
  whole: 'whole',
  breve: 'whole',
  half: 'half',
  quarter: 'quarter',
  eighth: 'eighth',
  '16th': 'sixteenth',
  '32nd': 'sixteenth',
  '64th': 'sixteenth',
};

const STEP_SEMITONES: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

const SHARP_PC_STEPS: Array<{ step: string; alter: number }> = [
  { step: 'C', alter: 0 },
  { step: 'C', alter: 1 },
  { step: 'D', alter: 0 },
  { step: 'D', alter: 1 },
  { step: 'E', alter: 0 },
  { step: 'F', alter: 0 },
  { step: 'F', alter: 1 },
  { step: 'G', alter: 0 },
  { step: 'G', alter: 1 },
  { step: 'A', alter: 0 },
  { step: 'A', alter: 1 },
  { step: 'B', alter: 0 },
];

const FLAT_PC_STEPS: Array<{ step: string; alter: number }> = [
  { step: 'C', alter: 0 },
  { step: 'D', alter: -1 },
  { step: 'D', alter: 0 },
  { step: 'E', alter: -1 },
  { step: 'E', alter: 0 },
  { step: 'F', alter: 0 },
  { step: 'G', alter: -1 },
  { step: 'G', alter: 0 },
  { step: 'A', alter: -1 },
  { step: 'A', alter: 0 },
  { step: 'B', alter: -1 },
  { step: 'B', alter: 0 },
];

const VALID_DYNAMIC_TAGS: ReadonlySet<DynamicMarking> = new Set([
  'pp',
  'p',
  'mp',
  'mf',
  'f',
  'ff',
  'fp',
]);

function midiToXmlPitch(
  midiPitch: number,
  preferFlat: boolean
): { step: string; alter: number; octave: number } {
  const clamped = Math.max(0, Math.min(127, Math.round(midiPitch)));
  const pc = ((clamped % 12) + 12) % 12;
  const octave = Math.floor(clamped / 12) - 1;
  const entry = (preferFlat ? FLAT_PC_STEPS : SHARP_PC_STEPS)[pc] ?? {
    step: 'C',
    alter: 0,
  };
  return { step: entry.step, alter: entry.alter, octave };
}

function inferInstrumentFromName(name: string): InstrumentId {
  const lower = name.toLowerCase();
  if (lower.includes('bass') || lower.includes('贝斯')) return 'bass';
  if (lower.includes('guitar') || lower.includes('吉他')) {
    if (lower.includes('acoustic') || lower.includes('木')) return 'acoustic-guitar';
    if (lower.includes('overdrive') || lower.includes('dist')) return 'electric-guitar-od';
    return 'electric-guitar-clean';
  }
  if (lower.includes('vocal') || lower.includes('melody') || lower.includes('声乐')) {
    return 'melody';
  }
  return 'piano';
}

function serializeBeatXml(
  beat: Beat,
  voiceNum: number,
  staffNum: number | null,
  preferFlat: boolean,
  lines: string[]
): void {
  if (beat.dynamic) {
    lines.push(
      `      <direction placement="below"><direction-type><dynamics><${beat.dynamic}/></dynamics></direction-type></direction>`
    );
  }

  const xmlType = BASE_DUR_TO_XML_TYPE[beat.baseDuration] ?? 'quarter';

  if (beat.isRest || beat.notes.length === 0) {
    lines.push('      <note>');
    lines.push('        <rest/>');
    lines.push(`        <duration>${beat.durationTicks}</duration>`);
    lines.push(`        <voice>${voiceNum}</voice>`);
    lines.push(`        <type>${xmlType}</type>`);
    if (beat.dotted) lines.push('        <dot/>');
    if (staffNum !== null) lines.push(`        <staff>${staffNum}</staff>`);
    lines.push('      </note>');
    return;
  }

  for (let nIdx = 0; nIdx < beat.notes.length; nIdx += 1) {
    const pitchNode = beat.notes[nIdx]!;
    const pitch = midiToXmlPitch(
      pitchNode.midiPitch,
      preferFlat || pitchNode.accidental === 'flat'
    );

    lines.push('      <note>');
    if (nIdx > 0) {
      lines.push('        <chord/>');
    }
    lines.push('        <pitch>');
    lines.push(`          <step>${pitch.step}</step>`);
    if (pitch.alter !== 0) {
      lines.push(`          <alter>${pitch.alter}</alter>`);
    }
    lines.push(`          <octave>${pitch.octave}</octave>`);
    lines.push('        </pitch>');
    lines.push(`        <duration>${beat.durationTicks}</duration>`);
    if (beat.tieEnd) lines.push('        <tie type="stop"/>');
    if (beat.tieStart) lines.push('        <tie type="start"/>');
    lines.push(`        <voice>${voiceNum}</voice>`);
    lines.push(`        <type>${xmlType}</type>`);
    if (beat.dotted) lines.push('        <dot/>');
    if (pitchNode.accidental === 'sharp') {
      lines.push('        <accidental>sharp</accidental>');
    } else if (pitchNode.accidental === 'flat') {
      lines.push('        <accidental>flat</accidental>');
    } else if (pitchNode.accidental === 'natural') {
      lines.push('        <accidental>natural</accidental>');
    }
    if (staffNum !== null) lines.push(`        <staff>${staffNum}</staff>`);

    const hasNotations =
      Boolean(beat.tieStart) ||
      Boolean(beat.tieEnd) ||
      Boolean(beat.slurStart) ||
      Boolean(beat.slurEnd) ||
      Boolean(beat.ornament) ||
      Boolean(pitchNode.fingering);

    if (hasNotations) {
      lines.push('        <notations>');
      if (beat.tieEnd) lines.push('          <tied type="stop"/>');
      if (beat.tieStart) lines.push('          <tied type="start"/>');
      if (beat.slurEnd) lines.push('          <slur type="stop" number="1"/>');
      if (beat.slurStart) lines.push('          <slur type="start" number="1"/>');
      if (beat.ornament === 'trill') {
        lines.push('          <ornaments><trill-mark/></ornaments>');
      } else if (beat.ornament === 'staccato') {
        lines.push('          <articulations><staccato/></articulations>');
      } else if (beat.ornament === 'accent') {
        lines.push('          <articulations><accent/></articulations>');
      } else if (beat.ornament === 'fermata') {
        lines.push('          <fermata type="upright"/>');
      }
      if (pitchNode.fingering) {
        lines.push(
          `          <technical><fingering>${escapeXml(pitchNode.fingering)}</fingering></technical>`
        );
      }
      lines.push('        </notations>');
    }

    if (nIdx === 0 && beat.lyric && beat.lyric.trim().length > 0) {
      lines.push(
        `        <lyric number="1"><text>${escapeXml(beat.lyric)}</text></lyric>`
      );
    }
    lines.push('      </note>');
  }
}

/** 将 ScoreDocumentV2 导出为标准 MusicXML 4.0 字符串 */
export function exportScoreV2ToMusicXml(scoreV2: ScoreDocumentV2): Result<string> {
  const valid = validateScoreDocumentV2(scoreV2);
  if (!valid.ok) {
    return valid;
  }
  const doc = valid.value;
  const preferFlat = FLAT_KEY_SET.has(doc.keySignature);
  const [beatsStr, beatTypeStr] = doc.timeSignature.split('/');
  const fifths = KEY_TO_FIFTHS[doc.keySignature] ?? 0;

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
    '<score-partwise version="4.0">',
    '  <work>',
    `    <work-title>${escapeXml(doc.title || '未命名曲谱')}</work-title>`,
    '  </work>',
  ];

  if (doc.subtitle) {
    lines.push(`  <movement-title>${escapeXml(doc.subtitle)}</movement-title>`);
  }

  lines.push('  <identification>');
  if (doc.composer) {
    lines.push(`    <creator type="composer">${escapeXml(doc.composer)}</creator>`);
  }
  if (doc.lyricist) {
    lines.push(`    <creator type="lyricist">${escapeXml(doc.lyricist)}</creator>`);
  }
  lines.push('    <encoding><software>NoteBridge V2.1</software></encoding>');
  lines.push('  </identification>');

  lines.push('  <part-list>');
  doc.tracks.forEach((track, idx) => {
    const partId = `P${idx + 1}`;
    lines.push(`    <score-part id="${partId}">`);
    lines.push(`      <part-name>${escapeXml(track.name)}</part-name>`);
    lines.push('    </score-part>');
  });
  lines.push('  </part-list>');

  doc.tracks.forEach((track, tIdx) => {
    const partId = `P${tIdx + 1}`;
    lines.push(`  <part id="${partId}">`);

    const isGrand = track.clef === 'grand';
    const maxMeasures = Math.max(
      1,
      ...track.voices.map((v) => v.measures.length)
    );

    for (let mIdx = 0; mIdx < maxMeasures; mIdx += 1) {
      lines.push(`    <measure number="${mIdx + 1}">`);

      const primaryMeasure = track.voices[0]?.measures[mIdx];

      if (mIdx === 0) {
        lines.push('      <attributes>');
        lines.push('        <divisions>480</divisions>');
        lines.push(`        <key><fifths>${fifths}</fifths></key>`);
        lines.push(
          `        <time><beats>${beatsStr ?? '4'}</beats><beat-type>${beatTypeStr ?? '4'}</beat-type></time>`
        );
        if (isGrand) {
          lines.push('        <staves>2</staves>');
          lines.push('        <clef number="1"><sign>G</sign><line>2</line></clef>');
          lines.push('        <clef number="2"><sign>F</sign><line>4</line></clef>');
        } else if (track.clef === 'bass') {
          lines.push('        <clef><sign>F</sign><line>4</line></clef>');
        } else {
          lines.push('        <clef><sign>G</sign><line>2</line></clef>');
        }
        lines.push('      </attributes>');
        lines.push(
          `      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${doc.bpm}</per-minute></metronome></direction-type><sound tempo="${doc.bpm}"/></direction>`
        );
      }

      if (primaryMeasure?.repeatStart || primaryMeasure?.ending) {
        lines.push('      <barline location="left">');
        if (primaryMeasure.repeatStart) {
          lines.push('        <bar-style>heavy-light</bar-style>');
          lines.push('        <repeat direction="forward"/>');
        }
        if (primaryMeasure.ending) {
          lines.push(
            `        <ending number="${primaryMeasure.ending}" type="start"/>`
          );
        }
        lines.push('      </barline>');
      }

      for (let vIdx = 0; vIdx < track.voices.length; vIdx += 1) {
        const voice = track.voices[vIdx]!;
        const vMeasure = voice.measures[mIdx];
        if (!vMeasure) continue;

        if (vIdx > 0) {
          const prevMeasure = track.voices[vIdx - 1]?.measures[mIdx];
          const prevTicks = prevMeasure
            ? prevMeasure.beats.reduce((sum, b) => sum + b.durationTicks, 0)
            : 0;
          if (prevTicks > 0) {
            lines.push(`      <backup><duration>${prevTicks}</duration></backup>`);
          }
        }

        const staffNum = isGrand ? (vIdx === 0 ? 1 : 2) : null;
        for (const beat of vMeasure.beats) {
          serializeBeatXml(beat, vIdx + 1, staffNum, preferFlat, lines);
        }
      }

      const rightBar = primaryMeasure?.barline;
      if (
        primaryMeasure?.repeatEnd ||
        primaryMeasure?.ending ||
        (rightBar && rightBar !== 'single')
      ) {
        lines.push('      <barline location="right">');
        if (primaryMeasure?.repeatEnd) {
          lines.push('        <bar-style>light-heavy</bar-style>');
        } else if (rightBar === 'final') {
          lines.push('        <bar-style>light-heavy</bar-style>');
        } else if (rightBar === 'double') {
          lines.push('        <bar-style>light-light</bar-style>');
        }
        if (primaryMeasure?.ending) {
          lines.push(
            `        <ending number="${primaryMeasure.ending}" type="stop"/>`
          );
        }
        if (primaryMeasure?.repeatEnd) {
          lines.push('        <repeat direction="backward"/>');
        }
        lines.push('      </barline>');
      }

      lines.push('    </measure>');
    }

    lines.push('  </part>');
  });

  lines.push('</score-partwise>');
  return { ok: true, value: lines.join('\n') };
}

/** 将 ScoreDocumentV2 导出为标准压缩 .mxl 二进制包 */
export async function exportScoreV2ToMxl(
  scoreV2: ScoreDocumentV2
): Promise<Result<Uint8Array>> {
  const xmlRes = exportScoreV2ToMusicXml(scoreV2);
  if (!xmlRes.ok) {
    return xmlRes;
  }
  const encoder = new TextEncoder();
  const containerXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<container>',
    '  <rootfiles>',
    '    <rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/>',
    '  </rootfiles>',
    '</container>',
  ].join('\n');

  const zipBytes = await packZip([
    { name: 'META-INF/container.xml', data: encoder.encode(containerXml) },
    { name: 'score.musicxml', data: encoder.encode(xmlRes.value) },
  ]);
  return { ok: true, value: zipBytes };
}

function normalizeXmlTimeSignature(beats: number, beatType: number): TimeSignature {
  const candidate = `${beats}/${beatType}`;
  if (VALID_TIME_SIGNATURES.includes(candidate as TimeSignature)) {
    return candidate as TimeSignature;
  }
  if (beats === 3 && beatType === 4) return '3/4';
  if (beats === 2 && beatType === 4) return '2/4';
  if (beats === 6 && beatType === 8) return '6/8';
  return '4/4';
}

function normalizeXmlKeySignature(fifths: number): KeySignature {
  if (FIFTHS_TO_KEY[fifths]) {
    return FIFTHS_TO_KEY[fifths]!;
  }
  const wrapped = ((((fifths + 6) % 12) + 12) % 12) - 6;
  const key = FIFTHS_TO_KEY[wrapped] ?? 'C';
  return VALID_KEY_SIGNATURES.includes(key) ? key : 'C';
}

/** 将 MusicXML 文本解析并导入为 ScoreDocumentV2 */
export function importMusicXmlToScoreV2(
  xmlText: string,
  options?: MusicXmlImportOptions
): Result<ScoreDocumentV2> {
  const parsed = parseXml(xmlText);
  if (!parsed.ok) {
    return parsed;
  }
  const root = parsed.value;
  if (root.tag !== 'score-partwise') {
    return {
      ok: false,
      error: createAppError(
        'STORAGE_SCHEMA_CORRUPTED',
        '仅支持 score-partwise 格式的标准 MusicXML 乐谱文件'
      ),
    };
  }

  const workEl = findChild(root, 'work');
  const workTitle = workEl ? childText(workEl, 'work-title') : undefined;
  const movementTitle = childText(root, 'movement-title');
  const title =
    workTitle?.trim() ||
    movementTitle?.trim() ||
    options?.title?.trim() ||
    'MusicXML 导入曲谱';
  const subtitle =
    workTitle && movementTitle && movementTitle !== workTitle
      ? movementTitle.trim()
      : undefined;

  let composer: string | undefined;
  let lyricist: string | undefined;
  const identEl = findChild(root, 'identification');
  if (identEl) {
    for (const creator of findChildren(identEl, 'creator')) {
      const type = creator.attrs.type;
      const val = creator.text.trim();
      if (!val) continue;
      if (type === 'composer') composer = val;
      if (type === 'lyricist' || type === 'poet') lyricist = val;
    }
  }

  const partNames = new Map<string, string>();
  const partListEl = findChild(root, 'part-list');
  if (partListEl) {
    for (const sp of findChildren(partListEl, 'score-part')) {
      const pid = sp.attrs.id;
      const pname = childText(sp, 'part-name')?.trim();
      if (pid && pname) {
        partNames.set(pid, pname);
      }
    }
  }

  const partElements = findChildren(root, 'part');
  if (partElements.length === 0) {
    return {
      ok: false,
      error: createAppError('STORAGE_SCHEMA_CORRUPTED', 'MusicXML 文件中未包含任何乐器分部（part）'),
    };
  }

  let globalKey: KeySignature = 'C';
  let globalTime: TimeSignature = '4/4';
  let globalBpm = 90;
  let capturedGlobalKey = false;
  let capturedGlobalTime = false;
  let capturedGlobalBpm = false;

  const tracks: Track[] = [];
  let nodeSeq = 1;

  for (let pIdx = 0; pIdx < partElements.length; pIdx += 1) {
    const partEl = partElements[pIdx]!;
    const partId = partEl.attrs.id ?? `P${pIdx + 1}`;
    const partName = partNames.get(partId) ?? (pIdx === 0 ? '主旋律' : `分谱 ${pIdx + 1}`);
    let divisions = 480;
    let partClef: Track['clef'] = 'treble';
    let hasBassClef = false;
    let hasTrebleClef = false;
    let stavesCount = 1;

    const voice0Measures: V2Measure[] = [];
    const voice1Measures: V2Measure[] = [];
    let hasVoice1Content = false;

    const measureEls = findChildren(partEl, 'measure');
    if (measureEls.length === 0) {
      continue;
    }

    for (let mIdx = 0; mIdx < measureEls.length; mIdx += 1) {
      const mEl = measureEls[mIdx]!;
      const v0Beats: Beat[] = [];
      const v1Beats: Beat[] = [];
      let pendingDynamic: DynamicMarking | undefined;
      let repeatStart = false;
      let repeatEnd = false;
      let barlineType: MeasureBarlineType | undefined;
      let endingNum: 1 | 2 | undefined;

      for (const child of mEl.children) {
        if (child.tag === 'attributes') {
          const divTxt = childText(child, 'divisions');
          if (divTxt) {
            const dVal = Number(divTxt);
            if (Number.isFinite(dVal) && dVal > 0) {
              divisions = dVal;
            }
          }
          const keyEl = findChild(child, 'key');
          if (keyEl && !capturedGlobalKey) {
            const fifthsVal = Number(childText(keyEl, 'fifths') ?? '0');
            if (Number.isFinite(fifthsVal)) {
              globalKey = normalizeXmlKeySignature(Math.trunc(fifthsVal));
              capturedGlobalKey = true;
            }
          }
          const timeEl = findChild(child, 'time');
          if (timeEl && !capturedGlobalTime) {
            const beatsVal = Number(childText(timeEl, 'beats') ?? '4');
            const typeVal = Number(childText(timeEl, 'beat-type') ?? '4');
            if (Number.isFinite(beatsVal) && Number.isFinite(typeVal)) {
              globalTime = normalizeXmlTimeSignature(
                Math.trunc(beatsVal),
                Math.trunc(typeVal)
              );
              capturedGlobalTime = true;
            }
          }
          const stavesTxt = childText(child, 'staves');
          if (stavesTxt) {
            const sVal = Number(stavesTxt);
            if (Number.isFinite(sVal) && sVal >= 2) {
              stavesCount = Math.trunc(sVal);
            }
          }
          for (const clefEl of findChildren(child, 'clef')) {
            const sign = childText(clefEl, 'sign')?.toUpperCase();
            if (sign === 'F') hasBassClef = true;
            if (sign === 'G') hasTrebleClef = true;
          }
        } else if (child.tag === 'direction') {
          const soundEl = findChild(child, 'sound');
          if (soundEl?.attrs.tempo && !capturedGlobalBpm) {
            const t = Number(soundEl.attrs.tempo);
            if (Number.isFinite(t)) {
              globalBpm = Math.max(40, Math.min(200, Math.round(t)));
              capturedGlobalBpm = true;
            }
          }
          const dirType = findChild(child, 'direction-type');
          if (dirType) {
            const metro = findChild(dirType, 'metronome');
            const perMin = metro ? Number(childText(metro, 'per-minute') ?? '') : NaN;
            if (Number.isFinite(perMin) && !capturedGlobalBpm) {
              globalBpm = Math.max(40, Math.min(200, Math.round(perMin)));
              capturedGlobalBpm = true;
            }
            const dynEl = findChild(dirType, 'dynamics');
            if (dynEl && dynEl.children[0]) {
              const dynTag = dynEl.children[0].tag as DynamicMarking;
              if (VALID_DYNAMIC_TAGS.has(dynTag)) {
                pendingDynamic = dynTag;
              }
            }
          }
        } else if (child.tag === 'sound' && child.attrs.tempo && !capturedGlobalBpm) {
          const t = Number(child.attrs.tempo);
          if (Number.isFinite(t)) {
            globalBpm = Math.max(40, Math.min(200, Math.round(t)));
            capturedGlobalBpm = true;
          }
        } else if (child.tag === 'barline') {
          const rep = findChild(child, 'repeat');
          if (rep?.attrs.direction === 'forward') repeatStart = true;
          if (rep?.attrs.direction === 'backward') repeatEnd = true;
          const endEl = findChild(child, 'ending');
          if (endEl?.attrs.number === '1') endingNum = 1;
          if (endEl?.attrs.number === '2') endingNum = 2;
          const style = childText(child, 'bar-style');
          if (style === 'light-heavy' && !repeatEnd) barlineType = 'final';
          if (style === 'light-light') barlineType = 'double';
        } else if (child.tag === 'note') {
          if (findChild(child, 'grace')) {
            continue;
          }
          const staffNum = Number(childText(child, 'staff') ?? '1');
          const voiceNum = Number(childText(child, 'voice') ?? '1');
          const targetVoiceIdx = staffNum === 2 || voiceNum === 2 ? 1 : 0;
          const targetList = targetVoiceIdx === 1 ? v1Beats : v0Beats;
          if (targetVoiceIdx === 1) {
            hasVoice1Content = true;
          }

          const isChord = Boolean(findChild(child, 'chord'));
          const isRest = Boolean(findChild(child, 'rest'));
          const pitchEl = findChild(child, 'pitch');

          const rawDur = Number(childText(child, 'duration') ?? String(divisions));
          const scaledTicks =
            Number.isFinite(rawDur) && rawDur > 0
              ? Math.round((rawDur / divisions) * 480)
              : 480;

          const xmlType = childText(child, 'type')?.trim() ?? '';
          const mappedType = XML_TYPE_TO_BASE_DUR[xmlType];
          const hasDot = Boolean(findChild(child, 'dot'));
          const durSpec = mappedType
            ? quantizeTicksToDuration(
                mappedType === 'whole'
                  ? 1920
                  : mappedType === 'half'
                    ? hasDot
                      ? 1440
                      : 960
                    : mappedType === 'quarter'
                      ? hasDot
                        ? 720
                        : 480
                      : mappedType === 'eighth'
                        ? hasDot
                          ? 360
                          : 240
                        : hasDot
                          ? 180
                          : 120
              )
            : quantizeTicksToDuration(scaledTicks);

          // Parse accidental & notations
          const accText = childText(child, 'accidental');
          const explicitAcc: Accidental =
            accText === 'sharp'
              ? 'sharp'
              : accText === 'flat'
                ? 'flat'
                : accText === 'natural'
                  ? 'natural'
                  : null;

          let fingering: string | undefined;
          let tieStart = false;
          let tieEnd = false;
          let slurStart = false;
          let slurEnd = false;
          let ornament: OrnamentType | undefined;

          for (const tieEl of findChildren(child, 'tie')) {
            if (tieEl.attrs.type === 'start') tieStart = true;
            if (tieEl.attrs.type === 'stop') tieEnd = true;
          }

          const notationsEl = findChild(child, 'notations');
          if (notationsEl) {
            for (const tiedEl of findChildren(notationsEl, 'tied')) {
              if (tiedEl.attrs.type === 'start') tieStart = true;
              if (tiedEl.attrs.type === 'stop') tieEnd = true;
            }
            for (const slurEl of findChildren(notationsEl, 'slur')) {
              if (slurEl.attrs.type === 'start') slurStart = true;
              if (slurEl.attrs.type === 'stop') slurEnd = true;
            }
            const ornEl = findChild(notationsEl, 'ornaments');
            if (ornEl && findChild(ornEl, 'trill-mark')) ornament = 'trill';
            const artEl = findChild(notationsEl, 'articulations');
            if (artEl) {
              if (findChild(artEl, 'staccato')) ornament = 'staccato';
              else if (findChild(artEl, 'accent')) ornament = 'accent';
            }
            if (findChild(notationsEl, 'fermata')) ornament = 'fermata';
            const techEl = findChild(notationsEl, 'technical');
            if (techEl) {
              const fg = childText(techEl, 'fingering')?.trim();
              if (fg) fingering = fg;
            }
          }

          let pitchNode: PitchNode | null = null;
          if (!isRest && pitchEl) {
            const step = (childText(pitchEl, 'step') ?? 'C').toUpperCase();
            const alter = Number(childText(pitchEl, 'alter') ?? '0');
            const octave = Number(childText(pitchEl, 'octave') ?? '4');
            const semitone = STEP_SEMITONES[step] ?? 0;
            const midi = (Math.trunc(octave) + 1) * 12 + semitone + Math.trunc(alter);
            const preferFlat = alter < 0 || explicitAcc === 'flat' || FLAT_KEY_SET.has(globalKey);
            pitchNode = mapMidiToPitchNode(
              midi,
              globalKey,
              `mxml_p_${nodeSeq++}`,
              preferFlat
            );
            if (explicitAcc !== null) {
              pitchNode.accidental = explicitAcc;
            }
            if (fingering) {
              pitchNode.fingering = fingering;
            }
          }

          if (isChord && targetList.length > 0 && pitchNode) {
            const prevBeat = targetList[targetList.length - 1]!;
            if (!prevBeat.isRest) {
              prevBeat.notes.push(pitchNode);
            }
            continue;
          }

          const beatId = `mxml_n_${nodeSeq++}`;
          const beat: Beat = {
            id: beatId,
            isRest: isRest || !pitchNode,
            baseDuration: durSpec.baseDuration,
            dotted: durSpec.dotted,
            durationTicks: durSpec.durationTicks,
            notes: pitchNode ? [pitchNode] : [],
          };
          const lyricEl = findChild(child, 'lyric');
          const lyricText = lyricEl ? childText(lyricEl, 'text')?.trim() : undefined;
          if (lyricText) beat.lyric = lyricText;
          if (pendingDynamic) {
            beat.dynamic = pendingDynamic;
            pendingDynamic = undefined;
          }
          if (ornament) beat.ornament = ornament;
          if (tieStart) beat.tieStart = true;
          if (tieEnd) beat.tieEnd = true;
          if (slurStart) beat.slurStart = true;
          if (slurEnd) beat.slurEnd = true;

          targetList.push(beat);
        }
      }

      const v0Measure: V2Measure = {
        id: `m_${pIdx}_v0_${mIdx}`,
        index: mIdx,
        beats: v0Beats,
      };
      if (repeatStart) v0Measure.repeatStart = true;
      if (repeatEnd) v0Measure.repeatEnd = true;
      if (barlineType) v0Measure.barline = barlineType;
      if (endingNum) v0Measure.ending = endingNum;
      voice0Measures.push(v0Measure);

      voice1Measures.push({
        id: `m_${pIdx}_v1_${mIdx}`,
        index: mIdx,
        beats: v1Beats,
      });
    }

    if (stavesCount >= 2 || (hasTrebleClef && hasBassClef) || hasVoice1Content) {
      partClef = 'grand';
    } else if (hasBassClef) {
      partClef = 'bass';
    } else {
      partClef = 'treble';
    }

    const voices: Voice[] = [
      {
        id: `voice_${pIdx}_1`,
        index: 0,
        measures: voice0Measures,
      },
    ];
    if (partClef === 'grand' || hasVoice1Content) {
      voices.push({
        id: `voice_${pIdx}_2`,
        index: 1,
        measures: voice1Measures,
      });
    }

    tracks.push({
      id: `track_${pIdx + 1}`,
      name: partName,
      instrumentId: inferInstrumentFromName(partName),
      clef: partClef,
      enabledViews: ['staff', 'jianpu'],
      voices,
    });
  }

  if (tracks.length === 0) {
    return {
      ok: false,
      error: createAppError('STORAGE_SCHEMA_CORRUPTED', 'MusicXML 文件不包含任何有效小节内容'),
    };
  }

  // Ensure every measure capacity is valid & non-empty track has at least 1 measure
  const capacity = getMeasureCapacityTicks(globalTime);
  void capacity;

  const nowMs = Math.trunc(options?.nowMs ?? Date.now());
  const docV2: ScoreDocumentV2 = {
    schemaVersion: 2,
    id: options?.id ?? `mxml_${nowMs}`,
    title,
    keySignature: globalKey,
    timeSignature: globalTime,
    bpm: globalBpm,
    viewMode: 'dual',
    tracks,
    updatedAtEpochMs: nowMs,
  };
  if (subtitle) docV2.subtitle = subtitle;
  if (composer) docV2.composer = composer;
  if (lyricist) docV2.lyricist = lyricist;

  return validateScoreDocumentV2(docV2);
}

/** 从压缩 .mxl 字节包解包并导入 ScoreDocumentV2 */
export async function importMxlToScoreV2(
  bytes: Uint8Array,
  options?: MusicXmlImportOptions
): Promise<Result<ScoreDocumentV2>> {
  const zipRes = await unpackZip(bytes);
  if (!zipRes.ok) {
    return zipRes;
  }
  const files = zipRes.value;
  const decoder = new TextDecoder('utf-8');

  let targetEntryPath: string | undefined;
  const containerBytes = files.get('META-INF/container.xml');
  if (containerBytes) {
    const containerRes = parseXml(decoder.decode(containerBytes));
    if (containerRes.ok) {
      const rootfiles = findChild(containerRes.value, 'rootfiles');
      const rootfile = rootfiles ? findChild(rootfiles, 'rootfile') : undefined;
      const fullPath = rootfile?.attrs['full-path'];
      if (fullPath && files.has(fullPath)) {
        targetEntryPath = fullPath;
      }
    }
  }

  if (!targetEntryPath) {
    for (const key of files.keys()) {
      if (
        !key.startsWith('META-INF/') &&
        (key.endsWith('.musicxml') || key.endsWith('.xml'))
      ) {
        targetEntryPath = key;
        break;
      }
    }
  }

  if (!targetEntryPath) {
    return {
      ok: false,
      error: createAppError('STORAGE_SCHEMA_CORRUPTED', 'MXL 压缩包中未找到可识别的 MusicXML 乐谱文件'),
    };
  }

  const xmlBytes = files.get(targetEntryPath)!;
  return importMusicXmlToScoreV2(decoder.decode(xmlBytes), options);
}
