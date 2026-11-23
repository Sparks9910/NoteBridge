import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  getBeatTicks,
  msToTicks,
  ticksToMs,
} from '../domain/rhythm.ts';
import {
  createAppError,
  transitionPlaybackState,
} from '../domain/state-machines.ts';
import { resolveNotePitch, resolveScoreNotes } from '../domain/theory.ts';
import type {
  AppError,
  KeySignature,
  NoteEvent,
  PlaybackState,
  Result,
} from '../domain/types.ts';
import {
  type AudioBackendMode,
  type AudioEngine,
  type ScheduledMetronomeTick,
  type ScheduledNote,
  WebAudioEngine,
} from '../infrastructure/audio-engine.ts';
import { type InputStoreApi, inputStore } from './input-store.ts';
import { type ScoreStoreApi, scoreStore } from './score-store.ts';

export interface PlaybackSnapshot {
  playbackState: PlaybackState;
  loop: boolean;
  metronomeEnabled: boolean;
  startMeasureIndex: number;
  currentBpm: number;
  audioBackendMode: AudioBackendMode;
  lastError: AppError | null;
}

export interface PlaybackControllerDeps {
  scoreStore?: ScoreStoreApi;
  inputStore?: InputStoreApi;
  audioEngine?: AudioEngine;
}

export class PlaybackController {
  private readonly scoreStore: ScoreStoreApi;
  private readonly inputStore: InputStoreApi;
  private readonly audioEngine: AudioEngine;
  private readonly store: StoreApi<PlaybackSnapshot>;

