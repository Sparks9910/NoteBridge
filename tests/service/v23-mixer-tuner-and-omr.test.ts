import { describe, expect, it } from 'vitest';
import { createInputStore } from '../../src/application/input-store.ts';
import { createLibraryStore } from '../../src/application/library-store.ts';
import { createNotationStore } from '../../src/application/notation-store.ts';
import {
  checkOmrProviderHealth,
  loadFileAsReferenceOnly,
  recognizeScoreWithOmrAndAttachReference,
} from '../../src/application/omr-service.ts';
import { createPlaybackController } from '../../src/application/playback-controller.ts';
import { createPracticeStore } from '../../src/application/practice-store.ts';
import { createScoreStore } from '../../src/application/score-store.ts';
import { createTunerStore } from '../../src/application/tuner-store.ts';
import { createWorkspaceStore } from '../../src/application/workspace-store.ts';
import type { AppError } from '../../src/domain/types.ts';
import { projectV2ToV1 } from '../../src/domain/v2-serializer.ts';
import { buildTargetStringsFromTuning } from '../../src/domain/v2-tuner.ts';
import type { ScoreDocumentV2 } from '../../src/domain/v2-types.ts';
import { MockAudioEngine } from '../../src/infrastructure/audio-engine.ts';
import { InMemoryLibraryRepository } from '../../src/infrastructure/indexeddb-adapter.ts';
import {
  StorageAdapter,
  type StorageLike,
} from '../../src/infrastructure/storage-adapter.ts';
import { MockTunerAdapter } from '../../src/infrastructure/tuner-adapter.ts';

class MemoryStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  public getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  public setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  public removeItem(key: string): void {
    this.map.delete(key);
  }
}

