import * as Tone from 'tone';
import { SplendidGrandPiano } from 'smplr';
import { createAppError } from '../domain/state-machines.ts';
import type { Result } from '../domain/types.ts';
import { appConfig } from './config.ts';

export interface ScheduledNote {
  noteId: string;
  midiPitch: number;
  startTimeMs: number;
  durationMs: number;
  velocity?: number;
}

export interface ScheduledMetronomeTick {
  tickIndex: number;
  timeMs: number;
  isAccent: boolean;
}

export type AudioBackendMode = 'soundfont' | 'synth-fallback' | 'mock';

export interface AudioEngine {
  readonly lookaheadMs: number;
  getBackendMode(): AudioBackendMode;
  unlock(): Promise<Result<void>>;
  loadInstrument(): Promise<Result<AudioBackendMode>>;
  getCurrentTimeMs(): number;
  scheduleNotes(notes: readonly ScheduledNote[]): Result<void>;
  scheduleMetronome(ticks: readonly ScheduledMetronomeTick[]): Result<void>;
  previewNote(midiPitch: number, durationMs?: number): Result<void>;
  stopAll(): void;
  dispose(): void;
}

/** 唯一时间换算边界：毫秒 -> Web Audio 秒 */
export function msToSeconds(ms: number): number {
  return ms / 1000;
}

export interface WebAudioEngineOptions {
  lookaheadMs?: number;
  allowSynthFallback?: boolean;
  loadTimeoutMs?: number;
  pianoFactory?: (
    context: AudioContext
  ) => Promise<{
    start: (params: {
      note: number | string;
      time?: number;
      duration?: number;
      velocity?: number;
    }) => void;
    stop?: () => void;
    disconnect?: () => void;
  }>;
}

interface PianoLike {
  start: (params: {
    note: number | string;
    time?: number;
    duration?: number;
    velocity?: number;
  }) => void;
  stop?: () => void;
  disconnect?: () => void;
}

/**
 * Web Audio 音频引擎实现（Tone.js + smplr 钢琴采样 + 离线合成器安全回退）。
 * 惰性初始化：模块导入时不创建 AudioContext，需由用户手势触发 unlock()。
 */
export class WebAudioEngine implements AudioEngine {
  public readonly lookaheadMs: number;
  private readonly allowSynthFallback: boolean;
  private readonly loadTimeoutMs: number;
  private readonly pianoFactory?: WebAudioEngineOptions['pianoFactory'];

  private mode: AudioBackendMode = 'synth-fallback';
  private piano: PianoLike | null = null;
  private synth: Tone.PolySynth | null = null;
  private metronomeSynth: Tone.MembraneSynth | null = null;
  private scheduledTimers: number[] = [];

  constructor(options?: WebAudioEngineOptions) {
    this.lookaheadMs = options?.lookaheadMs ?? appConfig.audioLookaheadMs;
    this.allowSynthFallback = options?.allowSynthFallback ?? true;
    this.loadTimeoutMs = options?.loadTimeoutMs ?? 4500;
    this.pianoFactory = options?.pianoFactory;
  }

  public getBackendMode(): AudioBackendMode {
    return this.mode;
  }

  public async unlock(): Promise<Result<void>> {
    try {
      await Tone.start();
      const rawCtx = Tone.getContext().rawContext;
      if (rawCtx.state !== 'running' && 'resume' in rawCtx) {
        await (rawCtx as AudioContext).resume();
      }
      if (rawCtx.state !== 'running') {
        return {
          ok: false,
          error: createAppError(
            'AUDIO_CONTEXT_BLOCKED',
            '浏览器阻止了音频上下文自动启动，请点击页面按钮后重试播放'
          ),
        };
      }
      return { ok: true, value: undefined };
    } catch {
      return {
        ok: false,
        error: createAppError(
          'AUDIO_CONTEXT_BLOCKED',
          '音频上下文启动被浏览器拦截或当前环境不支持 Web Audio'
        ),
      };
    }
  }

