import { describe, expect, it } from 'vitest';
import { createInputStore } from '../../src/application/input-store.ts';
import { createLibraryStore } from '../../src/application/library-store.ts';
import { createScoreStore } from '../../src/application/score-store.ts';
import { createWorkspaceStore } from '../../src/application/workspace-store.ts';
import { calculateDurationTicks } from '../../src/domain/rhythm.ts';
import type { ScoreDocument } from '../../src/domain/types.ts';
import {
  InMemoryLibraryRepository,
  migrateLegacyLocalStorageToLibrary,
} from '../../src/infrastructure/indexeddb-adapter.ts';
import {
  StorageAdapter,
  type StorageLike,
} from '../../src/infrastructure/storage-adapter.ts';

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

function makeLegacyV1Doc(id: string, title: string): ScoreDocument {
  return {
    schemaVersion: 1,
    id,
    title,
    keySignature: 'G',
    timeSignature: '4/4',
    bpm: 96,
    viewMode: 'dual',
    updatedAtEpochMs: 1732300000123,
    measures: [
      {
        id: 'm1',
        index: 0,
        notes: [
          {
            id: 'n1',
            isRest: false,
            degree: 1,
            octaveOffset: 0,
            accidental: null,
            baseDuration: 'quarter',
            dotted: false,
            durationTicks: calculateDurationTicks('quarter', false),
          },
          {
            id: 'n2',
            isRest: false,
            degree: 5,
            octaveOffset: 0,
            accidental: null,
            baseDuration: 'quarter',
            dotted: false,
            durationTicks: calculateDurationTicks('quarter', false),
          },
        ],
      },
    ],
  };
}

describe('L2 V2.0 乐谱库、迁移、移调撤销与工作模式状态隔离服务测试', () => {
  it('migrateLegacyLocalStorageToLibrary 无损迁入旧 P0 乐谱且幂等不重复', async () => {
    const legacy = new StorageAdapter({
      storage: new MemoryStorage(),
      namespace: 'nb_v2_mig_test',
    });
    legacy.saveScore(makeLegacyV1Doc('legacy_1', '旧工程一'));
    legacy.saveScore(makeLegacyV1Doc('legacy_2', '旧工程二'));

    const repo = new InMemoryLibraryRepository();
    const first = await migrateLegacyLocalStorageToLibrary(legacy, repo);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value).toBe(2);
    }

    // 幂等重复执行不新增
    const second = await migrateLegacyLocalStorageToLibrary(legacy, repo);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value).toBe(0);
    }

    const listRes = await repo.listScores();
    expect(listRes.ok).toBe(true);
    if (listRes.ok) {
      expect(listRes.value.map((e) => e.id).sort()).toEqual([
        'legacy_1',
        'legacy_2',
      ]);
    }
    // 旧 localStorage 仍完好保留
    expect(legacy.loadScore('legacy_1').ok).toBe(true);
  });

  it('libraryStore 支持初始化、同步、复制、删除、打开曲谱与整库备份导入恢复', async () => {
    const legacy = new StorageAdapter({
      storage: new MemoryStorage(),
      namespace: 'nb_v2_lib_test',
    });
    const repo = new InMemoryLibraryRepository();
    const sStore = createScoreStore({
      storage: legacy,
      config: { enableDemoMode: false, defaultBpm: 90 },
      autoSaveDelayMs: 0,
    });
    const wStore = createWorkspaceStore();
    const iStore = createInputStore();

    let seq = 1;
    const lib = createLibraryStore({
      repository: repo,
      legacyStorage: legacy,
      scoreStore: sStore,
      workspaceStore: wStore,
      inputStore: iStore,
      idGenerator: (prefix) => `${prefix}_${seq++}`,
      now: () => 1732300100000 + seq,
    });

    const initRes = await lib.getState().initialize();
    expect(initRes.ok).toBe(true);

    // 新建并打开曲谱
    const createRes = await lib.getState().createAndOpenNewScore('电吉他练琴曲');
    expect(createRes.ok).toBe(true);
    expect(lib.getState().entries).toHaveLength(1);
    const createdId = lib.getState().entries[0]!.id;

    // 录入一个音符并同步回乐谱库
    sStore.getState().insertNote({
      measureIndex: 0,
      isRest: false,
      degree: 5,
      octaveOffset: 0,
      accidental: null,
      baseDuration: 'quarter',
      dotted: false,
    });
    await lib.getState().syncScoreToLibrary(sStore.getState().document, {
      composer: '音桥',
    });
    expect(lib.getState().entries[0]?.thumbnailSvg).toContain('<svg');

    // 复制曲谱
    const dupRes = await lib.getState().duplicateScore(createdId);
    expect(dupRes.ok).toBe(true);
    expect(lib.getState().entries).toHaveLength(2);

    // 导出整库备份
    const backupRes = await lib.getState().exportAllBackupJson();
    expect(backupRes.ok).toBe(true);
    if (!backupRes.ok) {
      return;
    }

    // 删除全部后从备份恢复
    for (const item of [...lib.getState().entries]) {
      await lib.getState().deleteScore(item.id);
    }
    expect(lib.getState().entries).toHaveLength(0);

    const importRes = await lib.getState().importBackupJson(backupRes.value);
    expect(importRes.ok).toBe(true);
    if (importRes.ok) {
      expect(importRes.value).toBe(2);
    }
    expect(lib.getState().entries).toHaveLength(2);

    // 以练谱模式打开曲谱
    const openRes = await lib.getState().openScore(createdId, 'practice');
    expect(openRes.ok).toBe(true);
    expect(wStore.getState().activePage).toBe('studio');
    expect(wStore.getState().workMode).toBe('practice');
    expect(wStore.getState().activeMeta.composer).toBe('音桥');

    sStore.getState().dispose();
  });

  it('scoreStore.transposeScore 支持撤销/重做，workspaceStore 模式切换不污染保存状态', () => {
    const legacy = new StorageAdapter({
      storage: new MemoryStorage(),
      namespace: 'nb_v2_transpose_store',
    });
    const sStore = createScoreStore({
      storage: legacy,
      config: { enableDemoMode: false, defaultBpm: 90 },
      autoSaveDelayMs: 0,
    });
    const wStore = createWorkspaceStore();

    sStore.getState().createNewScore({ title: '移调测试' });
    sStore.getState().insertNote({
      measureIndex: 0,
      isRest: false,
      degree: 1,
      octaveOffset: 0,
      accidental: null,
      baseDuration: 'quarter',
      dotted: false,
    });
    sStore.getState().saveNow();
    expect(sStore.getState().documentState).toBe('CLEAN');

    // 切换工作模式绝不把文档标成 DIRTY
    wStore.getState().setWorkMode('practice');
    expect(sStore.getState().documentState).toBe('CLEAN');
    wStore.getState().setWorkMode('studio');
    expect(sStore.getState().documentState).toBe('CLEAN');

    // 执行一键移调并验证撤销/重做
    const tRes = sStore.getState().transposeScore({
      strategy: 'movable-do',
      targetKey: 'G',
    });
    expect(tRes.ok).toBe(true);
    expect(sStore.getState().document.keySignature).toBe('G');
    expect(sStore.getState().canUndo).toBe(true);

    const undoRes = sStore.getState().undo();
    expect(undoRes.ok).toBe(true);
    expect(sStore.getState().document.keySignature).toBe('C');

    const redoRes = sStore.getState().redo();
    expect(redoRes.ok).toBe(true);
    expect(sStore.getState().document.keySignature).toBe('G');

    sStore.getState().dispose();
  });
});
