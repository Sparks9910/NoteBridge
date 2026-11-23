import { describe, expect, it } from 'vitest';
import { createInputStore } from '../../src/application/input-store.ts';
import { createNotationStore } from '../../src/application/notation-store.ts';
import { createPlaybackController } from '../../src/application/playback-controller.ts';
import { createPracticeStore } from '../../src/application/practice-store.ts';
import { createScoreStore } from '../../src/application/score-store.ts';
import { MockAudioEngine } from '../../src/infrastructure/audio-engine.ts';
import {
  StorageAdapter,
  type StorageLike,
} from '../../src/infrastructure/storage-adapter.ts';

class MemStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  public getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  public setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  public removeItem(k: string) {
    this.map.delete(k);
  }
}

function createHarness(measureCount = 3, bpm = 120) {
  const storage = new StorageAdapter({ storage: new MemStorage() });
  const scoreStore = createScoreStore({
    storage,
    config: { enableDemoMode: false, defaultBpm: bpm },
    autoSaveDelayMs: 0,
  });
  scoreStore.getState().createNewScore({ title: '练谱引擎测试曲目' });
  scoreStore.getState().setBpm(bpm);

  const inputStore = createInputStore();
  const notationStore = createNotationStore();
  const practiceStore = createPracticeStore();
  const audioEngine = new MockAudioEngine({ lookaheadMs: 100 });
  const controller = createPlaybackController({
    scoreStore,
    inputStore,
    notationStore,
    practiceStore,
    audioEngine,
  });

  // 每小节 4 个四分音符
  for (let m = 0; m < measureCount; m += 1) {
    for (let b = 0; b < 4; b += 1) {
      scoreStore.getState().insertNote({
        measureIndex: m,
        isRest: false,
        degree: (((m + b) % 7) + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7,
        octaveOffset: 0,
        accidental: null,
        baseDuration: 'quarter',
        dotted: false,
      });
    }
  }
  scoreStore.getState().saveNow();

  return {
    scoreStore,
    inputStore,
    notationStore,
    practiceStore,
    audioEngine,
    controller,
  };
}

describe('L2 服务层测试 - V2.2 练谱状态隔离与通用练琴控制引擎', () => {
  it('切换乐器、音色、调弦、变调夹与练琴参数不标脏文档（CLEAN 保持不变）', () => {
    const { scoreStore, practiceStore, controller, audioEngine } =
      createHarness(2, 100);
    expect(scoreStore.getState().documentState).toBe('CLEAN');

    practiceStore.getState().selectInstrument('electric-guitar-clean');
    controller.setInstrument(practiceStore.getState().selectedInstrumentId);
    expect(audioEngine.currentInstrumentId).toBe('electric-guitar-clean');
    expect(practiceStore.getState().practiceViews).toEqual({
      staff: true,
      jianpu: false,
      tab: true,
    });

    practiceStore.getState().setGuitarTone('overdrive');
    controller.setInstrument(practiceStore.getState().selectedInstrumentId);
    expect(audioEngine.currentInstrumentId).toBe('electric-guitar-od');

    practiceStore.getState().setTuningPreset('drop-d-6');
    practiceStore.getState().setCapo(3);
    practiceStore.getState().setManualFretPosition('n1', { string: 2, fret: 5 });
    practiceStore.getState().setAbLoopEnabled(true);
    practiceStore.getState().setLoopRange(0, 1, 2);
    practiceStore.getState().setCountInEnabled(true);
    practiceStore.getState().setSpeedTrainerEnabled(true);
    practiceStore.getState().setSpeedTrainerConfig({
      startPercent: 70,
      stepPercent: 10,
      targetPercent: 100,
    });
    practiceStore.getState().setAutoScrollEnabled(false);

    expect(scoreStore.getState().documentState).toBe('CLEAN');

    controller.previewMidi(64, 250);
    expect(audioEngine.previewedNotes.at(-1)).toEqual({
      midiPitch: 64,
      durationMs: 250,
    });

    controller.dispose();
    scoreStore.getState().dispose();
  });

  it('A-B 区间循环精确调度选定小节且无缝回绕', async () => {
    const { scoreStore, practiceStore, audioEngine, controller } =
      createHarness(3, 120);

    practiceStore.getState().setAbLoopEnabled(true);
    practiceStore.getState().setLoopRange(1, 1, 3); // 仅第 2 小节

    const res = await controller.play();
    expect(res.ok).toBe(true);
    expect(controller.getSnapshot().startMeasureIndex).toBe(1);
    expect(audioEngine.scheduledNotes).toHaveLength(4);
    expect(controller.getCurrentScoreTick()).toBeCloseTo(1920, 1);

    // 推进 500ms（1 拍）-> 1920 + 480 = 2400 ticks
    audioEngine.advanceTimeMs(500);
    expect(controller.getCurrentScoreTick()).toBeCloseTo(2400, 1);

    // 触发结束回绕 -> 保持 PLAYING 并重调度第 2 小节 4 音符
    audioEngine.stopAll();
    const wrap = controller.completePlayback();
    expect(wrap.ok).toBe(true);
    expect(controller.getSnapshot().playbackState).toBe('PLAYING');
    expect(audioEngine.scheduledNotes).toHaveLength(4);

    expect(controller.stop().ok).toBe(true);
    controller.dispose();
    scoreStore.getState().dispose();
  });

  it('1 小节预备拍时序精准、循环不重复预备拍，且渐进提速不改 document.bpm', async () => {
    const { scoreStore, practiceStore, audioEngine, controller } =
      createHarness(2, 100);

    practiceStore.getState().setCountInEnabled(true);
    practiceStore.getState().setAbLoopEnabled(true);
    practiceStore.getState().setLoopRange(0, 0, 2);
    practiceStore.getState().setSpeedTrainerEnabled(true);
    practiceStore.getState().setSpeedTrainerConfig({
      startPercent: 60,
      stepPercent: 20,
      targetPercent: 100,
    });

    const playRes = await controller.play();
    expect(playRes.ok).toBe(true);

    // 100 BPM * 60% = 60 BPM -> 每拍 1000ms，4/4 预备拍 4 拍 = 4000ms
    expect(controller.getSnapshot().currentBpm).toBe(60);
    expect(controller.getSnapshot().activeSpeedPercent).toBe(60);
    expect(scoreStore.getState().document.bpm).toBe(100);
    expect(scoreStore.getState().documentState).toBe('CLEAN');

    expect(audioEngine.scheduledMetronomeTicks).toHaveLength(4);
    expect(audioEngine.scheduledNotes[0]?.startTimeMs).toBeCloseTo(4000, 1);
    expect(controller.getCountInBeat()).toBe(1);
    expect(controller.getCurrentScoreTick()).toBe(0);

    audioEngine.advanceTimeMs(1500);
    expect(controller.getCountInBeat()).toBe(2);
    expect(controller.getCurrentScoreTick()).toBe(0);

    audioEngine.advanceTimeMs(2600); // 4100ms，已进入正谱第 1 拍
    expect(controller.getCountInBeat()).toBeNull();
    expect(controller.getCurrentScoreTick()).toBeGreaterThan(0);

    // 第 1 次循环结束 -> 步进至 80% (80 BPM)，且无预备拍
    audioEngine.stopAll();
    controller.completePlayback();
    expect(controller.getSnapshot().currentBpm).toBe(80);
    expect(controller.getSnapshot().activeSpeedPercent).toBe(80);
    expect(audioEngine.scheduledMetronomeTicks).toHaveLength(0);
    expect(audioEngine.scheduledNotes[0]?.startTimeMs).toBe(0);

    // 第 2 次循环结束 -> 步进至目标 100% (100 BPM)
    controller.completePlayback();
    expect(controller.getSnapshot().currentBpm).toBe(100);
    expect(practiceStore.getState().completedLoopCount).toBe(2);

    // 第 3 次循环结束 -> 封顶 100%
    controller.completePlayback();
    expect(controller.getSnapshot().currentBpm).toBe(100);
    expect(scoreStore.getState().document.bpm).toBe(100);

    controller.stop();
    controller.dispose();
    scoreStore.getState().dispose();
  });

  it('钢琴左右手单手静音分轨与小节跳转/回 A 点控制', async () => {
    const {
      scoreStore,
      notationStore,
      practiceStore,
      audioEngine,
      controller,
    } = createHarness(2, 120);

    const doc = scoreStore.getState().document;
    notationStore.getState().bindScoreId(doc.id);
    notationStore.getState().setClef('grand', 2);
    notationStore.getState().insertVoice2Note({
      measureIndex: 0,
      isRest: false,
      degree: 1,
      octaveOffset: -1,
      accidental: null,
      baseDuration: 'quarter',
      dotted: false,
      keySignature: 'C',
    });

    // 1) 静音右手 -> 仅调度 Voice 2 的 1 个低音音符
    practiceStore.getState().setMuteRightHand(true);
    practiceStore.getState().setMuteLeftHand(false);
    await controller.play();
    expect(audioEngine.scheduledNotes).toHaveLength(1);
    controller.stop();

    // 2) 静音左手 -> 仅调度 Voice 1 的 8 个音符
    practiceStore.getState().setMuteRightHand(false);
    practiceStore.getState().setMuteLeftHand(true);
    await controller.play();
    expect(audioEngine.scheduledNotes).toHaveLength(8);

    // 3) 跳至下一小节与回 A 点
    await controller.jumpMeasureBy(1);
    expect(controller.getSnapshot().startMeasureIndex).toBe(1);
    await controller.restartFromLoopStart();
    expect(controller.getSnapshot().startMeasureIndex).toBe(0);

    controller.stop();
    controller.dispose();
    scoreStore.getState().dispose();
  });
});