  private anchorScoreTick = 0;
  private anchorEngineTimeMs = 0;
  private pausedScoreTick = 0;
  private startMeasureTick = 0;
  private totalScoreTicks = 0;
  private playSessionId = 0;
  private completionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps?: PlaybackControllerDeps) {
    this.scoreStore = deps?.scoreStore ?? scoreStore;
    this.inputStore = deps?.inputStore ?? inputStore;
    this.audioEngine = deps?.audioEngine ?? new WebAudioEngine();

    this.store = createStore<PlaybackSnapshot>(() => ({
      playbackState: 'IDLE',
      loop: false,
      metronomeEnabled: false,
      startMeasureIndex: 0,
      currentBpm: this.scoreStore.getState().document.bpm,
      audioBackendMode: this.audioEngine.getBackendMode(),
      lastError: null,
    }));
  }

  public getStore(): StoreApi<PlaybackSnapshot> {
    return this.store;
  }

  public getSnapshot(): PlaybackSnapshot {
    return this.store.getState();
  }

  public getCurrentScoreTick(): number {
    const snap = this.store.getState();
    if (snap.playbackState === 'PLAYING') {
      const elapsedMs = Math.max(
        0,
        this.audioEngine.getCurrentTimeMs() - this.anchorEngineTimeMs
      );
      const rawTick =
        this.anchorScoreTick + msToTicks(elapsedMs, snap.currentBpm);
      if (this.totalScoreTicks <= 0) {
        return 0;
      }
      if (snap.loop) {
        const span = this.totalScoreTicks - this.startMeasureTick;
        if (span <= 0) {
          return this.startMeasureTick;
        }
        const offset = Math.max(0, rawTick - this.startMeasureTick) % span;
        return this.startMeasureTick + offset;
      }
      return Math.min(this.totalScoreTicks, Math.max(0, rawTick));
    }
    if (snap.playbackState === 'PAUSED') {
      return this.pausedScoreTick;
    }
    return 0;
  }

  /**
   * 对外提供只读播放进度（毫秒），供 CursorOverlayController 每帧读取。
   */
  public getCurrentPlaybackTimeMs(): number {
    const snap = this.store.getState();
    const tick = this.getCurrentScoreTick();
    return ticksToMs(tick, snap.currentBpm);
  }

  public async play(options?: {
    startMeasureIndex?: number;
  }): Promise<Result<PlaybackState>> {
    const snap = this.store.getState();
    const doc = this.scoreStore.getState().document;
    const targetMeasureIdx = options?.startMeasureIndex ?? 0;

    if (targetMeasureIdx < 0 || targetMeasureIdx >= doc.measures.length) {
      const err = createAppError(
        'SCORE_MEASURE_NOT_FOUND',
        `未找到第 ${targetMeasureIdx + 1} 小节，无法起播`,
        'startMeasureIndex'
      );
      this.store.setState({ lastError: err });
      return { ok: false, error: err };
    }

    const startRes = transitionPlaybackState(snap.playbackState, 'START_PLAY');
    if (!startRes.ok) {
      this.store.setState({ lastError: startRes.error });
      return startRes;
    }

    this.clearCompletionTimer();
    this.playSessionId += 1;
    const sessionId = this.playSessionId;

    this.inputStore.getState().lockForPlayback();
    this.store.setState({
      playbackState: startRes.value,
      startMeasureIndex: targetMeasureIdx,
      currentBpm: doc.bpm,
      lastError: null,
    });

    const unlockRes = await this.audioEngine.unlock();
    if (
      sessionId !== this.playSessionId ||
      this.store.getState().playbackState !== 'LOADING_AUDIO'
    ) {
      return { ok: true, value: this.store.getState().playbackState };
    }

    if (!unlockRes.ok) {
      const errRes = transitionPlaybackState('LOADING_AUDIO', 'AUDIO_FAILED');
      this.inputStore.getState().unlockFromPlayback();
      this.store.setState({
        playbackState: errRes.ok ? errRes.value : 'ERROR',
        lastError: unlockRes.error,
      });
      return { ok: false, error: unlockRes.error };
    }

    const loadRes = await this.audioEngine.loadInstrument();
    if (
      sessionId !== this.playSessionId ||
      this.store.getState().playbackState !== 'LOADING_AUDIO'
    ) {
      return { ok: true, value: this.store.getState().playbackState };
    }

    if (!loadRes.ok) {
      const errRes = transitionPlaybackState('LOADING_AUDIO', 'AUDIO_FAILED');
      this.inputStore.getState().unlockFromPlayback();
      this.store.setState({
        playbackState: errRes.ok ? errRes.value : 'ERROR',
        lastError: loadRes.error,
      });
      return { ok: false, error: loadRes.error };
    }

    const readyRes = transitionPlaybackState('LOADING_AUDIO', 'AUDIO_READY');
    if (!readyRes.ok) {
      this.inputStore.getState().unlockFromPlayback();
      this.store.setState({ lastError: readyRes.error });
      return readyRes;
    }

    const latestDoc = this.scoreStore.getState().document;
    const { startTick, totalTicks } = this.computeMeasureBounds(
      targetMeasureIdx
    );
    this.startMeasureTick = startTick;
    this.totalScoreTicks = totalTicks;

    this.store.setState({
      playbackState: readyRes.value,
      currentBpm: latestDoc.bpm,
      audioBackendMode: loadRes.value,
      lastError: null,
    });

    if (totalTicks <= startTick) {
      if (!this.store.getState().loop) {
        return this.completePlayback();
      }
      this.anchorScoreTick = startTick;
      this.anchorEngineTimeMs = this.audioEngine.getCurrentTimeMs();
      return { ok: true, value: 'PLAYING' };
    }

    const schedRes = this.scheduleFromTick(startTick, latestDoc.bpm);
    if (!schedRes.ok) {
      const errRes = transitionPlaybackState('PLAYING', 'AUDIO_FAILED');
      this.audioEngine.stopAll();
      this.inputStore.getState().unlockFromPlayback();
      this.store.setState({
        playbackState: errRes.ok ? errRes.value : 'ERROR',
        lastError: schedRes.error,
      });
      return schedRes;
    }

    return { ok: true, value: 'PLAYING' };
  }

  public async playFromMeasure(
    measureIndex: number
  ): Promise<Result<PlaybackState>> {
    const doc = this.scoreStore.getState().document;
    if (measureIndex < 0 || measureIndex >= doc.measures.length) {
      const err = createAppError(
        'SCORE_MEASURE_NOT_FOUND',
        `未找到第 ${measureIndex + 1} 小节，无法起播`,
        'measureIndex'
      );
      this.store.setState({ lastError: err });
      return { ok: false, error: err };
    }

    const current = this.store.getState().playbackState;
    if (
      current === 'PLAYING' ||
      current === 'PAUSED' ||
      current === 'LOADING_AUDIO'
    ) {
      const stopRes = this.stop();
      if (!stopRes.ok) {
        return stopRes;
      }
    }

    return this.play({ startMeasureIndex: measureIndex });
  }

  public pause(): Result<PlaybackState> {
    const snap = this.store.getState();
    const res = transitionPlaybackState(snap.playbackState, 'PAUSE');
    if (!res.ok) {
      this.store.setState({ lastError: res.error });
      return res;
    }

    this.pausedScoreTick = this.getCurrentScoreTick();
    this.clearCompletionTimer();
    this.audioEngine.stopAll();

    this.store.setState({
      playbackState: res.value,
      lastError: null,
    });
    return res;
  }

  public resume(): Result<PlaybackState> {
    const snap = this.store.getState();
    const res = transitionPlaybackState(snap.playbackState, 'RESUME');
    if (!res.ok) {
      this.store.setState({ lastError: res.error });
      return res;
    }

    const latestDoc = this.scoreStore.getState().document;
    const { totalTicks } = this.computeMeasureBounds(snap.startMeasureIndex);
    this.totalScoreTicks = totalTicks;

    this.store.setState({
      playbackState: res.value,
      currentBpm: latestDoc.bpm,
      lastError: null,
    });

    if (totalTicks <= this.pausedScoreTick) {
      if (!this.store.getState().loop) {
        return this.completePlayback();
      }
      this.anchorScoreTick = this.startMeasureTick;
      this.anchorEngineTimeMs = this.audioEngine.getCurrentTimeMs();
      return { ok: true, value: 'PLAYING' };
    }

    const schedRes = this.scheduleFromTick(this.pausedScoreTick, latestDoc.bpm);
    if (!schedRes.ok) {
      const errRes = transitionPlaybackState('PLAYING', 'AUDIO_FAILED');
      this.audioEngine.stopAll();
      this.inputStore.getState().unlockFromPlayback();
      this.store.setState({
        playbackState: errRes.ok ? errRes.value : 'ERROR',
        lastError: schedRes.error,
      });
      return schedRes;
    }

    return res;
  }

  public stop(): Result<PlaybackState> {
    const snap = this.store.getState();
    if (snap.playbackState === 'IDLE') {
      return { ok: true, value: 'IDLE' };
    }

    const res = transitionPlaybackState(snap.playbackState, 'STOP');
    if (!res.ok) {
      this.store.setState({ lastError: res.error });
      return res;
    }

    this.playSessionId += 1;
    this.clearCompletionTimer();
    this.audioEngine.stopAll();
    this.anchorScoreTick = 0;
    this.pausedScoreTick = 0;
    this.inputStore.getState().unlockFromPlayback();

    this.store.setState({
      playbackState: res.value,
      lastError: null,
    });
    return res;
  }

  public completePlayback(): Result<PlaybackState> {
    const snap = this.store.getState();
    const res = transitionPlaybackState(snap.playbackState, 'PLAY_COMPLETE', {
      loop: snap.loop,
    });
    if (!res.ok) {
      this.store.setState({ lastError: res.error });
      return res;
    }

    this.clearCompletionTimer();
    this.audioEngine.stopAll();

    if (res.value === 'PLAYING') {
      const latestDoc = this.scoreStore.getState().document;
      const { startTick, totalTicks } = this.computeMeasureBounds(
        snap.startMeasureIndex
      );
      this.startMeasureTick = startTick;
      this.totalScoreTicks = totalTicks;

      if (totalTicks > startTick) {
        const schedRes = this.scheduleFromTick(startTick, latestDoc.bpm);
        if (!schedRes.ok) {
          const errRes = transitionPlaybackState('PLAYING', 'AUDIO_FAILED');
          this.inputStore.getState().unlockFromPlayback();
          this.store.setState({
            playbackState: errRes.ok ? errRes.value : 'ERROR',
            lastError: schedRes.error,
          });
          return schedRes;
        }
      }
      return res;
    }

    this.anchorScoreTick = 0;
    this.pausedScoreTick = 0;
    this.inputStore.getState().unlockFromPlayback();
    this.store.setState({
      playbackState: res.value,
      lastError: null,
    });
    return res;
  }

  public resetError(): Result<PlaybackState> {
    const snap = this.store.getState();
    const res = transitionPlaybackState(snap.playbackState, 'RESET_ERROR');
    if (!res.ok) {
      this.store.setState({ lastError: res.error });
      return res;
    }
    this.inputStore.getState().unlockFromPlayback();
    this.store.setState({
      playbackState: res.value,
      lastError: null,
    });
    return res;
  }

  public setLoop(enabled: boolean): void {
    this.store.setState({ loop: enabled });
  }

  public setMetronomeEnabled(enabled: boolean): Result<void> {
    this.store.setState({ metronomeEnabled: enabled });
    const snap = this.store.getState();
    if (snap.playbackState === 'PLAYING') {
      const currentTick = this.getCurrentScoreTick();
      this.clearCompletionTimer();
      this.audioEngine.stopAll();
      return this.scheduleFromTick(currentTick, snap.currentBpm);
    }
    return { ok: true, value: undefined };
  }

  public updateBpmLive(bpm: number): Result<number> {
    if (!Number.isInteger(bpm) || bpm < 40 || bpm > 200) {
      const err = createAppError(
        'SCORE_INVALID_BPM',
        '速度 BPM 必须为 40 到 200 之间的整数',
        'bpm'
      );
      this.store.setState({ lastError: err });
      return { ok: false, error: err };
    }

    const snap = this.store.getState();
    const currentTickBefore =
      snap.playbackState === 'PLAYING' ? this.getCurrentScoreTick() : 0;

    const scoreRes = this.scoreStore.getState().setBpm(bpm);
    if (!scoreRes.ok) {
      this.store.setState({ lastError: scoreRes.error });
      return scoreRes;
    }

    this.store.setState({ currentBpm: bpm, lastError: null });

    if (snap.playbackState === 'PLAYING') {
      this.clearCompletionTimer();
      this.audioEngine.stopAll();
      const schedRes = this.scheduleFromTick(currentTickBefore, bpm);
      if (!schedRes.ok) {
        return schedRes;
      }
    }

    return { ok: true, value: bpm };
  }

  public previewNote(note: NoteEvent, keySignature?: KeySignature): Result<void> {
    if (note.isRest || note.degree === 0) {
      return { ok: true, value: undefined };
    }
    const key =
      keySignature ?? this.scoreStore.getState().document.keySignature;
    const resolved = resolveNotePitch(note, key);
    if (!resolved) {
      return { ok: true, value: undefined };
    }

    if (this.audioEngine.getBackendMode() !== 'mock') {
      void this.audioEngine.unlock();
    }

    const res = this.audioEngine.previewNote(resolved.midiPitch, 280);
    if (!res.ok) {
      this.store.setState({ lastError: res.error });
    }
    return res;
  }

  public dispose(): void {
    this.playSessionId += 1;
    this.clearCompletionTimer();
    this.audioEngine.stopAll();
  }

  private clearCompletionTimer(): void {
    if (this.completionTimer !== null) {
      globalThis.clearTimeout(this.completionTimer);
      this.completionTimer = null;
    }
  }

  private computeMeasureBounds(startMeasureIndex: number): {
    startTick: number;
    totalTicks: number;
  } {
    const doc = this.scoreStore.getState().document;
    let runningTick = 0;
    let startTick = 0;

    for (let i = 0; i < doc.measures.length; i += 1) {
      if (i === startMeasureIndex) {
        startTick = runningTick;
      }
      const measure = doc.measures[i];
      if (measure) {
        for (const note of measure.notes) {
          runningTick += note.durationTicks;
        }
      }
    }

    return {
      startTick,
      totalTicks: runningTick,
    };
  }

  private scheduleFromTick(fromTick: number, bpm: number): Result<void> {
    const doc = this.scoreStore.getState().document;
    const resolvedNotes = resolveScoreNotes(doc);

    const scheduledNotes: ScheduledNote[] = [];
    for (const rn of resolvedNotes) {
      if (rn.midiPitch === null) {
        continue;
      }
      const noteEndTick = rn.startTickInScore + rn.durationTicks;
      if (noteEndTick <= fromTick) {
        continue;
      }
      const effectiveStartTick = Math.max(fromTick, rn.startTickInScore);
      const remainingTicks = noteEndTick - effectiveStartTick;
      scheduledNotes.push({
        noteId: rn.noteId,
        midiPitch: rn.midiPitch,
        startTimeMs: ticksToMs(effectiveStartTick - fromTick, bpm),
        durationMs: ticksToMs(remainingTicks, bpm),
      });
    }

    const noteRes = this.audioEngine.scheduleNotes(scheduledNotes);
    if (!noteRes.ok) {
      return noteRes;
    }

    if (this.store.getState().metronomeEnabled) {
      const beatTicks = getBeatTicks(doc.timeSignature);
      const metroTicks: ScheduledMetronomeTick[] = [];
      let measureStart = 0;
      let tickIdx = 0;

      for (const measure of doc.measures) {
        let measureDuration = 0;
        for (const n of measure.notes) {
          measureDuration += n.durationTicks;
        }
        const measureEnd = measureStart + measureDuration;
        let beatPos = 0;
        for (
          let tick = measureStart;
          tick < measureEnd;
          tick += beatTicks
        ) {
          if (tick >= fromTick) {
            metroTicks.push({
              tickIndex: tickIdx,
              timeMs: ticksToMs(tick - fromTick, bpm),
              isAccent: beatPos === 0,
            });
            tickIdx += 1;
          }
          beatPos += 1;
        }
        measureStart = measureEnd;
      }

      if (metroTicks.length > 0) {
        const metroRes = this.audioEngine.scheduleMetronome(metroTicks);
        if (!metroRes.ok) {
          return metroRes;
        }
      }
    }

    this.anchorScoreTick = fromTick;
    this.anchorEngineTimeMs = this.audioEngine.getCurrentTimeMs();

    const remainingTotalTicks = Math.max(0, this.totalScoreTicks - fromTick);
    const delayMs = Math.max(
      20,
      Math.ceil(ticksToMs(remainingTotalTicks, bpm) + this.audioEngine.lookaheadMs)
    );
    this.completionTimer = globalThis.setTimeout(() => {
      this.completionTimer = null;
      this.completePlayback();
    }, delayMs);

    return { ok: true, value: undefined };
  }
}

export function createPlaybackController(
  deps?: PlaybackControllerDeps
): PlaybackController {
  return new PlaybackController(deps);
}

export const playbackController: PlaybackController =
  createPlaybackController();

export function usePlaybackStore<T>(
  selector: (state: PlaybackSnapshot) => T,
  controller: PlaybackController = playbackController
): T {
  return useStore(controller.getStore(), selector);
}
