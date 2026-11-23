import { getMeasureCapacityTicks, VALID_TIME_SIGNATURES } from '../../domain/rhythm.ts';
import { createAppError } from '../../domain/state-machines.ts';
import { VALID_KEY_SIGNATURES } from '../../domain/theory.ts';
import type { KeySignature, Result, TimeSignature } from '../../domain/types.ts';
import {
  mapMidiToPitchNode,
  quantizeTicksToDuration,
  validateScoreDocumentV2,
} from '../../domain/v2-serializer.ts';
import type {
  Beat,
  InstrumentId,
  PitchNode,
  ScoreDocumentV2,
  Track,
  V2Measure,
} from '../../domain/v2-types.ts';

export interface MidiImportOptions {
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
};

const INSTRUMENT_TO_GM_PROGRAM: Record<InstrumentId, number> = {
  piano: 0,
  'acoustic-guitar': 24,
  'electric-guitar-clean': 27,
  'electric-guitar-od': 29,
  bass: 33,
  melody: 73,
};

function writeVlq(value: number): number[] {
  let v = Math.max(0, Math.trunc(value));
  const bytes: number[] = [v & 0x7f];
  v >>>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return bytes;
}

function makeChunk(tag: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.byteLength);
  for (let i = 0; i < 4; i += 1) {
    out[i] = tag.charCodeAt(i);
  }
  const dv = new DataView(out.buffer);
  dv.setUint32(4, data.byteLength, false);
  out.set(data, 8);
  return out;
}

/** 将 ScoreDocumentV2 导出为标准 SMF Format 1 MIDI 二进制数组 */
export function exportScoreV2ToMidi(scoreV2: ScoreDocumentV2): Result<Uint8Array> {
  const valid = validateScoreDocumentV2(scoreV2);
  if (!valid.ok) {
    return valid;
  }
  const doc = valid.value;
  const ppq = 480;
  const encoder = new TextEncoder();

  const headerData = new Uint8Array(6);
  const hdv = new DataView(headerData.buffer);
  hdv.setUint16(0, 1, false); // Format 1
  hdv.setUint16(2, 1 + doc.tracks.length, false);
  hdv.setUint16(4, ppq, false);
  const chunks: Uint8Array[] = [makeChunk('MThd', headerData)];

  // Meta Track (Track 0)
  const metaEvents: number[] = [];
  const titleBytes = encoder.encode(doc.title || 'NoteBridge Score');
  metaEvents.push(0, 0xff, 0x03, ...writeVlq(titleBytes.length), ...titleBytes);

  const usPerQuarter = Math.round(60_000_000 / doc.bpm);
  metaEvents.push(
    0,
    0xff,
    0x51,
    0x03,
    (usPerQuarter >> 16) & 0xff,
    (usPerQuarter >> 8) & 0xff,
    usPerQuarter & 0xff
  );

  const [numStr, denStr] = doc.timeSignature.split('/');
  const num = Number(numStr) || 4;
  const den = Number(denStr) || 4;
  const denPow = Math.max(0, Math.round(Math.log2(den)));
  metaEvents.push(0, 0xff, 0x58, 0x04, num & 0xff, denPow & 0xff, 24, 8);

  const fifths = KEY_TO_FIFTHS[doc.keySignature] ?? 0;
  metaEvents.push(0, 0xff, 0x59, 0x02, fifths & 0xff, 0x00);
  metaEvents.push(0, 0xff, 0x2f, 0x00);
  chunks.push(makeChunk('MTrk', new Uint8Array(metaEvents)));

  // Instrument Tracks
  doc.tracks.forEach((track, tIdx) => {
    let channel = tIdx % 16;
    if (channel === 9) channel = 10;
    const program = INSTRUMENT_TO_GM_PROGRAM[track.instrumentId] ?? 0;

    const trackEvents: number[] = [];
    const nameBytes = encoder.encode(track.name);
    trackEvents.push(0, 0xff, 0x03, ...writeVlq(nameBytes.length), ...nameBytes);
    trackEvents.push(0, 0xc0 | channel, program & 0x7f);

    interface RawMidiEvent {
      tick: number;
      order: number;
      bytes: number[];
    }
    const rawEvents: RawMidiEvent[] = [];

    for (const voice of track.voices) {
      let tickCursor = 0;
      for (const measure of voice.measures) {
        for (const beat of measure.beats) {
          if (!beat.isRest) {
            for (const pitchNode of beat.notes) {
              const pitch = Math.max(0, Math.min(127, Math.round(pitchNode.midiPitch)));
              rawEvents.push({
                tick: tickCursor,
                order: 1,
                bytes: [0x90 | channel, pitch, 88],
              });
              rawEvents.push({
                tick: tickCursor + Math.max(1, beat.durationTicks),
                order: 0,
                bytes: [0x80 | channel, pitch, 0],
              });
            }
          }
          tickCursor += beat.durationTicks;
        }
      }
    }

    rawEvents.sort((a, b) => (a.tick !== b.tick ? a.tick - b.tick : a.order - b.order));

    let prevTick = 0;
    for (const ev of rawEvents) {
      const delta = Math.max(0, ev.tick - prevTick);
      prevTick = ev.tick;
      trackEvents.push(...writeVlq(delta), ...ev.bytes);
    }
    trackEvents.push(0, 0xff, 0x2f, 0x00);
    chunks.push(makeChunk('MTrk', new Uint8Array(trackEvents)));
  });

  const totalLen = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return { ok: true, value: out };
}

