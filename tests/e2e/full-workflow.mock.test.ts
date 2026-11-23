import { describe, expect, it } from 'vitest';
import { createInputStore } from '../../src/application/input-store.ts';
import { createPlaybackController } from '../../src/application/playback-controller.ts';
import {
  createScoreStore,
  resolveScoreForView,
} from '../../src/application/score-store.ts';
import { msToTicks } from '../../src/domain/rhythm.ts';
import { MockAudioEngine } from '../../src/infrastructure/audio-engine.ts';
import {
  StorageAdapter,
  type StorageLike,
} from '../../src/infrastructure/storage-adapter.ts';
import { buildJianpuRenderModel } from '../../src/rendering/jianpu-renderer.ts';
import {
  computeScoreLayout,
  getCursorXForTick,
} from '../../src/rendering/layout-engine.ts';

class SharedMemoryStorage implements StorageLike {
  private readonly store = new Map<string, string>();
  public getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  public setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  public removeItem(key: string): void {
    this.store.delete(key);
  }
}

describe('L4 端到端模拟链路测试 - 完整业务闭环（路径 1-10）', () => {
  it('跑通路径 1-9：新建→改调/拍号/BPM→修饰录入预览→满拍切分与超拍修正→撤销/视图切换→播控/变速/起播→保存与重载恢复', async () => {
    const sharedMem = new SharedMemoryStorage();
    const storage = new StorageAdapter({
      storage: sharedMem,
      namespace: 'nb_e2e_v1',
    });
    const audioEngine = new MockAudioEngine({ lookaheadMs: 100 });
    const scoreStore = createScoreStore({
      storage,
      config: { enableDemoMode: false, defaultBpm: 90 },
      autoSaveDelayMs: 0,
    });
    const inputStore = createInputStore();
    const playback = createPlaybackController({
      scoreStore,
      inputStore,
      audioEngine,
    });

    // 路径 1：新建曲谱默认状态核验
    const newRes = scoreStore.getState().createNewScore({ title: 'E2E 闭环曲谱' });
    expect(newRes.ok).toBe(true);
    expect(scoreStore.getState().document.keySignature).toBe('C');
    expect(scoreStore.getState().document.timeSignature).toBe('4/4');
    expect(scoreStore.getState().document.bpm).toBe(90);
    expect(scoreStore.getState().document.viewMode).toBe('dual');
    expect(scoreStore.getState().documentState).toBe('CLEAN');

    // 路径 2：设定调号 1=G、拍号 4/4、速度 120 BPM
    expect(scoreStore.getState().setKeySignature('G').ok).toBe(true);
    expect(scoreStore.getState().setTimeSignature('4/4').ok).toBe(true);
    expect(scoreStore.getState().setBpm(120).ok).toBe(true);

    // 路径 3：选择修饰状态（八分音符 + # + 高八度 + 附点）录入并触发预览发声
    inputStore.getState().setBaseDuration('eighth');
    inputStore.getState().toggleAccidental('sharp');
    inputStore.getState().stepOctave(1);
    inputStore.getState().toggleDotted();
    expect(inputStore.getState().padState).toBe('MODIFIER_ARMED');

    const commit1 = inputStore.getState().commitNote();
    expect(commit1.ok).toBe(true);
    if (!commit1.ok) {
      return;
    }
    const ins1 = scoreStore.getState().insertNote({
      measureIndex: 0,
      isRest: false,
      degree: 1,
      ...commit1.value,
    });
    expect(ins1.ok).toBe(true);
    if (!ins1.ok) {
      return;
    }
    playback.previewNote(ins1.value.note);
    // 1=G 时 1 基准为 G4(67)，+1 八度(79)，# -> 80 (G#5)
    expect(audioEngine.previewedNotes[0]?.midiPitch).toBe(80);
    // 假设 A-06：临时修饰已复位，基础时值仍为 eighth
    expect(inputStore.getState().padState).toBe('READY');
    expect(inputStore.getState().accidental).toBeNull();
    expect(inputStore.getState().octaveOffset).toBe(0);
    expect(inputStore.getState().dotted).toBe(false);
    expect(inputStore.getState().baseDuration).toBe('eighth');

    // 验证双谱共享 LayoutSlot.x 0px 偏差对齐
    const docAfterFirst = scoreStore.getState().document;
    const resolvedAfterFirst = resolveScoreForView(docAfterFirst);
    const layoutAfterFirst = computeScoreLayout(docAfterFirst, resolvedAfterFirst);
    const jianpuModel = buildJianpuRenderModel(
      docAfterFirst,
      resolvedAfterFirst,
      layoutAfterFirst
    );
    expect(jianpuModel.measures[0]?.notes[0]?.x).toBe(
      layoutAfterFirst.slotByNoteId[ins1.value.note.id]?.x
    );

    // 路径 4：继续录入填满第 1 小节（已有 360 ticks，补 1 个十六分音符 120 + 3 个四分音符 1440 = 1920 ticks）
    inputStore.getState().setBaseDuration('sixteenth');
    const c2 = inputStore.getState().commitNote();
    if (c2.ok) {
      scoreStore.getState().insertNote({
        measureIndex: 0,
        isRest: false,
        degree: 2,
        ...c2.value,
      });
    }
    inputStore.getState().setBaseDuration('quarter');
    for (const deg of [3, 5, 6] as const) {
      const c = inputStore.getState().commitNote();
      if (c.ok) {
        const res = scoreStore.getState().insertNote({
          measureIndex: 0,
          isRest: false,
          degree: deg,
          ...c.value,
        });
        if (res.ok && deg === 6) {
          expect(res.value.measureStatus.state).toBe('VALID');
          expect(res.value.autoCreatedMeasure).toBe(true);
          inputStore.getState().setCursor(res.value.nextCursor);
        }
      }
    }
    expect(scoreStore.getState().document.measures).toHaveLength(2);

    // 第 2 小节故意超拍（全音符 + 四分音符 = 2400 > 1920）并删除修正
    scoreStore.getState().insertNote({
      measureIndex: 1,
      isRest: false,
      degree: 7,
      octaveOffset: 0,
      accidental: null,
      baseDuration: 'whole',
      dotted: false,
    });
    const overIns = scoreStore.getState().insertNote({
      measureIndex: 1,
      isRest: false,
      degree: 1,
      octaveOffset: 0,
      accidental: null,
      baseDuration: 'quarter',
      dotted: false,
    });
    expect(overIns.ok && overIns.value.measureStatus.state).toBe('OVERFLOW');
    expect(scoreStore.getState().measureStatuses[1]?.state).toBe('OVERFLOW');

    expect(scoreStore.getState().deleteNote(1, 1).ok).toBe(true);
    expect(scoreStore.getState().measureStatuses[1]?.state).toBe('VALID');

    // 路径 5 & 6：撤销/重做与视图三态无损切换
    expect(scoreStore.getState().undo().ok).toBe(true);
    expect(scoreStore.getState().measureStatuses[1]?.state).toBe('OVERFLOW');
    expect(scoreStore.getState().redo().ok).toBe(true);
    expect(scoreStore.getState().measureStatuses[1]?.state).toBe('VALID');

    const measureCountBeforeSwitch = scoreStore.getState().document.measures.length;
    expect(scoreStore.getState().setViewMode('jianpu').ok).toBe(true);
    expect(scoreStore.getState().setViewMode('staff').ok).toBe(true);
    expect(scoreStore.getState().setViewMode('dual').ok).toBe(true);
    expect(scoreStore.getState().document.measures).toHaveLength(
      measureCountBeforeSwitch
    );

    // 路径 7 & 8：开启节拍器 -> 播放 -> 锁定拦截 -> 时钟推进与游标高亮 -> 暂停 -> 继续 -> 实时变速 -> 指定小节起播 -> 停止
    playback.setMetronomeEnabled(true);
    expect((await playback.play()).ok).toBe(true);
    expect(playback.getSnapshot().playbackState).toBe('PLAYING');
    expect(inputStore.getState().padState).toBe('LOCKED_BY_PLAYBACK');
    expect(inputStore.getState().commitNote().ok).toBe(false);

    audioEngine.advanceTimeMs(500);
    const playDoc = scoreStore.getState().document;
    const playResolved = resolveScoreForView(playDoc);
    const playLayout = computeScoreLayout(playDoc, playResolved);
    const cursorPos = getCursorXForTick(
      playLayout,
      playResolved,
      msToTicks(playback.getCurrentPlaybackTimeMs(), playDoc.bpm)
    );
    expect(cursorPos.activeNoteId).not.toBeNull();
    expect(cursorPos.x).toBeGreaterThan(0);

    expect(playback.pause().ok).toBe(true);
    expect(playback.getSnapshot().playbackState).toBe('PAUSED');
    expect(playback.resume().ok).toBe(true);
    expect(playback.getSnapshot().playbackState).toBe('PLAYING');

    expect(playback.updateBpmLive(100).ok).toBe(true);
    expect(scoreStore.getState().document.bpm).toBe(100);

    expect((await playback.playFromMeasure(1)).ok).toBe(true);
    expect(playback.getSnapshot().startMeasureIndex).toBe(1);

    expect(playback.stop().ok).toBe(true);
    expect(playback.getSnapshot().playbackState).toBe('IDLE');
    expect(inputStore.getState().padState).toBe('READY');

    // 路径 9：本地保存与模拟刷新重载恢复
    const saveRes = scoreStore.getState().saveNow();
    expect(saveRes.ok).toBe(true);
    expect(scoreStore.getState().documentState).toBe('CLEAN');
    const savedSnapshot = structuredClone(scoreStore.getState().document);

    const reloadedStore = createScoreStore({
      storage: new StorageAdapter({
        storage: sharedMem,
        namespace: 'nb_e2e_v1',
      }),
      config: { enableDemoMode: false, defaultBpm: 90 },
      autoSaveDelayMs: 0,
    });
    const loadRes = reloadedStore.getState().loadLastOpened();
    expect(loadRes.ok).toBe(true);
    expect(reloadedStore.getState().document).toEqual(savedSnapshot);

    playback.dispose();
    scoreStore.getState().dispose();
    reloadedStore.getState().dispose();
  });

  it('路径 10：非生产演示模式载入《小星星》完成循环播放与变速闭环', async () => {
    const storage = new StorageAdapter({
      storage: new SharedMemoryStorage(),
      namespace: 'nb_e2e_demo',
    });
    const audioEngine = new MockAudioEngine();
    const demoStore = createScoreStore({
      storage,
      config: { enableDemoMode: true, defaultBpm: 90 },
      autoSaveDelayMs: 0,
    });
    const demoInput = createInputStore();
    const demoPlayback = createPlaybackController({
      scoreStore: demoStore,
      inputStore: demoInput,
      audioEngine,
    });

    expect(demoStore.getState().isDemoModeEnabled).toBe(true);
    const loadDemoRes = demoStore.getState().loadDemoScore();
    expect(loadDemoRes.ok).toBe(true);
    expect(demoStore.getState().document.measures).toHaveLength(12);

    demoPlayback.setLoop(true);
    expect((await demoPlayback.play()).ok).toBe(true);
    expect(audioEngine.scheduledNotes.length).toBeGreaterThanOrEqual(40);
    expect(demoPlayback.updateBpmLive(140).ok).toBe(true);
    expect(demoPlayback.completePlayback().ok).toBe(true);
    expect(demoPlayback.getSnapshot().playbackState).toBe('PLAYING');
    expect(demoPlayback.stop().ok).toBe(true);

    demoPlayback.dispose();
    demoStore.getState().dispose();
  });
});
