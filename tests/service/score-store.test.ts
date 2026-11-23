import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScoreStore } from '../../src/application/score-store.ts';
import {
  StorageAdapter,
  type StorageLike,
} from '../../src/infrastructure/storage-adapter.ts';

class MemoryStorage implements StorageLike {
  public readonly map = new Map<string, string>();
  public throwQuotaOnSet = false;

  public getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    if (this.throwQuotaOnSet) {
      const err = new Error('QuotaExceededError');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.map.set(key, value);
  }

  public removeItem(key: string): void {
    this.map.delete(key);
  }
}

describe('L2 服务层测试 - score-store', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('新建曲谱默认 1=C、4/4、90 BPM、dual 且支持参数校验与视图无损切换', () => {
    const mem = new MemoryStorage();
    const storage = new StorageAdapter({ storage: mem, namespace: 'nb_l2_1' });
    const store = createScoreStore({
      storage,
      config: { enableDemoMode: false, defaultBpm: 90 },
      autoSaveDelayMs: 0,
    });

    const initial = store.getState();
    expect(initial.document.keySignature).toBe('C');
    expect(initial.document.timeSignature).toBe('4/4');
    expect(initial.document.bpm).toBe(90);
    expect(initial.document.viewMode).toBe('dual');
    expect(initial.document.measures).toHaveLength(1);
    expect(initial.documentState).toBe('CLEAN');
    expect(initial.measureStatuses[0]?.state).toBe('EMPTY');

    expect(store.getState().setKeySignature('G').ok).toBe(true);
    expect(store.getState().setTimeSignature('3/4').ok).toBe(true);
    expect(store.getState().setBpm(120).ok).toBe(true);
    expect(store.getState().documentState).toBe('DIRTY');

    const badKey = store.getState().setKeySignature('H#' as never);
    expect(badKey.ok).toBe(false);
    if (!badKey.ok) {
      expect(badKey.error.code).toBe('SCORE_INVALID_KEY_SIGNATURE');
    }

    const badTime = store.getState().setTimeSignature('5/4' as never);
    expect(badTime.ok).toBe(false);
    if (!badTime.ok) {
      expect(badTime.error.code).toBe('SCORE_INVALID_TIME_SIGNATURE');
    }

    const badBpm = store.getState().setBpm(250);
    expect(badBpm.ok).toBe(false);
    if (!badBpm.ok) {
      expect(badBpm.error.code).toBe('SCORE_INVALID_BPM');
    }

    // 视图切换不修改小节数据也不压入 Undo 栈
    const pastLenBefore = store.getState().past.length;
    expect(store.getState().setViewMode('jianpu').ok).toBe(true);
    expect(store.getState().document.viewMode).toBe('jianpu');
    expect(store.getState().past.length).toBe(pastLenBefore);
    expect(store.getState().setViewMode('staff').ok).toBe(true);
    expect(store.getState().document.viewMode).toBe('staff');

    store.getState().dispose();
  });

  it('小节满拍（VALID）自动开启下一小节，超拍（OVERFLOW）不阻断且可删改修正（A-07）', () => {
    const mem = new MemoryStorage();
    const storage = new StorageAdapter({ storage: mem, namespace: 'nb_l2_2' });
    const store = createScoreStore({
      storage,
      config: { enableDemoMode: false, defaultBpm: 90 },
      autoSaveDelayMs: 0,
    });

    // 4/4 拍录入 4 个四分音符
    for (let i = 0; i < 3; i += 1) {
      const res = store.getState().insertNote({
        measureIndex: 0,
        isRest: false,
        degree: (i + 1) as 1 | 2 | 3,
        octaveOffset: 0,
        accidental: null,
        baseDuration: 'quarter',
        dotted: false,
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value.measureStatus.state).toBe('UNDERFLOW');
        expect(res.value.autoCreatedMeasure).toBe(false);
      }
    }

    const fourthRes = store.getState().insertNote({
      measureIndex: 0,
      isRest: false,
      degree: 5,
      octaveOffset: 0,
      accidental: null,
      baseDuration: 'quarter',
      dotted: false,
    });
    expect(fourthRes.ok).toBe(true);
    if (fourthRes.ok) {
      expect(fourthRes.value.measureStatus.state).toBe('VALID');
      expect(fourthRes.value.autoCreatedMeasure).toBe(true);
      expect(fourthRes.value.nextCursor).toEqual({
        measureIndex: 1,
        noteIndex: 0,
      });
    }
    expect(store.getState().document.measures).toHaveLength(2);

    // 第 2 小节故意录 2 个全音符触发 OVERFLOW（不阻断）
    store.getState().insertNote({
      measureIndex: 1,
      isRest: false,
      degree: 1,
      octaveOffset: 0,
      accidental: null,
      baseDuration: 'whole',
      dotted: false,
    });
    const overRes = store.getState().insertNote({
      measureIndex: 1,
      isRest: false,
      degree: 2,
      octaveOffset: 0,
      accidental: null,
      baseDuration: 'quarter',
      dotted: false,
    });
    expect(overRes.ok).toBe(true);
    if (overRes.ok) {
      expect(overRes.value.measureStatus.state).toBe('OVERFLOW');
    }
    expect(store.getState().measureStatuses[1]?.state).toBe('OVERFLOW');

    // 删除超拍音符后恢复 VALID
    const delRes = store.getState().deleteNote(1, 1);
    expect(delRes.ok).toBe(true);
    expect(store.getState().measureStatuses[1]?.state).toBe('VALID');

    // 插入小节线拆分子音符
    const splitRes = store.getState().insertMeasureBar(0, 2);
    expect(splitRes.ok).toBe(true);
    expect(store.getState().document.measures).toHaveLength(4);
    expect(store.getState().document.measures[0]?.notes).toHaveLength(2);
    expect(store.getState().document.measures[1]?.notes).toHaveLength(2);

    store.getState().dispose();
  });

  it('支持 Undo/Redo 历史栈、空栈拦截、音符更新与休止符约束', () => {
    const store = createScoreStore({
      storage: new StorageAdapter({ storage: new MemoryStorage() }),
      config: { enableDemoMode: false, defaultBpm: 90 },
      autoSaveDelayMs: 0,
    });

    const emptyUndo = store.getState().undo();
    expect(emptyUndo.ok).toBe(false);
    if (!emptyUndo.ok) {
      expect(emptyUndo.error.code).toBe('STATE_INVALID_TRANSITION');
    }

    store.getState().insertNote({
      measureIndex: 0,
      isRest: false,
      degree: 3,
      octaveOffset: 0,
      accidental: null,
      baseDuration: 'quarter',
      dotted: false,
    });
    expect(store.getState().canUndo).toBe(true);
    expect(store.getState().document.measures[0]?.notes).toHaveLength(1);

    const updateRes = store.getState().updateNote(0, 0, {
      degree: 5,
      baseDuration: 'half',
      dotted: true,
    });
    expect(updateRes.ok).toBe(true);
    if (updateRes.ok) {
      expect(updateRes.value.durationTicks).toBe(1440);
    }

    expect(store.getState().undo().ok).toBe(true);
    expect(store.getState().document.measures[0]?.notes[0]?.degree).toBe(3);
    expect(store.getState().canRedo).toBe(true);

    expect(store.getState().redo().ok).toBe(true);
    expect(store.getState().document.measures[0]?.notes[0]?.degree).toBe(5);

    store.getState().dispose();
  });

  it('支持防抖自动保存、配额异常 SAVE_FAILED、损坏降级恢复与受控演示模式', () => {
    vi.useFakeTimers();
    const mem = new MemoryStorage();
    const storage = new StorageAdapter({ storage: mem, namespace: 'nb_l2_4' });
    const store = createScoreStore({
      storage,
      config: { enableDemoMode: true, defaultBpm: 90 },
      autoSaveDelayMs: 500,
    });

    store.getState().setTitle('自动保存曲谱');
    expect(store.getState().documentState).toBe('DIRTY');

    vi.advanceTimersByTime(500);
    expect(store.getState().documentState).toBe('CLEAN');
    expect(store.getState().lastSavedAtEpochMs).not.toBeNull();

    // 模拟配额超限
    mem.throwQuotaOnSet = true;
    store.getState().setBpm(100);
    const failedSave = store.getState().saveNow();
    expect(failedSave.ok).toBe(false);
    if (!failedSave.ok) {
      expect(failedSave.error.code).toBe('STORAGE_QUOTA_EXCEEDED');
    }
    expect(store.getState().documentState).toBe('SAVE_FAILED');
    mem.throwQuotaOnSet = false;

    // 模拟损坏数据降级恢复（保留当前合法工程，不崩溃）
    mem.setItem('nb_l2_4:last_opened_id', 'corrupt_id');
    mem.setItem('nb_l2_4:score:corrupt_id', '{corrupted');
    const corruptLoad = store.getState().loadLastOpened();
    expect(corruptLoad.ok).toBe(false);
    if (!corruptLoad.ok) {
      expect(corruptLoad.error.code).toBe('STORAGE_SCHEMA_CORRUPTED');
    }
    expect(store.getState().document.measures.length).toBeGreaterThanOrEqual(1);

    // 演示模式载入《小星星》
    const demoRes = store.getState().loadDemoScore();
    expect(demoRes.ok).toBe(true);
    if (demoRes.ok) {
      expect(demoRes.value.measures).toHaveLength(12);
    }

    // 非演示模式禁止载入
    const nonDemoStore = createScoreStore({
      storage,
      config: { enableDemoMode: false, defaultBpm: 90 },
      autoSaveDelayMs: 0,
    });
    const blockedDemo = nonDemoStore.getState().loadDemoScore();
    expect(blockedDemo.ok).toBe(false);
    if (!blockedDemo.ok) {
      expect(blockedDemo.error.code).toBe('CONFIG_INVALID');
    }

    store.getState().dispose();
    nonDemoStore.getState().dispose();
  });
});
