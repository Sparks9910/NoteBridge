import { describe, expect, it } from 'vitest';
import {
  formatScoreV2ToJianpuText,
  inspectJianpuText,
  parseJianpuTextToScoreV2,
} from '../../src/domain/v2-jianpu-text.ts';
import {
  extractPartsFromScoreV2,
  extractVoiceAsPartV2,
  validateScoreDocumentV2,
} from '../../src/domain/v2-serializer.ts';
import type { ScoreDocumentV2 } from '../../src/domain/v2-types.ts';
import { importScoreFromFileData } from '../../src/infrastructure/codecs/codec-registry.ts';
import {
  exportScoreV2ToMidi,
  importMidiToScoreV2,
} from '../../src/infrastructure/codecs/midi-codec.ts';
import {
  exportScoreV2ToMusicXml,
  exportScoreV2ToMxl,
  importMusicXmlToScoreV2,
  importMxlToScoreV2,
} from '../../src/infrastructure/codecs/musicxml-codec.ts';

function createRichGrandScoreV2(): ScoreDocumentV2 {
  return {
    schemaVersion: 2,
    id: 'v21_grand_1',
    title: '卡农钢琴双声部测试',
    subtitle: 'V2.1 互通测试',
    composer: '帕赫贝尔',
    lyricist: '音桥',
    keySignature: 'G',
    timeSignature: '4/4',
    bpm: 96,
    viewMode: 'dual',
    updatedAtEpochMs: 1732400000000,
    tracks: [
      {
        id: 'track_piano',
        name: '钢琴',
        instrumentId: 'piano',
        clef: 'grand',
        enabledViews: ['staff', 'jianpu'],
        voices: [
          {
            id: 'voice_1',
            index: 0,
            measures: [
              {
                id: 'm1',
                index: 0,
                repeatStart: true,
                ending: 1,
                beats: [
                  {
                    id: 'b1',
                    isRest: false,
                    baseDuration: 'quarter',
                    dotted: false,
                    durationTicks: 480,
                    lyric: '春',
                    dynamic: 'mf',
                    ornament: 'trill',
                    slurStart: true,
                    notes: [
                      {
                        id: 'p1',
                        midiPitch: 71,
                        degree: 3,
                        octaveOffset: 0,
                        accidental: null,
                        fingering: '3',
                      },
                    ],
                  },
                  {
                    id: 'b2',
                    isRest: false,
                    baseDuration: 'quarter',
                    dotted: false,
                    durationTicks: 480,
                    lyric: '风',
                    slurEnd: true,
                    notes: [
                      {
                        id: 'p2',
                        midiPitch: 69,
                        degree: 2,
                        octaveOffset: 0,
                        accidental: null,
                        fingering: '2',
                      },
                    ],
                  },
                ],
              },
              {
                id: 'm2',
                index: 1,
                repeatEnd: true,
                beats: [
                  {
                    id: 'b3',
                    isRest: false,
                    baseDuration: 'half',
                    dotted: false,
                    durationTicks: 960,
                    tieStart: true,
                    notes: [
                      {
                        id: 'p3',
                        midiPitch: 67,
                        degree: 1,
                        octaveOffset: 0,
                        accidental: null,
                        fingering: '1',
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: 'voice_2',
            index: 1,
            measures: [
              {
                id: 'm1_v2',
                index: 0,
                beats: [
                  {
                    id: 'b1_v2',
                    isRest: false,
                    baseDuration: 'half',
                    dotted: false,
                    durationTicks: 960,
                    notes: [
                      {
                        id: 'p1_v2',
                        midiPitch: 43,
                        degree: 1,
                        octaveOffset: -2,
                        accidental: null,
                      },
                    ],
                  },
                ],
              },
              {
                id: 'm2_v2',
                index: 1,
                beats: [
                  {
                    id: 'b2_v2',
                    isRest: false,
                    baseDuration: 'half',
                    dotted: false,
                    durationTicks: 960,
                    notes: [
                      {
                        id: 'p2_v2',
                        midiPitch: 50,
                        degree: 5,
                        octaveOffset: -2,
                        accidental: null,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        id: 'track_guitar',
        name: '电吉他主音',
        instrumentId: 'electric-guitar-clean',
        clef: 'treble',
        enabledViews: ['staff', 'jianpu'],
        voices: [
          {
            id: 'g_v1',
            index: 0,
            measures: [
              {
                id: 'gm1',
                index: 0,
                beats: [
                  {
                    id: 'gb1',
                    isRest: false,
                    baseDuration: 'whole',
                    dotted: false,
                    durationTicks: 1920,
                    notes: [
                      {
                        id: 'gp1',
                        midiPitch: 67,
                        degree: 1,
                        octaveOffset: 0,
                        accidental: null,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('L1 V2.1 MusicXML / MXL / MIDI / 简谱文本与分谱提取单元测试', () => {
  it('MusicXML 双向导入导出完整保留大谱表、多声部、歌词、指法、强弱与反复记号', () => {
    const src = createRichGrandScoreV2();
    const xmlRes = exportScoreV2ToMusicXml(src);
    expect(xmlRes.ok).toBe(true);
    if (!xmlRes.ok) return;

    expect(xmlRes.value).toContain('<score-partwise version="4.0">');
    expect(xmlRes.value).toContain('<staves>2</staves>');
    expect(xmlRes.value).toContain('<fingering>3</fingering>');
    expect(xmlRes.value).toContain('<lyric number="1"><text>春</text></lyric>');
    expect(xmlRes.value).toContain('<repeat direction="forward"/>');
    expect(xmlRes.value).toContain('<repeat direction="backward"/>');

    const imported = importMusicXmlToScoreV2(xmlRes.value);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    const v2 = imported.value;
    expect(v2.title).toBe('卡农钢琴双声部测试');
    expect(v2.keySignature).toBe('G');
    expect(v2.timeSignature).toBe('4/4');
    expect(v2.bpm).toBe(96);
    expect(v2.tracks).toHaveLength(2);
    expect(v2.tracks[0]?.clef).toBe('grand');
    expect(v2.tracks[0]?.voices).toHaveLength(2);

    const m0 = v2.tracks[0]?.voices[0]?.measures[0];
    expect(m0?.repeatStart).toBe(true);
    expect(m0?.ending).toBe(1);
    expect(m0?.beats[0]?.lyric).toBe('春');
    expect(m0?.beats[0]?.dynamic).toBe('mf');
    expect(m0?.beats[0]?.ornament).toBe('trill');
    expect(m0?.beats[0]?.notes[0]?.fingering).toBe('3');
    expect(v2.tracks[0]?.voices[1]?.measures[0]?.beats[0]?.notes[0]?.midiPitch).toBe(43);
  });

  it('压缩 .mxl 打包与解包往返完全一致', async () => {
    const src = createRichGrandScoreV2();
    const mxlRes = await exportScoreV2ToMxl(src);
    expect(mxlRes.ok).toBe(true);
    if (!mxlRes.ok) return;

    expect(mxlRes.value[0]).toBe(0x50); // 'P'
    expect(mxlRes.value[1]).toBe(0x4b); // 'K'

    const importRes = await importMxlToScoreV2(mxlRes.value);
    expect(importRes.ok).toBe(true);
    if (!importRes.ok) return;

    expect(importRes.value.title).toBe(src.title);
    expect(importRes.value.tracks).toHaveLength(2);
    expect(validateScoreDocumentV2(importRes.value).ok).toBe(true);
  });

  it('MIDI (.mid) 标准 SMF Format 1 导出与反向导入量化准确', () => {
    const src = createRichGrandScoreV2();
    const midiRes = exportScoreV2ToMidi(src);
    expect(midiRes.ok).toBe(true);
    if (!midiRes.ok) return;

    const decoder = new TextDecoder('latin1');
    expect(decoder.decode(midiRes.value.subarray(0, 4))).toBe('MThd');

    const imported = importMidiToScoreV2(midiRes.value, { title: 'MIDI 回环' });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    expect(imported.value.keySignature).toBe('G');
    expect(imported.value.timeSignature).toBe('4/4');
    expect(imported.value.bpm).toBe(96);
    expect(imported.value.tracks.length).toBeGreaterThanOrEqual(2);
    expect(imported.value.tracks[0]?.voices[0]?.measures[0]?.beats[0]?.notes[0]?.midiPitch).toBe(71);
  });

  it('简谱文本快捷语法支持头指令、升降、高低八度、减/增时线、反复与逐音歌词绑定', () => {
    const rawText = [
      '标题: 春游歌',
      '作曲: 音桥示例',
      '1=G 4/4 BPM=108',
      '歌词: 春 风 吹 绿 山 坡',
      "||: #1 2' 3_ 4_ | 5 - 0 6, :||",
    ].join('\n');

    const parsed = parseJianpuTextToScoreV2(rawText);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const doc = parsed.value;
    expect(doc.title).toBe('春游歌');
    expect(doc.composer).toBe('音桥示例');
    expect(doc.keySignature).toBe('G');
    expect(doc.bpm).toBe(108);

    const m0 = doc.tracks[0]?.voices[0]?.measures[0];
    const m1 = doc.tracks[0]?.voices[0]?.measures[1];
    expect(m0?.repeatStart).toBe(true);
    expect(m1?.repeatEnd).toBe(true);
    expect(m0?.beats[0]?.notes[0]?.accidental).toBe('sharp');
    expect(m0?.beats[0]?.lyric).toBe('春');
    expect(m0?.beats[1]?.notes[0]?.octaveOffset).toBe(1);
    expect(m0?.beats[2]?.baseDuration).toBe('eighth');
    expect(m1?.beats[0]?.baseDuration).toBe('half');
    expect(m1?.beats[1]?.isRest).toBe(true);
    expect(m1?.beats[2]?.notes[0]?.octaveOffset).toBe(-1);

    const formatted = formatScoreV2ToJianpuText(doc);
    expect(formatted).toContain('#1');
    expect(formatted).toContain("2'");
    expect(formatted).toContain('||:');
    expect(formatted).toContain(':||');
  });

  it('简谱文本多行不混小节、无空小节、支持反复与往返一致', () => {
    const multiline = [
      '标题: 欢乐颂多行',
      '1=C 4/4 BPM=100',
      '| 3 3 4 5 | 5 4 3 2',
      '1 1 2 3 | 3. 2_ 2 - ||',
    ].join('\n');

    const res = parseJianpuTextToScoreV2(multiline);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const measures = res.value.tracks[0]?.voices[0]?.measures ?? [];
    expect(measures).toHaveLength(4);
    for (const m of measures) {
      expect(m.beats.length).toBeGreaterThan(0);
      expect(m.beats.reduce((s, b) => s + b.durationTicks, 0)).toBe(1920);
    }
    expect(measures[3]?.barline).toBe('final');

    const repeatText = [
      '1=G 4/4 BPM=96',
      '|: 1 2 3 4 | 5 6 5 - :| 4 3 2 1 || 1 1 5 5 ||',
    ].join('\n');
    const repeatRes = parseJianpuTextToScoreV2(repeatText);
    expect(repeatRes.ok).toBe(true);
    if (!repeatRes.ok) return;
    const rMeasures = repeatRes.value.tracks[0]?.voices[0]?.measures ?? [];
    expect(rMeasures).toHaveLength(4);
    expect(rMeasures[0]?.repeatStart).toBe(true);
    expect(rMeasures[1]?.repeatEnd).toBe(true);
    expect(rMeasures[2]?.barline).toBe('double');
    expect(rMeasures[3]?.barline).toBe('final');

    // formatScoreV2ToJianpuText -> parseJianpuTextToScoreV2 往返不产生空小节
    const roundtripText = formatScoreV2ToJianpuText(repeatRes.value);
    expect(roundtripText).not.toContain(':|| |');
    const roundtripRes = parseJianpuTextToScoreV2(roundtripText);
    expect(roundtripRes.ok).toBe(true);
    if (!roundtripRes.ok) return;
    const rtMeasures = roundtripRes.value.tracks[0]?.voices[0]?.measures ?? [];
    expect(rtMeasures).toHaveLength(4);
    expect(rtMeasures[0]?.repeatStart).toBe(true);
    expect(rtMeasures[1]?.repeatEnd).toBe(true);
    expect(rtMeasures[2]?.barline).toBe('double');
    expect(rtMeasures[3]?.barline).toBe('final');
  });

  it('简谱文本支持紧凑连写、变序修饰符、附点二分、斜线减时线、全角与跨小节延音', () => {
    const compactText = [
      '1=bB 4/4 速度: 108',
      '1155 | 665- | 3.2_ 5-. | 1/ 2/ 3/4 | 5//6//7//1\'// | 5 - - - -',
    ].join('\n');

    const res = parseJianpuTextToScoreV2(compactText);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.keySignature).toBe('Bb');
    expect(res.value.bpm).toBe(108);

    const ms = res.value.tracks[0]?.voices[0]?.measures ?? [];
    expect(ms).toHaveLength(6);
    expect(ms[0]?.beats.map((b) => b.notes[0]?.degree)).toEqual([1, 1, 5, 5]);
    expect(ms[1]?.beats.map((b) => b.baseDuration)).toEqual(['quarter', 'quarter', 'half']);
    expect(ms[2]?.beats[0]?.dotted).toBe(true);
    expect(ms[2]?.beats[1]?.baseDuration).toBe('eighth');
    expect(ms[2]?.beats[2]?.baseDuration).toBe('half');
    expect(ms[2]?.beats[2]?.dotted).toBe(true);
    expect(ms[3]?.beats.map((b) => b.baseDuration)).toEqual([
      'eighth',
      'eighth',
      'eighth',
      'quarter',
    ]);
    expect(ms[4]?.beats.map((b) => b.baseDuration)).toEqual([
      'sixteenth',
      'sixteenth',
      'sixteenth',
      'sixteenth',
    ]);
    expect(ms[4]?.beats[3]?.notes[0]?.octaveOffset).toBe(1);
    // 5拍延音拆分为 全音符(1920) + 四分音符(480) 并带 tieStart/tieEnd
    expect(ms[5]?.beats).toHaveLength(2);
    expect(ms[5]?.beats[0]?.baseDuration).toBe('whole');
    expect(ms[5]?.beats[0]?.tieStart).toBe(true);
    expect(ms[5]?.beats[1]?.baseDuration).toBe('quarter');
    expect(ms[5]?.beats[1]?.tieEnd).toBe(true);

    // 变序修饰符、全角字符、智能引号与组合音点、升降后缀、跨小节增时线
    const variants = [
      '调号: #F',
      '拍号: 3/4',
      '♩=96',
      '３._ ５’ ５\u0323 +1 | 4# 5 | - b7 (1 2 3) | [C] 1 ~ 1 [G7] 2',
    ].join('\n');
    const vRes = parseJianpuTextToScoreV2(variants);
    expect(vRes.ok).toBe(true);
    if (!vRes.ok) return;
    expect(vRes.value.keySignature).toBe('Gb');
    expect(vRes.value.timeSignature).toBe('3/4');
    expect(vRes.value.bpm).toBe(96);

    const vMs = vRes.value.tracks[0]?.voices[0]?.measures ?? [];
    expect(vMs).toHaveLength(4);
    expect(vMs[0]?.beats[0]?.baseDuration).toBe('eighth');
    expect(vMs[0]?.beats[0]?.dotted).toBe(true);
    expect(vMs[0]?.beats[1]?.notes[0]?.octaveOffset).toBe(1);
    expect(vMs[0]?.beats[2]?.notes[0]?.octaveOffset).toBe(-1);
    expect(vMs[0]?.beats[3]?.notes[0]?.octaveOffset).toBe(1);

    expect(vMs[1]?.beats[0]?.notes[0]?.degree).toBe(4);
    expect(vMs[1]?.beats[0]?.notes[0]?.accidental).toBe('sharp');
    expect(vMs[1]?.beats[1]?.tieStart).toBe(true);

    // 跨小节 "-" 继承上一音符并自动加 tieEnd；b7 不被误判为和弦
    expect(vMs[2]?.beats[0]?.notes[0]?.degree).toBe(5);
    expect(vMs[2]?.beats[0]?.tieEnd).toBe(true);
    expect(vMs[2]?.beats[1]?.notes[0]?.degree).toBe(7);
    expect(vMs[2]?.beats[1]?.notes[0]?.accidental).toBe('flat');
    expect(vMs[2]?.beats[2]?.slurStart).toBe(true);
    expect(vMs[2]?.beats[4]?.slurEnd).toBe(true);

    // [C] 与 [G7] 不将 7 识别为音符 7，1 ~ 1 带连音线
    expect(vMs[3]?.beats).toHaveLength(3);
    expect(vMs[3]?.beats[0]?.chordSymbol).toBe('C');
    expect(vMs[3]?.beats[0]?.tieStart).toBe(true);
    expect(vMs[3]?.beats[1]?.tieEnd).toBe(true);
    expect(vMs[3]?.beats[2]?.chordSymbol).toBe('G7');
    expect(vMs[3]?.beats[2]?.notes[0]?.degree).toBe(2);
  });

  it('简谱文本支持无小节线自动分小节、交错歌词与预检诊断 inspectJianpuText', () => {
    const noBarline = [
      '# 自动分小节测试',
      '原唱: 5月天',
      '[前奏]',
      '1=D 3/4 速度=120',
      '歌词: 一 闪 一，闪 亮。晶 晶',
      '1 1 5 5 6 6 5 -',
    ].join('\n');

    const res = parseJianpuTextToScoreV2(noBarline);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.keySignature).toBe('D');
    expect(res.value.timeSignature).toBe('3/4');
    expect(res.value.bpm).toBe(120);

    const ms = res.value.tracks[0]?.voices[0]?.measures ?? [];
    // 3/4 容量 1440 ticks: [1,1,5]=1440 | [5,6,6]=1440 | [5-]=960
    expect(ms).toHaveLength(3);
    expect(ms[0]?.beats.map((b) => b.lyric)).toEqual(['一', '闪', '一']);
    expect(ms[1]?.beats.map((b) => b.lyric)).toEqual(['闪', '亮', '晶']);
    expect(ms[2]?.beats.map((b) => b.lyric)).toEqual(['晶']);

    // 交错歌词行含 | 时不产生空小节，且歌词正确绑定到前一行旋律
    const interleaved = [
      '1=C 4/4',
      '1 1 5 5 | 6 6 5 - |',
      '一 闪 一 闪 | 亮 晶 晶 |',
    ].join('\n');
    const ilRes = parseJianpuTextToScoreV2(interleaved);
    expect(ilRes.ok).toBe(true);
    if (!ilRes.ok) return;
    const ilMs = ilRes.value.tracks[0]?.voices[0]?.measures ?? [];
    expect(ilMs).toHaveLength(2);
    expect(ilMs[0]?.beats.map((b) => b.lyric)).toEqual(['一', '闪', '一', '闪']);
    expect(ilMs[1]?.beats.map((b) => b.lyric)).toEqual(['亮', '晶', '晶']);

    // 单音符行 "3. -" 不被误判为序号前缀，且带序号的歌词行 "1. 一闪一闪" 正常剥离序号
    const singleDottedRes = parseJianpuTextToScoreV2('1=C 4/4\n3. -\n1. 一闪一闪');
    expect(singleDottedRes.ok).toBe(true);
    if (!singleDottedRes.ok) return;
    const sdBeat = singleDottedRes.value.tracks[0]?.voices[0]?.measures[0]?.beats[0];
    expect(sdBeat?.baseDuration).toBe('half');
    expect(sdBeat?.dotted).toBe(true);
    expect(sdBeat?.lyric).toBe('一');

    const diag = inspectJianpuText('1=C 4/4\n1 2 3 4 5 | 8 1 2 3 -');
    expect(diag.ok).toBe(true);
    expect(diag.measureCount).toBe(2);
    expect(diag.noteCount).toBe(8);
    expect(diag.skippedTokens).toContain('8');
    expect(diag.overflowMeasures).toEqual([1]);
  });

  it('分谱提取（Part Extraction）支持按轨道筛选与钢琴左右手单声部独立提取', () => {
    const src = createRichGrandScoreV2();

    const guitarPart = extractPartsFromScoreV2(src, ['track_guitar']);
    expect(guitarPart.ok).toBe(true);
    if (guitarPart.ok) {
      expect(guitarPart.value.tracks).toHaveLength(1);
      expect(guitarPart.value.tracks[0]?.id).toBe('track_guitar');
      expect(guitarPart.value.title).toContain('电吉他主音');
    }

    const leftHandPart = extractVoiceAsPartV2(src, 'track_piano', 1);
    expect(leftHandPart.ok).toBe(true);
    if (leftHandPart.ok) {
      expect(leftHandPart.value.tracks).toHaveLength(1);
      expect(leftHandPart.value.tracks[0]?.clef).toBe('bass');
      expect(leftHandPart.value.tracks[0]?.voices).toHaveLength(1);
      expect(
        leftHandPart.value.tracks[0]?.voices[0]?.measures[0]?.beats[0]?.notes[0]?.midiPitch
      ).toBe(43);
    }

    const missingPart = extractPartsFromScoreV2(src, ['not_exist']);
    expect(missingPart.ok).toBe(false);
    if (!missingPart.ok) {
      expect(missingPart.error.code).toBe('RESOURCE_NOT_FOUND');
      expect(missingPart.error.detail).toMatch(/[\u4e00-\u9fa5]/);
    }
  });

  it('损坏的 MusicXML / MXL / MIDI / 简谱文本均返回中文 AppError（无英文堆栈）', async () => {
    const encoder = new TextEncoder();

    const badXml = await importScoreFromFileData({
      filename: 'broken.musicxml',
      bytes: encoder.encode('<score-partwise><unclosed></score-partwise>'),
    });
    expect(badXml.ok).toBe(false);
    if (!badXml.ok) {
      expect(badXml.error.code).toBe('STORAGE_SCHEMA_CORRUPTED');
      expect(badXml.error.detail).toMatch(/[\u4e00-\u9fa5]/);
    }

    const badMxl = await importScoreFromFileData({
      filename: 'broken.mxl',
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    expect(badMxl.ok).toBe(false);
    if (!badMxl.ok) {
      expect(badMxl.error.code).toBe('STORAGE_SCHEMA_CORRUPTED');
      expect(badMxl.error.detail).toMatch(/[\u4e00-\u9fa5]/);
    }

    const badMidi = await importScoreFromFileData({
      filename: 'broken.mid',
      bytes: encoder.encode('NOT_A_MIDI_FILE_HEADER'),
    });
    expect(badMidi.ok).toBe(false);
    if (!badMidi.ok) {
      expect(badMidi.error.code).toBe('STORAGE_SCHEMA_CORRUPTED');
      expect(badMidi.error.detail).toMatch(/[\u4e00-\u9fa5]/);
    }

    const badJianpu = parseJianpuTextToScoreV2('这里没有任何数字音符');
    expect(badJianpu.ok).toBe(false);
    if (!badJianpu.ok) {
      expect(badJianpu.error.code).toBe('STORAGE_SCHEMA_CORRUPTED');
      expect(badJianpu.error.detail).toMatch(/[\u4e00-\u9fa5]/);
    }
  });
});
