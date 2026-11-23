import { describe, expect, it } from 'vitest';
import { createInputStore } from '../../src/application/input-store.ts';

describe('L2 服务层测试 - input-store', () => {
  it('严格驱动 READY ↔ MODIFIER_ARMED 并按 A-06 录入后复位临时修饰且保留时值', () => {
    const store = createInputStore();

    expect(store.getState().padState).toBe('READY');
    expect(store.getState().baseDuration).toBe('quarter');

    store.getState().setBaseDuration('eighth');
    expect(store.getState().padState).toBe('READY');
    expect(store.getState().baseDuration).toBe('eighth');

    // 激活临时修饰 -> MODIFIER_ARMED
    expect(store.getState().toggleAccidental('sharp').ok).toBe(true);
    expect(store.getState().padState).toBe('MODIFIER_ARMED');
    expect(store.getState().stepOctave(1).ok).toBe(true);
    expect(store.getState().toggleDotted().ok).toBe(true);
    expect(store.getState().accidental).toBe('sharp');
    expect(store.getState().octaveOffset).toBe(1);
    expect(store.getState().dotted).toBe(true);

    // 录入音符 -> 返回快照，自动复位临时修饰，保留 eighth 时值
    const commitRes = store.getState().commitNote();
    expect(commitRes.ok).toBe(true);
    if (commitRes.ok) {
      expect(commitRes.value).toEqual({
        baseDuration: 'eighth',
        accidental: 'sharp',
        octaveOffset: 1,
        dotted: true,
      });
    }

    expect(store.getState().padState).toBe('READY');
    expect(store.getState().accidental).toBeNull();
    expect(store.getState().octaveOffset).toBe(0);
    expect(store.getState().dotted).toBe(false);
    expect(store.getState().baseDuration).toBe('eighth');

    // 清除修饰也可从 MODIFIER_ARMED 回到 READY
    store.getState().toggleAccidental('flat');
    expect(store.getState().padState).toBe('MODIFIER_ARMED');
    expect(store.getState().clearModifiers().ok).toBe(true);
    expect(store.getState().padState).toBe('READY');
    expect(store.getState().accidental).toBeNull();
  });

  it('播放锁定 LOCKED_BY_PLAYBACK 拦截一切修饰与录入，解锁后恢复 READY', () => {
    const store = createInputStore();
    store.getState().toggleAccidental('sharp');
    expect(store.getState().lockForPlayback().ok).toBe(true);
    expect(store.getState().padState).toBe('LOCKED_BY_PLAYBACK');
    expect(store.getState().accidental).toBeNull();

    const modBlocked = store.getState().toggleDotted();
    expect(modBlocked.ok).toBe(false);
    if (!modBlocked.ok) {
      expect(modBlocked.error.code).toBe('STATE_INVALID_TRANSITION');
    }

    const durBlocked = store.getState().setBaseDuration('half');
    expect(durBlocked.ok).toBe(false);
    if (!durBlocked.ok) {
      expect(durBlocked.error.code).toBe('STATE_INVALID_TRANSITION');
    }

    const commitBlocked = store.getState().commitNote();
    expect(commitBlocked.ok).toBe(false);
    if (!commitBlocked.ok) {
      expect(commitBlocked.error.code).toBe('STATE_INVALID_TRANSITION');
    }

    expect(store.getState().unlockFromPlayback().ok).toBe(true);
    expect(store.getState().padState).toBe('READY');
    expect(store.getState().commitNote().ok).toBe(true);
  });
});
