import { describe, expect, it } from 'vitest';
import { resolveTrackAudibility } from '../../src/application/practice-store.ts';
import type { AppError } from '../../src/domain/types.ts';
import { normalizeGuitarTechniques } from '../../src/domain/v2-instruments.ts';
import { validateScoreDocumentV2 } from '../../src/domain/v2-serializer.ts';
import {
  analyzeTunerReading,
  buildTargetStringsFromTuning,
  detectPitchAutocorrelation,
} from '../../src/domain/v2-tuner.ts';
import { importGuitarProToScoreV2 } from '../../src/infrastructure/codecs/guitarpro-codec.ts';
import { packZip } from '../../src/infrastructure/codecs/zip-codec.ts';
import { generateSineWaveBuffer } from '../../src/infrastructure/tuner-adapter.ts';

function assertChineseAppError(err: AppError): void {
  expect(err.detail.trim().length).toBeGreaterThan(0);
  expect(/[\u4e00-\u9fa5]/.test(err.detail)).toBe(true);
  expect(err.detail).not.toMatch(/Error:|TypeError|SyntaxError|stack|\bat\s+\S+\s*\(/i);
}

const SAMPLE_GPIF_XML = `<?xml version="1.0" encoding="utf-8"?>
<GPIF>
  <Score>
    <Title>V2.3 摇滚双轨示例</Title>
    <SubTitle>Guitar Pro 测试</SubTitle>
    <Music>测试作曲</Music>
    <Words>测试作词</Words>
  </Score>
  <MasterTrack>
    <Automations>
      <Automation>
        <Type>Tempo</Type>
        <Value>128 2</Value>
      </Automation>
    </Automations>
  </MasterTrack>
  <Tracks>
    <Track id="0">
      <Name>Lead Guitar Overdrive</Name>
      <ShortName>Lead</ShortName>
      <Properties>
        <Property name="Tuning">
          <Pitches>40 45 50 55 59 64</Pitches>
        </Property>
        <Property name="CapoFret">
          <Fret>2</Fret>
        </Property>
      </Properties>
    </Track>
    <Track id="1">
      <Name>Electric Bass</Name>
      <ShortName>Bass</ShortName>
      <Properties>
        <Property name="Tuning">
          <Pitches>28 33 38 43</Pitches>
        </Property>
      </Properties>
    </Track>
  </Tracks>
  <MasterBars>
    <MasterBar>
      <Key><AccidentalCount>1</AccidentalCount></Key>
      <Time>4/4</Time>
      <Repeat start="true" />
      <Bars>0 1</Bars>
    </MasterBar>
  </MasterBars>
  <Bars>
    <Bar id="0"><Voices>0 -1</Voices></Bar>
    <Bar id="1"><Voices>1 -1</Voices></Bar>
  </Bars>
  <Voices>
    <Voice id="0"><Beats>0 1 2 3</Beats></Voice>
    <Voice id="1"><Beats>4 5</Beats></Voice>
  </Voices>
  <Beats>
    <Beat id="0"><Rhythm ref="q" /><Notes>0</Notes></Beat>
    <Beat id="1"><Rhythm ref="q" /><Notes>1</Notes></Beat>
    <Beat id="2"><Rhythm ref="q" /><Notes>2</Notes><PalmMute /></Beat>
    <Beat id="3"><Rhythm ref="q" /><Notes>3</Notes></Beat>
    <Beat id="4"><Rhythm ref="h" /><Notes>4</Notes></Beat>
    <Beat id="5"><Rhythm ref="h" /><Notes>5</Notes></Beat>
  </Beats>
  <Notes>
    <Note id="0">
      <Properties>
        <Property name="String"><String>4</String></Property>
        <Property name="Fret"><Fret>5</Fret></Property>
        <Property name="Bended"><Enable>true</Enable></Property>
      </Properties>
      <Vibrato>Slight</Vibrato>
    </Note>
    <Note id="1">
      <Properties>
        <Property name="String"><String>4</String></Property>
        <Property name="Fret"><Fret>7</Fret></Property>
        <Property name="Slide"><Flags>1</Flags></Property>
        <Property name="HopoOrigin" />
      </Properties>
    </Note>
    <Note id="2">
      <Properties>
        <Property name="String"><String>3</String></Property>
        <Property name="Fret"><Fret>5</Fret></Property>
        <Property name="HopoDestination" />
      </Properties>
    </Note>
    <Note id="3">
      <Properties>
        <Property name="String"><String>5</String></Property>
        <Property name="Fret"><Fret>3</Fret></Property>
      </Properties>
    </Note>
    <Note id="4">
      <Properties>
        <Property name="String"><String>0</String></Property>
        <Property name="Fret"><Fret>3</Fret></Property>
      </Properties>
    </Note>
    <Note id="5">
      <Properties>
        <Property name="String"><String>1</String></Property>
        <Property name="Fret"><Fret>0</Fret></Property>
      </Properties>
    </Note>
  </Notes>
  <Rhythms>
    <Rhythm id="q"><NoteValue>Quarter</NoteValue></Rhythm>
    <Rhythm id="h"><NoteValue>Half</NoteValue></Rhythm>
  </Rhythms>
</GPIF>`;

function buildBcfzFromBcfs(bcfsBytes: Uint8Array): Uint8Array {
  // Encode uncompressed BCFS using BCFZ flag=0 chunks (max 3 bytes per chunk)
  const bits: number[] = [];
  const pushBits = (val: number, len: number, reversed = false) => {
    for (let i = 0; i < len; i += 1) {
      const bit = reversed ? (val >> i) & 1 : (val >> (len - 1 - i)) & 1;
      bits.push(bit);
    }
  };

  let pos = 0;
  while (pos < bcfsBytes.length) {
    const chunkLen = Math.min(3, bcfsBytes.length - pos);
    pushBits(0, 1); // flag = 0 (raw literal)
    pushBits(chunkLen, 2, true);
    for (let i = 0; i < chunkLen; i += 1) {
      pushBits(bcfsBytes[pos + i]!, 8, false);
    }
    pos += chunkLen;
  }

  const dataByteLen = Math.ceil(bits.length / 8);
  const out = new Uint8Array(8 + dataByteLen);
  out[0] = 0x42; // B
  out[1] = 0x43; // C
  out[2] = 0x46; // F
  out[3] = 0x5a; // Z
  new DataView(out.buffer).setUint32(4, bcfsBytes.length, true);

  for (let i = 0; i < bits.length; i += 1) {
    if (bits[i] === 1) {
      out[8 + (i >> 3)]! |= 1 << (7 - (i & 7));
    }
  }
  return out;
}

function buildBcfsContainer(filename: string, fileBytes: Uint8Array): Uint8Array {
  const SECTOR = 0x1000;
  const dataSectors = Math.max(1, Math.ceil(fileBytes.length / SECTOR));
  const totalSectors = 2 + dataSectors;
  const buf = new Uint8Array(totalSectors * SECTOR);
  const dv = new DataView(buf.buffer);

  // Sector 0: BCFS magic
  buf[0] = 0x42;
  buf[1] = 0x43;
  buf[2] = 0x46;
  buf[3] = 0x53;

  // Sector 1: File entry (type = 2)
  const entryOff = SECTOR;
  dv.setInt32(entryOff, 2, true);
  const nameBytes = new TextEncoder().encode(filename);
  buf.set(nameBytes, entryOff + 4);
  dv.setUint32(entryOff + 0x8c, fileBytes.length, true);

  for (let s = 0; s < dataSectors; s += 1) {
    const sectorIdx = 2 + s;
    dv.setUint32(entryOff + 0x94 + s * 4, sectorIdx, true);
    const slice = fileBytes.subarray(s * SECTOR, (s + 1) * SECTOR);
    buf.set(slice, sectorIdx * SECTOR);
  }
  return buf;
}

function buildMinimalGp5Fixture(): Uint8Array {
  const buf: number[] = [];
  const pushU8 = (v: number) => buf.push(v & 0xff);
  const pushI8 = (v: number) => buf.push(v & 0xff);
  const pushZeros = (n: number) => {
    for (let i = 0; i < n; i += 1) buf.push(0);
  };
  const pushI32 = (v: number) => {
    const arr = new Uint8Array(4);
    new DataView(arr.buffer).setInt32(0, v, true);
    buf.push(...arr);
  };
  const pushHeaderStr = (s: string, fixed: number) => {
    const raw = new TextEncoder().encode(s);
    const len = Math.min(fixed, raw.length);
    pushU8(len);
    for (let i = 0; i < fixed; i += 1) {
      buf.push(i < len ? raw[i]! : 0);
    }
  };
  const pushIntByteStr = (s: string) => {
    const raw = new TextEncoder().encode(s);
    pushI32(raw.length + 1);
    pushU8(raw.length);
    buf.push(...raw);
  };
  const pushIntStr = (s: string) => {
    const raw = new TextEncoder().encode(s);
    pushI32(raw.length);
    buf.push(...raw);
  };

  pushHeaderStr('FICHIER GUITAR PRO v5.00', 30);
  pushIntByteStr('GP5 二进制示例');
  pushIntByteStr('副标题');
  pushIntByteStr('吉他手');
  pushIntByteStr('');
  pushIntByteStr('');
  pushIntByteStr('');
  pushIntByteStr('');
  pushIntByteStr('');
  pushIntByteStr('');
  pushI32(0); // notice lines
  pushU8(0); // triplet feel
  pushI32(0); // lyrics track
  for (let i = 0; i < 5; i += 1) {
    pushI32(1);
    pushIntStr('');
  }
  pushZeros(7 * 4 + 4); // page setup + flags
  for (let i = 0; i < 10; i += 1) {
    pushIntByteStr('');
  }
  pushI32(116); // BPM
  pushI8(0); // key sig C
  pushZeros(3);
  pushI32(0); // octave
  pushZeros(64 * 12); // MIDI channels
  pushZeros(38 + 4); // directions + reverb

  pushI32(1); // measureCount
  pushI32(2); // trackCount

  // Measure header 0: 4/4 + repeatStart
  pushU8(0x01 | 0x02 | 0x04);
  pushI8(4);
  pushI8(4);
  pushZeros(4); // beam 8th
  pushZeros(1); // alt ending byte
  pushZeros(1); // triplet feel

  // Track 0: Lead Guitar
  pushZeros(1);
  pushU8(0);
  pushHeaderStr('Lead Electric', 40);
  pushI32(6);
  [64, 59, 55, 50, 45, 40, 0].forEach(pushI32);
  pushI32(1);
  pushI32(1);
  pushI32(2);
  pushI32(24);
  pushI32(0); // capo
  pushI32(0);
  pushZeros(49);

  // Track 1: Bass
  pushZeros(1);
  pushU8(0);
  pushHeaderStr('Bass Track', 40);
  pushI32(4);
  [43, 38, 33, 28, 0, 0, 0].forEach(pushI32);
  pushI32(1);
  pushI32(3);
  pushI32(4);
  pushI32(24);
  pushI32(0);
  pushI32(0);
  pushZeros(49);

  pushZeros(2); // post-track padding

  // Measure 0 Track 0: Voice 0 (1 beat with bend + vibrato), Voice 1 (0 beats)
  pushI32(1);
  pushU8(0); // bFlags
  pushI8(0); // quarter
  pushU8(1 << 6); // string 1 (highest bit 6)
  pushU8(0x20 | 0x40 | 0x08); // nFlags: type+fret, vibrato, noteEffects
  pushU8(1); // normal note
  pushI8(12); // fret 12
  pushU8(0); // flags2
  pushU8(0x01 | 0x02); // nFx1: bend + hammer
  pushU8(0x08 | 0x02); // nFx2: slide + palm-mute
  pushZeros(1 + 4 + 4); // bend header (0 pts)
  pushZeros(1); // slide byte
  pushZeros(2); // beat flags2
  pushI32(0); // voice 1 empty
  pushU8(0); // line break

  // Measure 0 Track 1: Voice 0 (1 beat), Voice 1 (0 beats)
  pushI32(1);
  pushU8(0);
  pushI8(-1); // half
  pushU8(1 << 3); // string 4 (bit 3)
  pushU8(0x20);
  pushU8(1);
  pushI8(5); // fret 5
  pushU8(0);
  pushZeros(2);
  pushI32(0);
  pushU8(0);

  return new Uint8Array(buf);
}

describe('L1 V2.3 单元测试 - Guitar Pro 解码、技巧归一化、混音规则与自相关调音器', () => {
  it('解析 .gp（ZIP + score.gpif）多轨曲谱，保留调弦、Capo、弦品与 6 种吉他技巧', async () => {
    const gpBytes = await packZip([
      { name: 'Content/score.gpif', data: new TextEncoder().encode(SAMPLE_GPIF_XML) },
    ]);
    const res = await importGuitarProToScoreV2(gpBytes, { nowMs: 1730000000000 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const v2 = res.value;
    expect(validateScoreDocumentV2(v2).ok).toBe(true);
    expect(v2.title).toBe('V2.3 摇滚双轨示例');
    expect(v2.bpm).toBe(128);
    expect(v2.keySignature).toBe('G');
    expect(v2.timeSignature).toBe('4/4');
    expect(v2.tracks).toHaveLength(2);

    const lead = v2.tracks[0]!;
    expect(lead.instrumentId).toBe('electric-guitar-od');
    expect(lead.capo).toBe(2);
    expect(lead.tuning).toEqual([64, 59, 55, 50, 45, 40]);

    const leadBeats = lead.voices[0]!.measures[0]!.beats;
    expect(leadBeats).toHaveLength(4);
    expect(leadBeats[0]!.notes[0]!.guitar?.techniques).toEqual(['bend', 'vibrato']);
    expect(leadBeats[1]!.notes[0]!.guitar?.techniques).toEqual(['slide', 'hammer']);
    expect(leadBeats[2]!.notes[0]!.guitar?.techniques).toEqual(['pull', 'palm-mute']);

    const bass = v2.tracks[1]!;
    expect(bass.instrumentId).toBe('bass');
    expect(bass.clef).toBe('bass');
    expect(bass.tuning).toEqual([43, 38, 33, 28]);
  });

  it('解析 .gpx（BCFZ + BCFS 容器）与 .gp5 二进制多轨曲谱', async () => {
    const gpifBytes = new TextEncoder().encode(SAMPLE_GPIF_XML);
    const bcfs = buildBcfsContainer('score.gpif', gpifBytes);
    const bcfz = buildBcfzFromBcfs(bcfs);

    const gpxRes = await importGuitarProToScoreV2(bcfz, { nowMs: 1730000000000 });
    expect(gpxRes.ok).toBe(true);
    if (gpxRes.ok) {
      expect(gpxRes.value.tracks).toHaveLength(2);
      expect(gpxRes.value.title).toBe('V2.3 摇滚双轨示例');
    }

    const gp5Bytes = buildMinimalGp5Fixture();
    const gp5Res = await importGuitarProToScoreV2(gp5Bytes, { nowMs: 1730000000000 });
    expect(gp5Res.ok).toBe(true);
    if (gp5Res.ok) {
      expect(gp5Res.value.title).toBe('GP5 二进制示例');
      expect(gp5Res.value.bpm).toBe(116);
      expect(gp5Res.value.tracks).toHaveLength(2);
      const leadNote = gp5Res.value.tracks[0]!.voices[0]!.measures[0]!.beats[0]!.notes[0]!;
      expect(leadNote.guitar?.fret).toBe(12);
      expect(leadNote.guitar?.techniques).toEqual([
        'bend',
        'slide',
        'hammer',
        'palm-mute',
        'vibrato',
      ]);
      expect(gp5Res.value.tracks[1]!.instrumentId).toBe('bass');
    }
  });

  it('损坏、截断或旧版 GP 文件返回标准中文 AppError', async () => {
    const emptyRes = await importGuitarProToScoreV2(new Uint8Array([1, 2, 3]));
    expect(emptyRes.ok).toBe(false);
    if (!emptyRes.ok) {
      expect(emptyRes.error.code).toBe('STORAGE_SCHEMA_CORRUPTED');
      assertChineseAppError(emptyRes.error);
    }

    const legacyHeader = new Uint8Array(64);
    const gp4Str = 'FICHIER GUITAR PRO v4.06';
    legacyHeader[0] = gp4Str.length;
    legacyHeader.set(new TextEncoder().encode(gp4Str), 1);
    const gp4Res = await importGuitarProToScoreV2(legacyHeader);
    expect(gp4Res.ok).toBe(false);
    if (!gp4Res.ok) {
      expect(gp4Res.error.code).toBe('STORAGE_SCHEMA_CORRUPTED');
      assertChineseAppError(gp4Res.error);
    }

    const garbageRes = await importGuitarProToScoreV2(
      new TextEncoder().encode('not-a-valid-guitar-pro-file-at-all')
    );
    expect(garbageRes.ok).toBe(false);
    if (!garbageRes.ok) {
      assertChineseAppError(garbageRes.error);
    }
  });

  it('自相关音高检测精度（吉他 E2/A2/E4、A4=440Hz、贝斯 B0、偏高/偏低与静音过滤）', () => {
    const sampleRate = 44100;
    const targetStrings = buildTargetStringsFromTuning(
      [64, 59, 55, 50, 45, 40],
      ['e', 'B', 'G', 'D', 'A', 'E'],
      0,
      440
    );

    const testCases = [
      { hz: 82.41, expectedLabel: 'E2', expectedString: 6 },
      { hz: 110.0, expectedLabel: 'A2', expectedString: 5 },
      { hz: 329.63, expectedLabel: 'E4', expectedString: 1 },
      { hz: 440.0, expectedLabel: 'A4', expectedString: 1 },
    ];

    for (const tc of testCases) {
      const buf = generateSineWaveBuffer(tc.hz, sampleRate, 4096, 0.7);
      const detected = detectPitchAutocorrelation(buf, sampleRate);
      expect(detected).not.toBeNull();
      if (!detected) continue;
      expect(Math.abs(detected.frequencyHz - tc.hz)).toBeLessThan(1.0);

      const reading = analyzeTunerReading(detected, targetStrings, { a4Hz: 440 });
      expect(reading.noteLabel).toBe(tc.expectedLabel);
      expect(reading.status).toBe('in-tune');
      expect(Math.abs(reading.centsOff)).toBeLessThanOrEqual(3);
      if (tc.hz <= 330) {
        expect(reading.matchedString?.stringNumber).toBe(tc.expectedString);
      }
    }

    // 偏低 -20 音分与偏高 +20 音分状态识别
    const flatHz = 110 * Math.pow(2, -20 / 1200);
    const sharpHz = 110 * Math.pow(2, 20 / 1200);
    const flatRes = analyzeTunerReading(
      detectPitchAutocorrelation(generateSineWaveBuffer(flatHz, sampleRate, 4096), sampleRate)!,
      targetStrings
    );
    expect(flatRes.status).toBe('flat');
    expect(flatRes.centsOff).toBeLessThan(-10);

    const sharpRes = analyzeTunerReading(
      detectPitchAutocorrelation(generateSineWaveBuffer(sharpHz, sampleRate, 4096), sampleRate)!,
      targetStrings
    );
    expect(sharpRes.status).toBe('sharp');
    expect(sharpRes.centsOff).toBeGreaterThan(10);

    // 5 弦贝斯超低音 B0 (30.87Hz) 需长窗口
    const b0Buf = generateSineWaveBuffer(30.87, sampleRate, 8192, 0.7);
    const b0Detected = detectPitchAutocorrelation(b0Buf, sampleRate);
    expect(b0Detected).not.toBeNull();
    if (b0Detected) {
      expect(Math.abs(b0Detected.frequencyHz - 30.87)).toBeLessThan(1.0);
    }

    // 静音输入返回 null
    const silence = new Float32Array(4096);
    expect(detectPitchAutocorrelation(silence, sampleRate)).toBeNull();
  });

  it('技巧归一化与多轨混音 Mute/Solo/Gain 优先级判定精确', () => {
    expect(
      normalizeGuitarTechniques(['vibrato', 'bend', 'unknown-tech', 'bend', 'slide'])
    ).toEqual(['bend', 'slide', 'vibrato']);

    const ids = ['t1', 't2', 't3'];
    expect(resolveTrackAudibility(ids, {})).toEqual({
      t1: { audible: true, effectiveGain: 1 },
      t2: { audible: true, effectiveGain: 1 },
      t3: { audible: true, effectiveGain: 1 },
    });

    // Solo 优先屏蔽非 Solo 轨；若某轨同时被 Mute 则静音
    const mixed = resolveTrackAudibility(ids, {
      t1: { muted: true, solo: true, gain: 1.2 },
      t2: { muted: false, solo: true, gain: 0.8 },
      t3: { muted: false, solo: false, gain: 1.0 },
    });
    expect(mixed.t1?.audible).toBe(false);
    expect(mixed.t2).toEqual({ audible: true, effectiveGain: 0.8 });
    expect(mixed.t3?.audible).toBe(false);
  });
});
