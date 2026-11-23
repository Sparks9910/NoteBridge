import { describe, expect, it } from 'vitest';
import {
  transitionDocumentState,
  transitionInputPadState,
  transitionMeasureValidityState,
  transitionPlaybackState,
  type DocumentEvent,
  type InputPadEvent,
  type PlaybackEvent,
} from '../../src/domain/state-machines.ts';
import type {
  DocumentState,
  InputPadState,
  PlaybackState,
} from '../../src/domain/types.ts';

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('state-machines - 4 个核心状态机合法与非法流转', () => {
  it('1. PlaybackState 完整覆盖合法与非法流转', () => {
    const validCases: Array<{
      from: PlaybackState;
      event: PlaybackEvent;
      loop?: boolean;
      to: PlaybackState;
    }> = [
      { from: 'IDLE', event: 'START_PLAY', to: 'LOADING_AUDIO' },
      { from: 'LOADING_AUDIO', event: 'AUDIO_READY', to: 'PLAYING' },
      { from: 'LOADING_AUDIO', event: 'AUDIO_FAILED', to: 'ERROR' },
      { from: 'LOADING_AUDIO', event: 'STOP', to: 'IDLE' },
      { from: 'PLAYING', event: 'PAUSE', to: 'PAUSED' },
      { from: 'PLAYING', event: 'STOP', to: 'IDLE' },
      { from: 'PLAYING', event: 'PLAY_COMPLETE', loop: false, to: 'IDLE' },
      { from: 'PLAYING', event: 'PLAY_COMPLETE', loop: true, to: 'PLAYING' },
      { from: 'PLAYING', event: 'AUDIO_FAILED', to: 'ERROR' },
      { from: 'PAUSED', event: 'RESUME', to: 'PLAYING' },
      { from: 'PAUSED', event: 'STOP', to: 'IDLE' },
      { from: 'ERROR', event: 'RESET_ERROR', to: 'IDLE' },
    ];

    for (const c of validCases) {
      const res = transitionPlaybackState(c.from, c.event, { loop: c.loop });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toBe(c.to);
      }
    }

    const invalidCases: Array<[PlaybackState, PlaybackEvent]> = [
      ['IDLE', 'PAUSE'],
      ['IDLE', 'RESUME'],
      ['IDLE', 'PLAY_COMPLETE'],
      ['LOADING_AUDIO', 'PAUSE'],
      ['PLAYING', 'START_PLAY'],
      ['PAUSED', 'PAUSE'],
      ['ERROR', 'START_PLAY'],
    ];

    for (const [from, ev] of invalidCases) {
      const res = transitionPlaybackState(from, ev);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('STATE_INVALID_TRANSITION');
        expect(res.error.request_id).toMatch(UUID_V4_RE);
      }
    }
  });

  it('2. InputPadState 覆盖合法流转并拦截播放锁定态下的录入', () => {
    const validCases: Array<[InputPadState, InputPadEvent, InputPadState]> = [
      ['READY', 'ARM_MODIFIER', 'MODIFIER_ARMED'],
      ['READY', 'COMMIT_NOTE', 'READY'],
      ['READY', 'LOCK', 'LOCKED_BY_PLAYBACK'],
      ['MODIFIER_ARMED', 'ARM_MODIFIER', 'MODIFIER_ARMED'],
      ['MODIFIER_ARMED', 'CLEAR_MODIFIER', 'READY'],
      ['MODIFIER_ARMED', 'COMMIT_NOTE', 'READY'],
      ['MODIFIER_ARMED', 'LOCK', 'LOCKED_BY_PLAYBACK'],
      ['LOCKED_BY_PLAYBACK', 'UNLOCK', 'READY'],
    ];
    for (const [from, ev, to] of validCases) {
      const res = transitionInputPadState(from, ev);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toBe(to);
      }
    }

    const blockedEvents: InputPadEvent[] = ['ARM_MODIFIER', 'COMMIT_NOTE', 'CLEAR_MODIFIER'];
    for (const ev of blockedEvents) {
      const res = transitionInputPadState('LOCKED_BY_PLAYBACK', ev);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('STATE_INVALID_TRANSITION');
      }
    }
  });

  it('3. MeasureValidityState 校验区间映射与非法时值拦截', () => {
    expect(
      transitionMeasureValidityState('EMPTY', {
        type: 'RECALCULATE_MEASURE',
        totalTicks: 0,
        capacityTicks: 1920,
      })
    ).toEqual({ ok: true, value: 'EMPTY' });

    expect(
      transitionMeasureValidityState('EMPTY', {
        type: 'RECALCULATE_MEASURE',
        totalTicks: 960,
        capacityTicks: 1920,
      })
    ).toEqual({ ok: true, value: 'UNDERFLOW' });

    expect(
      transitionMeasureValidityState('UNDERFLOW', {
        type: 'RECALCULATE_MEASURE',
        totalTicks: 1920,
        capacityTicks: 1920,
      })
    ).toEqual({ ok: true, value: 'VALID' });

    expect(
      transitionMeasureValidityState('VALID', {
        type: 'RECALCULATE_MEASURE',
        totalTicks: 2160,
        capacityTicks: 1920,
      })
    ).toEqual({ ok: true, value: 'OVERFLOW' });

    const neg = transitionMeasureValidityState('EMPTY', {
      type: 'RECALCULATE_MEASURE',
      totalTicks: -1,
      capacityTicks: 1920,
    });
    expect(neg.ok).toBe(false);
    if (!neg.ok) {
      expect(neg.error.code).toBe('SCORE_INVALID_DURATION');
    }
  });

  it('4. DocumentState 覆盖持久化流转与非法流转拦截', () => {
    const validCases: Array<[DocumentState, DocumentEvent, DocumentState]> = [
      ['CLEAN', 'MUTATE_SCORE', 'DIRTY'],
      ['DIRTY', 'MUTATE_SCORE', 'DIRTY'],
      ['DIRTY', 'BEGIN_SAVE', 'SAVING'],
      ['SAVING', 'SAVE_SUCCEEDED', 'CLEAN'],
      ['SAVING', 'SAVE_FAILED_ERR', 'SAVE_FAILED'],
      ['SAVE_FAILED', 'MUTATE_SCORE', 'DIRTY'],
      ['SAVE_FAILED', 'BEGIN_SAVE', 'SAVING'],
    ];
    for (const [from, ev, to] of validCases) {
      const res = transitionDocumentState(from, ev);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.value).toBe(to);
      }
    }

    const invalidCases: Array<[DocumentState, DocumentEvent]> = [
      ['CLEAN', 'SAVE_SUCCEEDED'],
      ['CLEAN', 'BEGIN_SAVE'],
      ['DIRTY', 'SAVE_SUCCEEDED'],
      ['SAVING', 'MUTATE_SCORE'],
    ];
    for (const [from, ev] of invalidCases) {
      const res = transitionDocumentState(from, ev);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('STATE_INVALID_TRANSITION');
      }
    }
  });
});
