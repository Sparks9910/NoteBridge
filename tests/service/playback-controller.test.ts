import { describe, expect, it } from 'vitest';
import { createInputStore } from '../../src/application/input-store.ts';
import { createPlaybackController } from '../../src/application/playback-controller.ts';
import { createScoreStore } from '../../src/application/score-store.ts';
import { MockAudioEngine } from '../../src/infrastructure/audio-engine.ts';
import { StorageAdapter, type StorageLike } from '../../src/infrastructure/storage-adapter.ts';

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

function setupHarness(engineOptions?: { failUnlock?: boolean; failLoad?: boolean }) {
  const storage = new StorageAdapter({ storage: new MemStorage() });
  const scoreStore = createScoreStore({
    storage,
    config: { enableDemoMode: true, defaultBpm: 120 },
    autoSaveDelayMs: 0,
  });
  const inputStore = createInputStore();
  const audioEngine = new MockAudioEngine(engineOptions);
  const controller = createPlaybackController({
    scoreStore,
    inputStore,
    audioEngine,
  });

  // 录入 2 个小节（每小节 4 个四分音符，120 BPM 下每拍 500ms）
  const degrees: Array<1 | 2 | 3 | 4 | 5 | 6 | 7> = [1, 2, 3, 4, 5, 6, 7, 1];
  for (let i = 0; i < degrees.length; i += 1) {
    const mIdx = Math.floor(i / 4);
    const deg = degrees[i] ?? 1;
    scoreStore.getState().insertNote({
      measureIndex: mIdx,
      isRest: false,
      degree: deg,
      octaveOffset: 0,
      accidental: null,
      baseDuration: 'quarter',
      dotted: false,
    });
  }

  return { scoreStore, inputStore, audioEngine, controller };
}

describe('L2 服务层测试 - playback-controller', () => {
  it('播放生命周期状态流转、联动输入面板锁定解锁及非法操作拦截', async () => {
    const { scoreStore, inputStore, audioEngine, controller } = setupHarness();

    // IDLE 下不允许 pause / resume
    const badPause = controller.pause();
    expect(badPause.ok).toBe(false);
    if (!badPause.ok) {
      expect(badPause.error.code).toBe('STATE_INVALID_TRANSITION');
    }

    controller.setMetronomeEnabled(true);
    const playRes = await controller.play();
    expect(playRes.ok).toBe(true);
    expect(controller.getSnapshot().playbackState).toBe('PLAYING');
    expect(inputStore.getState().padState).toBe('LOCKED_BY_PLAYBACK');
    expect(audioEngine.scheduledNotes).toHaveLength(8);
    expect(audioEngine.scheduledMetronomeTicks).toHaveLength(8);
    expect(audioEngine.scheduledMetronomeTicks[0]?.isAccent).toBe(true);
    expect(audioEngine.scheduledMetronomeTicks[1]?.isAccent).toBe(false);

    // 推进 Mock 时钟 500ms（120 BPM = 1 拍 = 480 ticks）
    audioEngine.advanceTimeMs(500);
    expect(controller.getCurrentScoreTick()).toBeCloseTo(480, 1);

    // 暂停 -> 保持锁定
    expect(controller.pause().ok).toBe(true);
    expect(controller.getSnapshot().playbackState).toBe('PAUSED');
    expect(inputStore.getState().padState).toBe('LOCKED_BY_PLAYBACK');

    // 继续 -> 从暂停 Tick 重调度剩余 7 个音符
    audioEngine.stopAll();
    expect(controller.resume().ok).toBe(true);
    expect(controller.getSnapshot().playbackState).toBe('PLAYING');
    expect(audioEngine.scheduledNotes).toHaveLength(7);

    // 播放中实时变速 120 -> 60 BPM，同步更新 scoreStore
    expect(controller.updateBpmLive(60).ok).toBe(true);
    expect(scoreStore.getState().document.bpm).toBe(60);
    expect(controller.getSnapshot().currentBpm).toBe(60);

    // 非法 BPM 拦截
    const badBpm = controller.updateBpmLive(300);
    expect(badBpm.ok).toBe(false);
    if (!badBpm.ok) {
      expect(badBpm.error.code).toBe('SCORE_INVALID_BPM');
    }

    // 停止 -> IDLE 且解锁输入面板
    expect(controller.stop().ok).toBe(true);
    expect(controller.getSnapshot().playbackState).toBe('IDLE');
    expect(inputStore.getState().padState).toBe('READY');

    controller.dispose();
    scoreStore.getState().dispose();
  });

  it('支持指定小节起播、循环播放与音频解锁/加载失败恢复', async () => {
    const { scoreStore, inputStore, audioEngine, controller } = setupHarness();

    // 从第 2 小节（index = 1）起播
    const m2Res = await controller.playFromMeasure(1);
    expect(m2Res.ok).toBe(true);
    expect(audioEngine.scheduledNotes).toHaveLength(4);
    expect(controller.getCurrentScoreTick()).toBeCloseTo(1920, 1);

    // 循环模式下 PLAY_COMPLETE 保持 PLAYING 并重调度
    controller.setLoop(true);
    const completeLoopRes = controller.completePlayback();
    expect(completeLoopRes.ok).toBe(true);
    expect(controller.getSnapshot().playbackState).toBe('PLAYING');
    expect(audioEngine.scheduledNotes).toHaveLength(4);

    // 非循环模式下 PLAY_COMPLETE 回到 IDLE 并解锁
    controller.setLoop(false);
    const completeStopRes = controller.completePlayback();
    expect(completeStopRes.ok).toBe(true);
    expect(controller.getSnapshot().playbackState).toBe('IDLE');
    expect(inputStore.getState().padState).toBe('READY');

    // 越界小节起播拦截
    const missingMeasure = await controller.playFromMeasure(99);
    expect(missingMeasure.ok).toBe(false);
    if (!missingMeasure.ok) {
      expect(missingMeasure.error.code).toBe('SCORE_MEASURE_NOT_FOUND');
    }

    controller.dispose();
    scoreStore.getState().dispose();

    // 解锁失败 -> ERROR 并可 resetError 恢复
    const failHarness = setupHarness({ failUnlock: true });
    const failRes = await failHarness.controller.play();
    expect(failRes.ok).toBe(false);
    if (!failRes.ok) {
      expect(failRes.error.code).toBe('AUDIO_CONTEXT_BLOCKED');
    }
    expect(failHarness.controller.getSnapshot().playbackState).toBe('ERROR');
    expect(failHarness.inputStore.getState().padState).toBe('READY');

    expect(failHarness.controller.resetError().ok).toBe(true);
    expect(failHarness.controller.getSnapshot().playbackState).toBe('IDLE');

    failHarness.controller.dispose();
    failHarness.scoreStore.getState().dispose();
  });
});