  public async loadInstrument(): Promise<Result<AudioBackendMode>> {
    if (this.piano) {
      this.mode = 'soundfont';
      return { ok: true, value: 'soundfont' };
    }

    try {
      const rawCtx = Tone.getContext().rawContext as AudioContext;
      const loadPromise = this.pianoFactory
        ? this.pianoFactory(rawCtx)
        : new SplendidGrandPiano(rawCtx).load;

      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        const id = globalThis.setTimeout(() => {
          reject(new Error('timeout'));
        }, this.loadTimeoutMs);
        this.scheduledTimers.push(id as unknown as number);
      });

      const loaded = await Promise.race([loadPromise, timeoutPromise]);
      this.piano = loaded;
      this.mode = 'soundfont';
      return { ok: true, value: 'soundfont' };
    } catch {
      if (this.allowSynthFallback) {
        this.ensureSynth();
        this.mode = 'synth-fallback';
        return { ok: true, value: 'synth-fallback' };
      }
      return {
        ok: false,
        error: createAppError(
          'AUDIO_SOUNDFONT_LOAD_FAILED',
          '钢琴采样音源加载失败，请检查网络连接或启用离线合成器'
        ),
      };
    }
  }

  public getCurrentTimeMs(): number {
    return Tone.now() * 1000;
  }

  public scheduleNotes(notes: readonly ScheduledNote[]): Result<void> {
    try {
      const baseSec = Tone.now() + msToSeconds(this.lookaheadMs);
      for (const note of notes) {
        const startSec = baseSec + msToSeconds(note.startTimeMs);
        const durSec = Math.max(0.05, msToSeconds(note.durationMs));
        const velocity = note.velocity ?? 0.85;

        if (this.piano && this.mode === 'soundfont') {
          this.piano.start({
            note: note.midiPitch,
            time: startSec,
            duration: durSec,
            velocity: Math.round(velocity * 127),
          });
        } else {
          const synth = this.ensureSynth();
          const noteName = Tone.Frequency(note.midiPitch, 'midi').toNote();
          synth.triggerAttackRelease(noteName, durSec, startSec, velocity);
        }
      }
      return { ok: true, value: undefined };
    } catch {
      return {
        ok: false,
        error: createAppError(
          'AUDIO_CONTEXT_BLOCKED',
          '音频音符调度失败，请确认音频上下文已解锁'
        ),
      };
    }
  }

  public scheduleMetronome(
    ticks: readonly ScheduledMetronomeTick[]
  ): Result<void> {
    try {
      const metro = this.ensureMetronomeSynth();
      const baseSec = Tone.now() + msToSeconds(this.lookaheadMs);
      for (const t of ticks) {
        const startSec = baseSec + msToSeconds(t.timeMs);
        metro.triggerAttackRelease(
          t.isAccent ? 'C5' : 'G4',
          0.04,
          startSec,
          t.isAccent ? 0.7 : 0.4
        );
      }
      return { ok: true, value: undefined };
    } catch {
      return {
        ok: false,
        error: createAppError(
          'AUDIO_CONTEXT_BLOCKED',
          '节拍器调度失败，请确认音频上下文已解锁'
        ),
      };
    }
  }

  public previewNote(midiPitch: number, durationMs = 280): Result<void> {
    try {
      const nowSec = Tone.now();
      const durSec = Math.max(0.05, msToSeconds(durationMs));
      if (this.piano && this.mode === 'soundfont') {
        this.piano.start({
          note: midiPitch,
          time: nowSec,
          duration: durSec,
          velocity: 100,
        });
      } else {
        const synth = this.ensureSynth();
        const noteName = Tone.Frequency(midiPitch, 'midi').toNote();
        synth.triggerAttackRelease(noteName, durSec, nowSec, 0.8);
      }
      return { ok: true, value: undefined };
    } catch {
      return {
        ok: false,
        error: createAppError(
          'AUDIO_CONTEXT_BLOCKED',
          '即时试听发声失败，请先点击页面解锁音频'
        ),
      };
    }
  }

  public stopAll(): void {
    for (const id of this.scheduledTimers) {
      globalThis.clearTimeout(id);
    }
    this.scheduledTimers = [];
    try {
      this.piano?.stop?.();
      this.synth?.releaseAll();
    } catch {
      // 忽略停止阶段的浏览器音频上下文未就绪异常
    }
  }

  public dispose(): void {
    this.stopAll();
    try {
      this.piano?.disconnect?.();
      this.synth?.dispose();
      this.metronomeSynth?.dispose();
    } catch {
      // 忽略释放阶段非致命异常
    }
    this.piano = null;
    this.synth = null;
    this.metronomeSynth = null;
  }

  private ensureSynth(): Tone.PolySynth {
    if (!this.synth) {
      this.synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'triangle' },
        envelope: {
          attack: 0.01,
          decay: 0.15,
          sustain: 0.3,
          release: 0.4,
        },
      }).toDestination();
    }
    return this.synth;
  }

  private ensureMetronomeSynth(): Tone.MembraneSynth {
    if (!this.metronomeSynth) {
      this.metronomeSynth = new Tone.MembraneSynth({
        octaves: 2,
        pitchDecay: 0.02,
      }).toDestination();
    }
    return this.metronomeSynth;
  }
}

