import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createInputStore } from '../../src/application/input-store.ts';
import { createPlaybackController } from '../../src/application/playback-controller.ts';
import { createScoreStore } from '../../src/application/score-store.ts';
import { calculateDurationTicks } from '../../src/domain/rhythm.ts';
import {
  deserializeScoreDocument,
  serializeScoreDocument,
} from '../../src/domain/serializer.ts';
import { resolveScoreNotes } from '../../src/domain/theory.ts';
import type {
  Accidental,
  AppError,
  BaseDuration,
  KeySignature,
  Measure,
  NoteEvent,
  ScoreDocument,
  TimeSignature,
} from '../../src/domain/types.ts';
import { MockAudioEngine } from '../../src/infrastructure/audio-engine.ts';
import { ConfigError, loadConfig } from '../../src/infrastructure/config.ts';
import {
  StorageAdapter,
  type StorageLike,
} from '../../src/infrastructure/storage-adapter.ts';
import { buildJianpuRenderModel } from '../../src/rendering/jianpu-renderer.ts';
import { computeScoreLayout } from '../../src/rendering/layout-engine.ts';

class InMemoryStorage implements StorageLike {
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

class QuotaExceededStorage implements StorageLike {
  public getItem(): string | null {
    return null;
  }
  public setItem(): void {
    const err = new Error('QuotaExceededError') as Error & { code: number };
    err.name = 'QuotaExceededError';
    err.code = 22;
    throw err;
  }
  public removeItem(): void {}
}

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENGLISH_STACK_OR_RAW_ERR_REGEX =
  /\b(Error|TypeError|ReferenceError|SyntaxError|RangeError|Exception|undefined|NaN|null|stack|QuotaExceededError)\b|\bat\s+\S+\s*\(/;

function assertSafeChineseError(err: AppError): void {
  expect(err.detail.trim().length).toBeGreaterThan(0);
  expect(err.detail).toMatch(/[\u4e00-\u9fa5]/);
  expect(err.detail).not.toMatch(ENGLISH_STACK_OR_RAW_ERR_REGEX);
  expect(err.request_id).toMatch(UUID_V4_REGEX);
}

function createLongScoreDocument(measureCount: number): {
  doc: ScoreDocument;
  totalNotes: number;
} {
  const degrees: ReadonlyArray<1 | 2 | 3 | 4 | 5 | 6 | 7> = [
    1, 2, 3, 4, 5, 6, 7,
  ];
  const accidentals: ReadonlyArray<Accidental> = [
    null,
    'sharp',
    null,
    'flat',
    'natural',
  ];
  const octaves: ReadonlyArray<-2 | -1 | 0 | 1 | 2> = [-2, -1, 0, 1, 2];

  const measures: Measure[] = [];
  let totalNotes = 0;

  for (let m = 0; m < measureCount; m += 1) {
    const notes: NoteEvent[] = [];
    // 每小节 5 个音符：2 个八分音符(连杠) + 1 个附点四分 + 1 个八分休止符 + 1 个四分音符 = 1920 ticks
    const specs: Array<{
      isRest: boolean;
      degree: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
      octaveOffset: -2 | -1 | 0 | 1 | 2;
      accidental: Accidental;
      baseDuration: BaseDuration;
      dotted: boolean;
    }> = [
      {
        isRest: false,
        degree: degrees[m % 7] ?? 1,
        octaveOffset: octaves[m % 5] ?? 0,
        accidental: accidentals[m % 5] ?? null,
        baseDuration: 'eighth',
        dotted: false,
      },
      {
        isRest: false,
        degree: degrees[(m + 1) % 7] ?? 2,
        octaveOffset: 0,
        accidental: null,
        baseDuration: 'eighth',
        dotted: false,
      },
      {
        isRest: false,
        degree: degrees[(m + 2) % 7] ?? 3,
        octaveOffset: octaves[(m + 2) % 5] ?? 0,
        accidental: accidentals[(m + 1) % 5] ?? null,
        baseDuration: 'quarter',
        dotted: true,
      },
      {
        isRest: true,
        degree: 0,
        octaveOffset: 0,
        accidental: null,
        baseDuration: 'eighth',
        dotted: false,
      },
      {
        isRest: false,
        degree: degrees[(m + 4) % 7] ?? 5,
        octaveOffset: 0,
        accidental: null,
        baseDuration: 'quarter',
        dotted: false,
      },
    ];

    for (let i = 0; i < specs.length; i += 1) {
      const spec = specs[i]!;
      notes.push({
        id: `n_${m}_${i}`,
        isRest: spec.isRest,
        degree: spec.degree,
        octaveOffset: spec.octaveOffset,
        accidental: spec.accidental,
        baseDuration: spec.baseDuration,
        dotted: spec.dotted,
        durationTicks: calculateDurationTicks(spec.baseDuration, spec.dotted),
      });
      totalNotes += 1;
    }

    measures.push({
      id: `m_${m}`,
      index: m,
      notes,
    });
  }

  return {
    doc: {
      schemaVersion: 1,
      id: 'long_score_100_measures',
      title: '100小节长谱性能压测工程',
      keySignature: 'G',
      timeSignature: '4/4',
      bpm: 120,
      viewMode: 'dual',
      measures,
      updatedAtEpochMs: 1700000000000,
    },
    totalNotes,
  };
}

describe('L6 非功能性能与安全验收测试', () => {
  it('100 小节（500 音符）长谱解析、共享布局、简谱模型、序列化与批量持久化性能达标', () => {
    const { doc, totalNotes } = createLongScoreDocument(100);
    expect(doc.measures).toHaveLength(100);
    expect(totalNotes).toBe(500);

    const t0 = performance.now();
    const resolvedNotes = resolveScoreNotes(doc);
    const resolveMs = performance.now() - t0;

    const t1 = performance.now();
    const layout = computeScoreLayout(doc, resolvedNotes, {
      containerWidth: 960,
    });
    const layoutMs = performance.now() - t1;

    const t2 = performance.now();
    const jianpuModel = buildJianpuRenderModel(doc, resolvedNotes, layout);
    const jianpuMs = performance.now() - t2;

    const t3 = performance.now();
    const serRes = serializeScoreDocument(doc);
    expect(serRes.ok).toBe(true);
    const deserRes = serRes.ok
      ? deserializeScoreDocument(serRes.value)
      : serRes;
    const roundtripMs = performance.now() - t3;

    const storage = new StorageAdapter({
      storage: new InMemoryStorage(),
      namespace: 'nb_l6_perf',
    });
    const store = createScoreStore({
      storage,
      config: { enableDemoMode: false, defaultBpm: 90 },
      autoSaveDelayMs: 0,
    });

    const t4 = performance.now();
    store.getState().createNewScore({ title: '批量录入长谱测试' });
    let currentMeasureIdx = 0;
    for (let i = 0; i < 100; i += 1) {
      const ins = store.getState().insertNote({
        measureIndex: currentMeasureIdx,
        isRest: false,
        degree: ((i % 7) + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7,
        octaveOffset: 0,
        accidental: null,
        baseDuration: 'quarter',
        dotted: false,
      });
      expect(ins.ok).toBe(true);
      if (ins.ok) {
        currentMeasureIdx = ins.value.nextCursor.measureIndex;
      }
    }
    const saveRes = store.getState().saveNow();
    const batchStoreMs = performance.now() - t4;

    console.log(
      `[L6-PERF] resolveScoreNotes(500 notes)=${resolveMs.toFixed(2)}ms | computeScoreLayout=${layoutMs.toFixed(2)}ms | buildJianpuRenderModel=${jianpuMs.toFixed(2)}ms | serializeRoundtrip=${roundtripMs.toFixed(2)}ms | batch100Insert+Save=${batchStoreMs.toFixed(2)}ms`
    );

    expect(resolveMs).toBeLessThan(500);
    expect(layoutMs).toBeLessThan(500);
    expect(jianpuMs).toBeLessThan(500);
    expect(roundtripMs).toBeLessThan(500);
    expect(batchStoreMs).toBeLessThan(1500);

    expect(resolvedNotes).toHaveLength(totalNotes);
    expect(layout.slots).toHaveLength(totalNotes);
    expect(jianpuModel.measures).toHaveLength(100);
    expect(deserRes.ok).toBe(true);
    if (deserRes.ok) {
      expect(deserRes.value).toEqual(doc);
    }

    for (const m of jianpuModel.measures) {
      for (const n of m.notes) {
        expect(n.x).toBe(layout.slotByNoteId[n.noteId]?.x);
      }
    }

    expect(saveRes.ok).toBe(true);
    expect(store.getState().documentState).toBe('CLEAN');
    store.getState().dispose();
  });

  it('高频连续录入 120 音符、50 次 Undo/Redo 与播放期高频调速/节拍器切换稳定性', async () => {
    const storage = new StorageAdapter({
      storage: new InMemoryStorage(),
      namespace: 'nb_l6_stability',
    });
    const scoreStore = createScoreStore({
      storage,
      config: { enableDemoMode: false, defaultBpm: 90 },
      autoSaveDelayMs: 0,
    });
    const inputStore = createInputStore();
    const audioEngine = new MockAudioEngine({ lookaheadMs: 100 });
    const playback = createPlaybackController({
      scoreStore,
      inputStore,
      audioEngine,
    });

    scoreStore.getState().createNewScore({ title: '高频稳定性测试' });

    const durations: BaseDuration[] = [
      'quarter',
      'eighth',
      'eighth',
      'quarter',
      'sixteenth',
      'sixteenth',
      'eighth',
    ];
    for (let i = 0; i < 120; i += 1) {
      const dur = durations[i % durations.length] ?? 'quarter';
      inputStore.getState().setBaseDuration(dur);
      if (i % 5 === 0) {
        inputStore.getState().toggleAccidental('sharp');
      }
      if (i % 7 === 0) {
        inputStore.getState().stepOctave(1);
      }
      if (i % 11 === 0) {
        inputStore.getState().toggleDotted();
      }
      const commit = inputStore.getState().commitNote();
      expect(commit.ok).toBe(true);
      if (!commit.ok) {
        return;
      }

      const cursor = inputStore.getState().cursor;
      const isRest = i % 9 === 0;
      const ins = scoreStore.getState().insertNote({
        measureIndex: cursor.measureIndex,
        noteIndex: cursor.noteIndex,
        isRest,
        degree: isRest ? 0 : (((i % 7) + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7),
        ...commit.value,
      });
      expect(ins.ok).toBe(true);
      if (ins.ok) {
        inputStore.getState().setCursor({
          measureIndex: ins.value.nextCursor.measureIndex,
          noteIndex: ins.value.nextCursor.noteIndex,
          selectedNoteId: null,
        });
      }
    }

    const afterInsertState = scoreStore.getState();
    expect(afterInsertState.past.length).toBeLessThanOrEqual(100);
    expect(afterInsertState.past.length).toBe(100);
    afterInsertState.document.measures.forEach((m, idx) => {
      expect(m.index).toBe(idx);
    });

    // 50 次 Undo/Redo 交替与连续回退恢复
    for (let i = 0; i < 25; i += 1) {
      const u = scoreStore.getState().undo();
      expect(u.ok).toBe(true);
    }
    for (let i = 0; i < 25; i += 1) {
      const r = scoreStore.getState().redo();
      expect(r.ok).toBe(true);
    }

    const afterHistoryState = scoreStore.getState();
    expect(afterHistoryState.measureStatuses).toHaveLength(
      afterHistoryState.document.measures.length
    );
    afterHistoryState.document.measures.forEach((m, idx) => {
      expect(m.index).toBe(idx);
    });

    // 播放期高频切换 40-200 BPM 与节拍器开关
    const playRes = await playback.play();
    expect(playRes.ok).toBe(true);
    expect(playback.getSnapshot().playbackState).toBe('PLAYING');
    expect(inputStore.getState().padState).toBe('LOCKED_BY_PLAYBACK');

    for (let i = 0; i < 40; i += 1) {
      const nextBpm = i % 2 === 0 ? 40 + (i * 4) : 200 - (i * 4);
      const boundedBpm = Math.max(40, Math.min(200, nextBpm));
      playback.setMetronomeEnabled(i % 2 === 0);
      const bpmRes = playback.updateBpmLive(boundedBpm);
      expect(bpmRes.ok).toBe(true);
      audioEngine.advanceTimeMs(50);
      expect(playback.getCurrentPlaybackTimeMs()).toBeGreaterThanOrEqual(0);
    }

    expect(playback.stop().ok).toBe(true);
    expect(playback.getSnapshot().playbackState).toBe('IDLE');
    expect(inputStore.getState().padState).toBe('READY');

    playback.dispose();
    scoreStore.getState().dispose();
  });

  it('全局中文错误安全扫描与表现层（src/ui/*、src/App.tsx）单向依赖静态扫描', () => {
    const storage = new StorageAdapter({
      storage: new InMemoryStorage(),
      namespace: 'nb_l6_safety',
    });
    const store = createScoreStore({
      storage,
      config: { enableDemoMode: false, defaultBpm: 90 },
      autoSaveDelayMs: 0,
    });
    const input = createInputStore();
    const audio = new MockAudioEngine();
    const playback = createPlaybackController({
      scoreStore: store,
      inputStore: input,
      audioEngine: audio,
    });

    // 1. 非法调号
    const badKey = store.getState().setKeySignature('H' as KeySignature);
    expect(badKey.ok).toBe(false);
    if (!badKey.ok) {
      expect(badKey.error.code).toBe('SCORE_INVALID_KEY_SIGNATURE');
      assertSafeChineseError(badKey.error);
    }

    // 2. 非法拍号
    const badTime = store.getState().setTimeSignature('5/4' as TimeSignature);
    expect(badTime.ok).toBe(false);
    if (!badTime.ok) {
      expect(badTime.error.code).toBe('SCORE_INVALID_TIME_SIGNATURE');
      assertSafeChineseError(badTime.error);
    }

    // 3. 非法 BPM
    for (const invalidBpm of [39, 201, 90.5]) {
      const badBpm = store.getState().setBpm(invalidBpm);
      expect(badBpm.ok).toBe(false);
      if (!badBpm.ok) {
        expect(badBpm.error.code).toBe('SCORE_INVALID_BPM');
        assertSafeChineseError(badBpm.error);
      }
    }

    // 4. 越界小节
    const badInsert = store.getState().insertNote({
      measureIndex: 99,
      isRest: false,
      degree: 1,
      octaveOffset: 0,
      accidental: null,
      baseDuration: 'quarter',
      dotted: false,
    });
    expect(badInsert.ok).toBe(false);
    if (!badInsert.ok) {
      expect(badInsert.error.code).toBe('SCORE_MEASURE_NOT_FOUND');
      assertSafeChineseError(badInsert.error);
    }

    const badDelete = store.getState().deleteNote(99, 0);
    expect(badDelete.ok).toBe(false);
    if (!badDelete.ok) {
      expect(badDelete.error.code).toBe('SCORE_MEASURE_NOT_FOUND');
      assertSafeChineseError(badDelete.error);
    }

    // 5. 锁定态误操作
    input.getState().lockForPlayback();
    const lockedMod = input.getState().toggleAccidental('sharp');
    expect(lockedMod.ok).toBe(false);
    if (!lockedMod.ok) {
      expect(lockedMod.error.code).toBe('STATE_INVALID_TRANSITION');
      assertSafeChineseError(lockedMod.error);
    }
    const lockedCommit = input.getState().commitNote();
    expect(lockedCommit.ok).toBe(false);
    if (!lockedCommit.ok) {
      expect(lockedCommit.error.code).toBe('STATE_INVALID_TRANSITION');
      assertSafeChineseError(lockedCommit.error);
    }
    input.getState().unlockFromPlayback();

    // 6. 播放态非法流转
    const badPause = playback.pause();
    expect(badPause.ok).toBe(false);
    if (!badPause.ok) {
      expect(badPause.error.code).toBe('STATE_INVALID_TRANSITION');
      assertSafeChineseError(badPause.error);
    }

    // 7. 存储配额超限
    const quotaAdapter = new StorageAdapter({
      storage: new QuotaExceededStorage(),
      namespace: 'nb_l6_quota',
    });
    const quotaSave = quotaAdapter.saveScore(store.getState().document);
    expect(quotaSave.ok).toBe(false);
    if (!quotaSave.ok) {
      expect(quotaSave.error.code).toBe('STORAGE_QUOTA_EXCEEDED');
      assertSafeChineseError(quotaSave.error);
    }

    // 8. 损坏 JSON / Schema
    const corrupt = deserializeScoreDocument('{bad json');
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) {
      expect(corrupt.error.code).toBe('STORAGE_SCHEMA_CORRUPTED');
      assertSafeChineseError(corrupt.error);
    }

    // 9. 非演示模式强载演示谱
    const badDemo = store.getState().loadDemoScore();
    expect(badDemo.ok).toBe(false);
    if (!badDemo.ok) {
      expect(badDemo.error.code).toBe('CONFIG_INVALID');
      assertSafeChineseError(badDemo.error);
    }

    // 10. 生产环境开启演示开关
    try {
      loadConfig({
        VITE_APP_ENV: 'production',
        VITE_ENABLE_DEMO_MODE: 'true',
      });
      expect.unreachable('生产环境开启演示开关必须抛出 ConfigError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const cfgErr = err as ConfigError;
      expect(cfgErr.appError.code).toBe('CONFIG_INVALID');
      assertSafeChineseError(cfgErr.appError);
    }

    playback.dispose();
    store.getState().dispose();

    // 静态扫描 src/ui/* 与 src/App.tsx 单向依赖规范
    const rootDir = resolve(import.meta.dirname, '..', '..');
    const uiDir = join(rootDir, 'src', 'ui');
    const uiFiles = readdirSync(uiDir)
      .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
      .map((f) => join(uiDir, f));
    const filesToScan = [...uiFiles, join(rootDir, 'src', 'App.tsx')];

    for (const filePath of filesToScan) {
      const content = readFileSync(filePath, 'utf8');
      expect(content).not.toMatch(/\blocalStorage\b/);
      expect(content).not.toMatch(/\bsessionStorage\b/);
      expect(content).not.toMatch(/from\s+['"]tone['"]/);
      expect(content).not.toMatch(/from\s+['"]smplr['"]/);
      expect(content).not.toMatch(/infrastructure\//);
      expect(content).not.toMatch(/new\s+AudioContext\b/);
    }
  });

  it('音频解锁失败与音源加载失败均返回中文 AppError（无英文堆栈）', async () => {
    const storage = new StorageAdapter({
      storage: new InMemoryStorage(),
      namespace: 'nb_l6_audio_err',
    });
    const store = createScoreStore({
      storage,
      config: { enableDemoMode: false, defaultBpm: 90 },
      autoSaveDelayMs: 0,
    });
    const input = createInputStore();

    const failUnlockPlayback = createPlaybackController({
      scoreStore: store,
      inputStore: input,
      audioEngine: new MockAudioEngine({ failUnlock: true }),
    });
    const res1 = await failUnlockPlayback.play();
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.error.code).toBe('AUDIO_CONTEXT_BLOCKED');
      assertSafeChineseError(res1.error);
    }
    failUnlockPlayback.dispose();

    const failLoadPlayback = createPlaybackController({
      scoreStore: store,
      inputStore: input,
      audioEngine: new MockAudioEngine({ failLoad: true }),
    });
    const res2 = await failLoadPlayback.play();
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.error.code).toBe('AUDIO_SOUNDFONT_LOAD_FAILED');
      assertSafeChineseError(res2.error);
    }
    failLoadPlayback.dispose();
    store.getState().dispose();
  });
});
