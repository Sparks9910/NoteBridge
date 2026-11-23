import { describe, expect, it } from 'vitest';
import { resolveScoreNotes } from '../../src/domain/theory.ts';
import type { ScoreDocument } from '../../src/domain/types.ts';
import {
  MockAudioEngine,
  msToSeconds,
} from '../../src/infrastructure/audio-engine.ts';
import {
  StorageAdapter,
  type StorageLike,
} from '../../src/infrastructure/storage-adapter.ts';
import { buildJianpuRenderModel } from '../../src/rendering/jianpu-renderer.ts';
import {
  computeScoreLayout,
  getCursorXForTick,
} from '../../src/rendering/layout-engine.ts';

function createSampleScore(): ScoreDocument {
  return {
    schemaVersion: 1,
    id: 'score-sample-1',
    title: '小星星片段',
    keySignature: 'C',
    timeSignature: '4/4',
    bpm: 120,
    viewMode: 'dual',
    updatedAtEpochMs: 1730000000000,
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
            durationTicks: 480,
          },
          {
            id: 'n2',
            isRest: false,
            degree: 1,
            octaveOffset: 0,
            accidental: null,
            baseDuration: 'quarter',
            dotted: false,
            durationTicks: 480,
          },
          {
            id: 'n3',
            isRest: false,
            degree: 5,
            octaveOffset: 0,
            accidental: null,
            baseDuration: 'quarter',
            dotted: false,
            durationTicks: 480,
          },
          {
            id: 'n4',
            isRest: false,
            degree: 5,
            octaveOffset: 0,
            accidental: null,
            baseDuration: 'quarter',
            dotted: false,
            durationTicks: 480,
          },
        ],
      },
      {
        id: 'm2',
        index: 1,
        notes: [
          {
            id: 'n5',
            isRest: false,
            degree: 6,
            octaveOffset: 0,
            accidental: null,
            baseDuration: 'quarter',
            dotted: false,
            durationTicks: 480,
          },
          {
            id: 'n6',
            isRest: false,
            degree: 6,
            octaveOffset: 0,
            accidental: null,
            baseDuration: 'quarter',
            dotted: false,
            durationTicks: 480,
          },
          {
            id: 'n7',
            isRest: false,
            degree: 5,
            octaveOffset: 0,
            accidental: null,
            baseDuration: 'half',
            dotted: false,
            durationTicks: 960,
          },
        ],
      },
    ],
  };
}

class MemoryStorage implements StorageLike {
  private readonly map = new Map<string, string>();
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

describe('layout-engine / jianpu-model / audio-engine / storage-adapter', () => {
  it('LayoutSlot 与简谱模型横坐标 0px 偏差对齐且游标随 Tick 单调推进', () => {
    const doc = createSampleScore();
    const resolved = resolveScoreNotes(doc);
    const layout = computeScoreLayout(doc, resolved, { containerWidth: 960 });

    expect(layout.slots).toHaveLength(7);
    for (let i = 1; i < layout.slots.length; i += 1) {
      const prev = layout.slots[i - 1];
      const curr = layout.slots[i];
      if (prev && curr) {
        expect(curr.x).toBeGreaterThan(prev.x);
      }
    }

    const jianpuModel = buildJianpuRenderModel(doc, resolved, layout);
    const jianpuNotes = jianpuModel.measures.flatMap((m) => m.notes);
    expect(jianpuNotes).toHaveLength(7);
    for (const jn of jianpuNotes) {
      expect(jn.x).toBe(layout.slotByNoteId[jn.noteId]?.x);
    }

    const c0 = getCursorXForTick(layout, resolved, 0);
    const c240 = getCursorXForTick(layout, resolved, 240);
    const c480 = getCursorXForTick(layout, resolved, 480);
    expect(c0.activeNoteId).toBe('n1');
    expect(c240.x).toBeGreaterThan(c0.x);
    expect(c480.activeNoteId).toBe('n2');
    expect(c480.x).toBeGreaterThan(c240.x);
  });

  it('MockAudioEngine 支持正常调度、时钟推进、故障注入与 msToSeconds 换算', async () => {
    expect(msToSeconds(100)).toBe(0.1);
    expect(msToSeconds(1500)).toBe(1.5);

    const okEngine = new MockAudioEngine({ lookaheadMs: 120 });
    expect(okEngine.lookaheadMs).toBe(120);
    expect((await okEngine.unlock()).ok).toBe(true);
    expect((await okEngine.loadInstrument()).ok).toBe(true);

    okEngine.scheduleNotes([
      { noteId: 'n1', midiPitch: 60, startTimeMs: 0, durationMs: 500 },
    ]);
    okEngine.scheduleMetronome([{ tickIndex: 0, timeMs: 0, isAccent: true }]);
    okEngine.previewNote(64, 200);
    okEngine.advanceTimeMs(250);

    expect(okEngine.scheduledNotes).toHaveLength(1);
    expect(okEngine.scheduledMetronomeTicks).toHaveLength(1);
    expect(okEngine.previewedNotes).toEqual([{ midiPitch: 64, durationMs: 200 }]);
    expect(okEngine.getCurrentTimeMs()).toBe(250);

    const failEngine = new MockAudioEngine({ failUnlock: true, failLoad: true });
    const unlockRes = await failEngine.unlock();
    expect(unlockRes.ok).toBe(false);
    if (!unlockRes.ok) {
      expect(unlockRes.error.code).toBe('AUDIO_CONTEXT_BLOCKED');
    }
    const loadRes = await failEngine.loadInstrument();
    expect(loadRes.ok).toBe(false);
    if (!loadRes.ok) {
      expect(loadRes.error.code).toBe('AUDIO_SOUNDFONT_LOAD_FAILED');
    }
  });

  it('StorageAdapter 支持正常读写列删及配额/损坏异常转换', () => {
    const mem = new MemoryStorage();
    const adapter = new StorageAdapter({ storage: mem, namespace: 'nb_test' });
    const doc = createSampleScore();

    const saveRes = adapter.saveScore(doc);
    expect(saveRes.ok).toBe(true);

    const loadRes = adapter.loadScore(doc.id);
    expect(loadRes.ok).toBe(true);
    if (loadRes.ok) {
      expect(loadRes.value).toEqual(doc);
    }

    const lastRes = adapter.loadLastOpenedScore();
    expect(lastRes.ok && lastRes.value?.id).toBe(doc.id);

    const listRes = adapter.listScores();
    expect(listRes.ok && listRes.value).toHaveLength(1);

    // 模拟配额超限
    mem.throwQuotaOnSet = true;
    const quotaRes = adapter.saveScore(doc);
    expect(quotaRes.ok).toBe(false);
    if (!quotaRes.ok) {
      expect(quotaRes.error.code).toBe('STORAGE_QUOTA_EXCEEDED');
    }
    mem.throwQuotaOnSet = false;

    // 模拟存储内容损坏
    mem.setItem('nb_test:score:corrupt', '{bad-json');
    const corruptRes = adapter.loadScore('corrupt');
    expect(corruptRes.ok).toBe(false);
    if (!corruptRes.ok) {
      expect(corruptRes.error.code).toBe('STORAGE_SCHEMA_CORRUPTED');
    }

    // 不存在的工程
    const missingRes = adapter.loadScore('non-existent');
    expect(missingRes.ok).toBe(false);
    if (!missingRes.ok) {
      expect(missingRes.error.code).toBe('RESOURCE_NOT_FOUND');
    }

    const delRes = adapter.deleteScore(doc.id);
    expect(delRes.ok).toBe(true);
    expect(adapter.listScores()).toEqual({ ok: true, value: [] });
  });
});