export interface MockAudioEngineOptions {
  lookaheadMs?: number;
  failUnlock?: boolean;
  failLoad?: boolean;
}

/**
 * 可控时钟的模拟音频引擎，用于 L1/L2/L4 自动化测试。
 */
export class MockAudioEngine implements AudioEngine {
  public readonly lookaheadMs: number;
  public failUnlock: boolean;
  public failLoad: boolean;
  public unlocked = false;
  public loaded = false;
  public scheduledNotes: ScheduledNote[] = [];
  public scheduledMetronomeTicks: ScheduledMetronomeTick[] = [];
  public previewedNotes: Array<{ midiPitch: number; durationMs: number }> = [];
  private currentTimeMs = 0;

  constructor(options?: MockAudioEngineOptions) {
    this.lookaheadMs = options?.lookaheadMs ?? 100;
    this.failUnlock = options?.failUnlock ?? false;
    this.failLoad = options?.failLoad ?? false;
  }

  public getBackendMode(): AudioBackendMode {
    return 'mock';
  }

  public async unlock(): Promise<Result<void>> {
    if (this.failUnlock) {
      return {
        ok: false,
        error: createAppError(
          'AUDIO_CONTEXT_BLOCKED',
          '模拟环境音频上下文启动被拦截'
        ),
      };
    }
    this.unlocked = true;
    return { ok: true, value: undefined };
  }

  public async loadInstrument(): Promise<Result<AudioBackendMode>> {
    if (this.failLoad) {
      return {
        ok: false,
        error: createAppError(
          'AUDIO_SOUNDFONT_LOAD_FAILED',
          '模拟环境采样音源加载失败'
        ),
      };
    }
    this.loaded = true;
    return { ok: true, value: 'mock' };
  }

  public getCurrentTimeMs(): number {
    return this.currentTimeMs;
  }

  public setCurrentTimeMs(timeMs: number): void {
    this.currentTimeMs = Math.max(0, timeMs);
  }

  public advanceTimeMs(deltaMs: number): void {
    this.currentTimeMs = Math.max(0, this.currentTimeMs + deltaMs);
  }

  public scheduleNotes(notes: readonly ScheduledNote[]): Result<void> {
    this.scheduledNotes.push(...notes);
    return { ok: true, value: undefined };
  }

  public scheduleMetronome(
    ticks: readonly ScheduledMetronomeTick[]
  ): Result<void> {
    this.scheduledMetronomeTicks.push(...ticks);
    return { ok: true, value: undefined };
  }

  public previewNote(midiPitch: number, durationMs = 280): Result<void> {
    this.previewedNotes.push({ midiPitch, durationMs });
    return { ok: true, value: undefined };
  }

  public stopAll(): void {
    this.scheduledNotes = [];
    this.scheduledMetronomeTicks = [];
  }

  public dispose(): void {
    this.stopAll();
    this.unlocked = false;
    this.loaded = false;
  }
}