function assertChineseAppError(err: AppError): void {
  expect(err.detail.trim().length).toBeGreaterThan(0);
  expect(/[\u4e00-\u9fa5]/.test(err.detail)).toBe(true);
  expect(err.detail).not.toMatch(/Error:|TypeError|SyntaxError|stack|\bat\s+\S+\s*\(/i);
}

function makeMultiTrackScoreV2(): ScoreDocumentV2 {
  return {
    schemaVersion: 2,
    id: 'v23_multitrack_doc',
    title: '双轨伴奏跟弹测试',
    keySignature: 'C',
    timeSignature: '4/4',
    bpm: 120,
    viewMode: 'dual',
    updatedAtEpochMs: 1732500000000,
    tracks: [
      {
        id: 'track_lead',
        name: '主音电吉他',
        instrumentId: 'electric-guitar-od',
        clef: 'treble',
        enabledViews: ['staff', 'tab'],
        voices: [
          {
            id: 'v_lead_0',
            index: 0,
            measures: [
              {
                id: 'm_lead_0',
                index: 0,
                beats: [
                  {
                    id: 'b_lead_1',
                    isRest: false,
                    baseDuration: 'half',
                    dotted: false,
                    durationTicks: 960,
                    notes: [
                      {
                        id: 'p_lead_1',
                        midiPitch: 64,
                        degree: 3,
                        octaveOffset: 0,
                        accidental: null,
                        guitar: { string: 1, fret: 0, techniques: ['vibrato'] },
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
        id: 'track_bass',
        name: '伴奏贝斯',
        instrumentId: 'bass',
        clef: 'bass',
        enabledViews: ['staff', 'tab'],
        voices: [
          {
            id: 'v_bass_0',
            index: 0,
            measures: [
              {
                id: 'm_bass_0',
                index: 0,
                beats: [
                  {
                    id: 'b_bass_1',
                    isRest: false,
                    baseDuration: 'half',
                    dotted: false,
                    durationTicks: 960,
                    notes: [
                      {
                        id: 'p_bass_1',
                        midiPitch: 36,
                        degree: 1,
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
    ],
  };
}

const SAMPLE_MUSICXML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>OMR 识别乐谱示例</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>钢琴</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

describe('L2 V2.3 服务层测试 - 多轨 Mute/Solo 调度、调音器适配器与 OMR 服务', () => {
  it('多轨混音（Mute / Solo / Gain / 消主音跟弹）精确控制播放调度且不标脏文档', async () => {
    const legacy = new StorageAdapter({
      storage: new MemoryStorage(),
      namespace: 'nb_v23_mixer_svc',
    });
    const sStore = createScoreStore({
      storage: legacy,
      config: { enableDemoMode: false, defaultBpm: 120 },
      autoSaveDelayMs: 0,
    });
    const iStore = createInputStore();
    const nStore = createNotationStore();
    const pStore = createPracticeStore();
    const audio = new MockAudioEngine({ lookaheadMs: 20 });
    const controller = createPlaybackController({
      scoreStore: sStore,
      inputStore: iStore,
      notationStore: nStore,
      practiceStore: pStore,
      audioEngine: audio,
    });

    const v2 = makeMultiTrackScoreV2();
    sStore.getState().loadExternalDocument(projectV2ToV1(v2));
    sStore.getState().saveNow();
    nStore.getState().loadFromV2Document(v2);
    pStore.getState().selectInstrument('electric-guitar-od');
    expect(sStore.getState().documentState).toBe('CLEAN');

    // 1. 默认两轨全响
    const play1 = await controller.play();
    expect(play1.ok).toBe(true);
    expect(audio.scheduledNotes.some((n) => n.trackId === 'track_lead')).toBe(true);
    expect(audio.scheduledNotes.some((n) => n.trackId === 'track_bass')).toBe(true);
    const bassNote = audio.scheduledNotes.find((n) => n.trackId === 'track_bass');
    expect(bassNote?.instrumentId).toBe('bass');
    expect(bassNote?.midiPitch).toBe(36);
    controller.stop();

    // 2. 消主音跟弹（Mute 主音吉他，仅留伴奏贝斯）
    pStore.getState().muteLeadTrackForPlayAlong('track_lead');
    expect(sStore.getState().documentState).toBe('CLEAN');
    await controller.play();
    expect(audio.scheduledNotes.some((n) => n.trackId === 'track_lead')).toBe(false);
    expect(audio.scheduledNotes.some((n) => n.trackId === 'track_bass')).toBe(true);

    // 3. 播放期动态切换 Solo 主音 + 调音量增益
    pStore.getState().resetTrackMixer();
    pStore.getState().toggleTrackSolo('track_lead');
    pStore.getState().setTrackGain('track_lead', 0.5);
    const refreshRes = controller.refreshMixLive();
    expect(refreshRes.ok).toBe(true);
    expect(audio.scheduledNotes.some((n) => n.trackId === 'track_lead')).toBe(true);
    expect(audio.scheduledNotes.some((n) => n.trackId === 'track_bass')).toBe(false);
    const leadScaled = audio.scheduledNotes.find((n) => n.trackId === 'track_lead');
    expect(leadScaled?.velocity).toBeCloseTo(0.425, 2);

    controller.stop();
    expect(sStore.getState().documentState).toBe('CLEAN');
    controller.dispose();
    sStore.getState().dispose();
  });

  it('tunerStore 接入 MockTunerAdapter：正常收音识别、权限拒绝与无设备中文降级', async () => {
    const adapter = new MockTunerAdapter();
    const tStore = createTunerStore(adapter);
    const targets = buildTargetStringsFromTuning(
      [64, 59, 55, 50, 45, 40],
      ['e', 'B', 'G', 'D', 'A', 'E']
    );

    const startRes = await tStore.getState().start(targets);
    expect(startRes.ok).toBe(true);
    expect(tStore.getState().status).toBe('listening');

    adapter.emitFrequency(440);
    const r = tStore.getState().reading;
    expect(r).not.toBeNull();
    expect(r?.noteLabel).toBe('A4');
    expect(r?.status).toBe('in-tune');
    expect(Math.abs(r?.centsOff ?? 99)).toBeLessThanOrEqual(2);

    tStore.getState().stop();
    expect(tStore.getState().status).toBe('idle');

    // 权限拒绝降级
    adapter.failMode = 'denied';
    const deniedRes = await tStore.getState().start(targets);
    expect(deniedRes.ok).toBe(false);
    expect(tStore.getState().status).toBe('error');
    if (!deniedRes.ok) {
      expect(deniedRes.error.code).toBe('AUTH_FORBIDDEN');
      assertChineseAppError(deniedRes.error);
    }

    // 无麦克风降级
    adapter.failMode = 'no-device';
    const noDevRes = await tStore.getState().start(targets);
    expect(noDevRes.ok).toBe(false);
    if (!noDevRes.ok) {
      expect(noDevRes.error.code).toBe('RESOURCE_NOT_FOUND');
      assertChineseAppError(noDevRes.error);
    }
  });

  it('OmrProvider 服务成功转谱并自动存入原谱开启对照，离线/未配置时返回清晰中文引导', async () => {
    const legacy = new StorageAdapter({
      storage: new MemoryStorage(),
      namespace: 'nb_v23_omr_svc',
    });
    const repo = new InMemoryLibraryRepository();
    const sStore = createScoreStore({
      storage: legacy,
      config: { enableDemoMode: false, defaultBpm: 90 },
      autoSaveDelayMs: 0,
    });
    const wStore = createWorkspaceStore();
    const iStore = createInputStore();
    const nStore = createNotationStore();
    let seq = 1;
    const lib = createLibraryStore({
      repository: repo,
      legacyStorage: legacy,
      scoreStore: sStore,
      workspaceStore: wStore,
      inputStore: iStore,
      notationStore: nStore,
      idGenerator: (p) => `${p}_${seq++}`,
      now: () => 1732500000000 + seq,
    });
    await lib.getState().initialize();

    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const fileInput = {
      name: 'sheet-sample.png',
      mimeType: 'image/png',
      data: pngBytes,
    };

    // 1. 离线健康检查与离线转谱失败提示
    const offlineFetch: typeof fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const offlineHealth = await checkOmrProviderHealth(
      { providerType: 'local-bridge', endpointUrl: 'http://127.0.0.1:8765' },
      offlineFetch
    );
    expect(offlineHealth.available).toBe(false);
    expect(offlineHealth.message).toContain('原谱对照');

    const offlineRec = await recognizeScoreWithOmrAndAttachReference(
      fileInput,
      { providerType: 'local-bridge', endpointUrl: 'http://127.0.0.1:8765' },
      {
        libraryStore: lib,
        scoreStore: sStore,
        notationStore: nStore,
        workspaceStore: wStore,
        fetchFn: offlineFetch,
      }
    );
    expect(offlineRec.ok).toBe(false);
    if (!offlineRec.ok) {
      assertChineseAppError(offlineRec.error);
    }

    // 2. 在线 OMR 识别成功 -> 自动写入乐谱库并把原图存 IndexedDB 开启「原谱对照」
    const onlineFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/health')) {
        return new Response(
          JSON.stringify({ available: true, engineVersion: 'Audiveris-5.3' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(SAMPLE_MUSICXML, {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.recordare.musicxml+xml' },
      });
    };

    const healthOk = await checkOmrProviderHealth(
      { providerType: 'local-bridge', endpointUrl: 'http://127.0.0.1:8765' },
      onlineFetch
    );
    expect(healthOk.available).toBe(true);
    expect(healthOk.engineVersion).toBe('Audiveris-5.3');

    const okRes = await recognizeScoreWithOmrAndAttachReference(
      fileInput,
      { providerType: 'local-bridge', endpointUrl: 'http://127.0.0.1:8765' },
      {
        libraryStore: lib,
        scoreStore: sStore,
        notationStore: nStore,
        workspaceStore: wStore,
        fetchFn: onlineFetch,
      }
    );
    expect(okRes.ok).toBe(true);
    if (okRes.ok) {
      expect(okRes.value.score.title).toBe('OMR 识别乐谱示例');
      expect(nStore.getState().showReferencePanel).toBe(true);
      expect(nStore.getState().referenceSource?.name).toBe('sheet-sample.png');
      const loadedRef = await repo.getReferenceAttachment(okRes.value.reference.id);
      expect(loadedRef.ok).toBe(true);
    }

    // 3. 离线兜底：仅载入为原谱对照
    const refOnly = await loadFileAsReferenceOnly(fileInput, {
      libraryStore: lib,
      scoreStore: sStore,
      notationStore: nStore,
      workspaceStore: wStore,
    });
    expect(refOnly.ok).toBe(true);
    expect(nStore.getState().showReferencePanel).toBe(true);

    sStore.getState().dispose();
  });
});