interface ParsedMidiNote {
  startTick: number;
  endTick: number;
  pitch: number;
}

/** 将标准 MIDI (.mid) 字节流解析并导入为 ScoreDocumentV2 */
export function importMidiToScoreV2(
  bytes: Uint8Array,
  options?: MidiImportOptions
): Result<ScoreDocumentV2> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 14) {
    return {
      ok: false,
      error: createAppError('STORAGE_SCHEMA_CORRUPTED', 'MIDI 文件数据过短或已损坏'),
    };
  }

  const decoder = new TextDecoder('utf-8');
  const headerTag = decoder.decode(bytes.subarray(0, 4));
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (headerTag !== 'MThd' || dv.getUint32(4, false) < 6) {
    return {
      ok: false,
      error: createAppError('STORAGE_SCHEMA_CORRUPTED', '无效的 MIDI 文件头签名（期望 MThd）'),
    };
  }

  const numTracks = dv.getUint16(10, false);
  const division = dv.getUint16(12, false);
  if (division <= 0 || (division & 0x8000) !== 0) {
    return {
      ok: false,
      error: createAppError('STORAGE_SCHEMA_CORRUPTED', '暂不支持 SMPTE 时间码格式的 MIDI 文件'),
    };
  }

  let offset = 8 + dv.getUint32(4, false);
  let bpm = 90;
  let capturedBpm = false;
  let keySignature: KeySignature = 'C';
  let capturedKey = false;
  let timeSignature: TimeSignature = '4/4';
  let capturedTime = false;
  let docTitle = '';

  const parsedTracks: Array<{ name: string; notes: ParsedMidiNote[] }> = [];

  for (let t = 0; t < numTracks && offset + 8 <= bytes.byteLength; t += 1) {
    const tag = decoder.decode(bytes.subarray(offset, offset + 4));
    const chunkLen = dv.getUint32(offset + 4, false);
    const trackStart = offset + 8;
    const trackEnd = Math.min(bytes.byteLength, trackStart + chunkLen);
    offset = trackEnd;

    if (tag !== 'MTrk') {
      continue;
    }

    let pos = trackStart;
    let absTick = 0;
    let runningStatus = 0;
    let trackName = '';
    const activeNotes = new Map<string, number>();
    const notes: ParsedMidiNote[] = [];

    const readVlq = (): number => {
      let value = 0;
      while (pos < trackEnd) {
        const b = bytes[pos++]!;
        value = (value << 7) | (b & 0x7f);
        if ((b & 0x80) === 0) break;
      }
      return value;
    };

    while (pos < trackEnd) {
      absTick += readVlq();
      if (pos >= trackEnd) break;

      let status = bytes[pos]!;
      if (status < 0x80) {
        if (runningStatus === 0) break;
        status = runningStatus;
      } else {
        pos += 1;
        if (status < 0xf0) {
          runningStatus = status;
        }
      }

      if (status === 0xff) {
        if (pos >= trackEnd) break;
        const metaType = bytes[pos++]!;
        const metaLen = readVlq();
        const metaEnd = Math.min(trackEnd, pos + metaLen);
        const metaBytes = bytes.subarray(pos, metaEnd);
        pos = metaEnd;

        if (metaType === 0x03 && !trackName) {
          const decodedName = decoder.decode(metaBytes).trim();
          if (decodedName) {
            trackName = decodedName;
            if (!docTitle && t === 0) docTitle = decodedName;
          }
        } else if (metaType === 0x51 && metaBytes.byteLength >= 3 && !capturedBpm) {
          const us = (metaBytes[0]! << 16) | (metaBytes[1]! << 8) | metaBytes[2]!;
          if (us > 0) {
            bpm = Math.max(40, Math.min(200, Math.round(60_000_000 / us)));
            capturedBpm = true;
          }
        } else if (metaType === 0x58 && metaBytes.byteLength >= 2 && !capturedTime) {
          const nn = metaBytes[0]!;
          const dd = Math.pow(2, metaBytes[1]!);
          const candidate = `${nn}/${dd}`;
          if (VALID_TIME_SIGNATURES.includes(candidate as TimeSignature)) {
            timeSignature = candidate as TimeSignature;
            capturedTime = true;
          }
        } else if (metaType === 0x59 && metaBytes.byteLength >= 2 && !capturedKey) {
          const rawSf = metaBytes[0]!;
          const sf = rawSf > 127 ? rawSf - 256 : rawSf;
          const mapped = FIFTHS_TO_KEY[sf];
          if (mapped && VALID_KEY_SIGNATURES.includes(mapped)) {
            keySignature = mapped;
            capturedKey = true;
          }
        } else if (metaType === 0x2f) {
          break;
        }
      } else if (status === 0xf0 || status === 0xf7) {
        const syxLen = readVlq();
        pos = Math.min(trackEnd, pos + syxLen);
      } else {
        const cmd = status & 0xf0;
        const ch = status & 0x0f;
        const data1 = pos < trackEnd ? bytes[pos++]! : 0;
        const data2 =
          cmd !== 0xc0 && cmd !== 0xd0 && pos < trackEnd ? bytes[pos++]! : 0;

        const key = `${ch}:${data1}`;
        const scaledTick = Math.round((absTick * 480) / division);

        if (cmd === 0x90 && data2 > 0) {
          if (!activeNotes.has(key)) {
            activeNotes.set(key, scaledTick);
          }
        } else if (cmd === 0x80 || (cmd === 0x90 && data2 === 0)) {
          const start = activeNotes.get(key);
          if (start !== undefined) {
            activeNotes.delete(key);
            notes.push({
              startTick: start,
              endTick: Math.max(start + 120, scaledTick),
              pitch: data1,
            });
          }
        }
      }
    }

    for (const [key, start] of activeNotes.entries()) {
      const pitch = Number(key.split(':')[1] ?? '60');
      notes.push({ startTick: start, endTick: start + 480, pitch });
    }

    if (notes.length > 0) {
      notes.sort((a, b) => a.startTick - b.startTick || b.pitch - a.pitch);
      parsedTracks.push({
        name: trackName || `MIDI 轨道 ${parsedTracks.length + 1}`,
        notes,
      });
    }
  }

  if (parsedTracks.length === 0) {
    return {
      ok: false,
      error: createAppError('STORAGE_SCHEMA_CORRUPTED', 'MIDI 文件中未包含有效的音符事件'),
    };
  }

  const measureCapacity = getMeasureCapacityTicks(timeSignature);
  let nodeSeq = 1;

  const tracks: Track[] = parsedTracks.map((pt, tIdx) => {
    // Group simultaneous notes within 60 ticks into chord beats
    const chordGroups: Array<{
      startTick: number;
      durationTicks: number;
      pitches: number[];
    }> = [];

    for (const note of pt.notes) {
      const lastGroup = chordGroups[chordGroups.length - 1];
      if (lastGroup && Math.abs(note.startTick - lastGroup.startTick) <= 60) {
        if (!lastGroup.pitches.includes(note.pitch)) {
          lastGroup.pitches.push(note.pitch);
        }
      } else {
        chordGroups.push({
          startTick: note.startTick,
          durationTicks: Math.max(120, note.endTick - note.startTick),
          pitches: [note.pitch],
        });
      }
    }

    const flatBeats: Beat[] = [];
    let tickCursor = 0;
    for (let i = 0; i < chordGroups.length; i += 1) {
      const grp = chordGroups[i]!;
      const gap = grp.startTick - tickCursor;
      if (gap >= 120) {
        const restSpec = quantizeTicksToDuration(gap);
        flatBeats.push({
          id: `mid_r_${nodeSeq++}`,
          isRest: true,
          baseDuration: restSpec.baseDuration,
          dotted: restSpec.dotted,
          durationTicks: restSpec.durationTicks,
          notes: [],
        });
        tickCursor += restSpec.durationTicks;
      }

      const nextGroup = chordGroups[i + 1];
      const maxSpan = nextGroup
        ? Math.max(120, nextGroup.startTick - grp.startTick)
        : grp.durationTicks;
      const targetDur = Math.min(grp.durationTicks, maxSpan);
      const durSpec = quantizeTicksToDuration(targetDur);

      const pitchNodes: PitchNode[] = grp.pitches.map((p) =>
        mapMidiToPitchNode(p, keySignature, `mid_p_${nodeSeq++}`)
      );

      flatBeats.push({
        id: `mid_n_${nodeSeq++}`,
        isRest: false,
        baseDuration: durSpec.baseDuration,
        dotted: durSpec.dotted,
        durationTicks: durSpec.durationTicks,
        notes: pitchNodes,
      });
      tickCursor = grp.startTick + durSpec.durationTicks;
    }

    // Partition flatBeats into measures
    const measures: V2Measure[] = [];
    let currentMeasureBeats: Beat[] = [];
    let currentTicks = 0;

    for (const beat of flatBeats) {
      if (
        currentMeasureBeats.length > 0 &&
        currentTicks + beat.durationTicks > measureCapacity
      ) {
        measures.push({
          id: `mid_m_${tIdx}_${measures.length}`,
          index: measures.length,
          beats: currentMeasureBeats,
        });
        currentMeasureBeats = [];
        currentTicks = 0;
      }
      currentMeasureBeats.push(beat);
      currentTicks += beat.durationTicks;
    }
    if (currentMeasureBeats.length > 0) {
      measures.push({
        id: `mid_m_${tIdx}_${measures.length}`,
        index: measures.length,
        beats: currentMeasureBeats,
      });
    }

    const avgPitch =
      pt.notes.reduce((sum, n) => sum + n.pitch, 0) / pt.notes.length;

    return {
      id: `track_${tIdx + 1}`,
      name: pt.name,
      instrumentId: 'piano',
      clef: avgPitch < 55 ? 'bass' : 'treble',
      enabledViews: ['staff', 'jianpu'],
      voices: [
        {
          id: `voice_${tIdx}_1`,
          index: 0,
          measures,
        },
      ],
    };
  });

  const nowMs = Math.trunc(options?.nowMs ?? Date.now());
  const docV2: ScoreDocumentV2 = {
    schemaVersion: 2,
    id: options?.id ?? `midi_${nowMs}`,
    title: docTitle || options?.title?.trim() || 'MIDI 导入曲谱',
    keySignature,
    timeSignature,
    bpm,
    viewMode: 'dual',
    tracks,
    updatedAtEpochMs: nowMs,
  };

  return validateScoreDocumentV2(docV2);
}
