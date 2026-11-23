import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  getBeatTicks,
  getMeasureCapacityTicks,
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
import type { InstrumentId } from '../domain/v2-types.ts';
import {
  type AudioBackendMode,
  type AudioEngine,
  type ScheduledMetronomeTick,
  type ScheduledNote,
  WebAudioEngine,
} from '../infrastructure/audio-engine.ts';
import { type InputStoreApi, inputStore } from './input-store.ts';
import { type NotationStoreApi, notationStore } from './notation-store.ts';
import {
  createPracticeStore,
  type PracticeStoreApi,
  practiceStore,
  resolveTrackAudibility,
} from './practice-store.ts';
import { type ScoreStoreApi, scoreStore } from './score-store.ts';

export interface PlaybackSnapshot {
  playbackState: PlaybackState;
  loop: boolean;
  metronomeEnabled: boolean;
  startMeasureIndex: number;
  currentBpm: number;
  audioBackendMode: AudioBackendMode;
  currentInstrumentId: InstrumentId;
  activeSpeedPercent: number;
  isCountingIn: boolean;
  lastError: AppError | null;
}

export interface PlaybackControllerDeps {
  scoreStore?: ScoreStoreApi;
  inputStore?: InputStoreApi;
  notationStore?: NotationStoreApi;
  practiceStore?: PracticeStoreApi;
  audioEngine?: AudioEngine;
}

export class PlaybackController {
  private readonly scoreStore: ScoreStoreApi;
  private readonly inputStore: InputStoreApi;
  private readonly notationStore: NotationStoreApi;
  private readonly practiceStore: PracticeStoreApi;
  private readonly audioEngine: AudioEngine;
  private readonly store: StoreApi<PlaybackSnapshot>;

  private anchorScoreTick = 0;
  private anchorEngineTimeMs = 0;
  private pausedScoreTick = 0;
  private startMeasureTick = 0;
  private endScoreTick = 0;
  private totalScoreTicks = 0;
  private countInDurationMs = 0;
  private countInBeatDurationMs = 0;
  private countInBeats = 0;
  private playSessionId = 0;
  private completionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps?: PlaybackControllerDeps) {
    this.scoreStore = deps?.scoreStore ?? scoreStore;
    this.inputStore = deps?.inputStore ?? inputStore;
    this.notationStore = deps?.notationStore ?? notationStore;
    this.practiceStore = deps?.practiceStore ?? createPracticeStore();
    this.audioEngine = deps?.audioEngine ?? new WebAudioEngine();

    const initialInstrument = this.practiceStore.getState().selectedInstrumentId;
    this.audioEngine.setInstrument?.(initialInstrument);

    this.store = createStore<PlaybackSnapshot>(() => ({
      playbackState: 'IDLE',
      loop: false,
      metronomeEnabled: false,
      startMeasureIndex: 0,
      currentBpm: this.scoreStore.getState().document.bpm,
      audioBackendMode: this.audioEngine.getBackendMode(),
      currentInstrumentId: initialInstrument,
      activeSpeedPercent: 100,
      isCountingIn: false,
      lastError: null,
    }));
  }

  public getStore(): StoreApi<PlaybackSnapshot> {
    return this.store;
  }

  public getSnapshot(): PlaybackSnapshot {
    return this.store.getState();
  }

  public setInstrument(instrumentId: InstrumentId): void {
    this.audioEngine.setInstrument?.(instrumentId);
    this.store.setState({ currentInstrumentId: instrumentId });
  }

  public getCountInBeat(): number | null {
    const snap = this.store.getState();
    if (
      snap.playbackState !== 'PLAYING' ||
      this.countInDurationMs <= 0 ||
      this.countInBeatDurationMs <= 0
    ) {
      return null;
    }
    const elapsedMs = Math.max(
      0,
      this.audioEngine.getCurrentTimeMs() - this.anchorEngineTimeMs
    );
    if (elapsedMs >= this.countInDurationMs) {
      return null;
    }
    return Math.min(
      this.countInBeats,
      Math.floor(elapsedMs / this.countInBeatDurationMs) + 1
    );
  }

  public getCurrentScoreTick(): number {
    const snap = this.store.getState();
    if (snap.playbackState === 'PLAYING') {
      const elapsedMs = Math.max(
        0,
        this.audioEngine.getCurrentTimeMs() - this.anchorEngineTimeMs
      );
      if (this.countInDurationMs > 0 && elapsedMs < this.countInDurationMs) {
        return this.startMeasureTick;
      }
      const effectiveElapsedMs = Math.max(0, elapsedMs - this.countInDurationMs);
      const rawTick =
        this.anchorScoreTick + msToTicks(effectiveElapsedMs, snap.currentBpm);
      const endBound =
        this.endScoreTick > 0 ? this.endScoreTick : this.totalScoreTicks;
      if (endBound <= 0) {
        return 0;
      }
      const effectiveLoop =
        snap.loop || this.practiceStore.getState().abLoopEnabled;
      if (effectiveLoop) {
        const span = endBound - this.startMeasureTick;
        if (span <= 0) {
          return this.startMeasureTick;
        }
        const offset = Math.max(0, rawTick - this.startMeasureTick) % span;
        return this.startMeasureTick + offset;
      }
      return Math.min(endBound, Math.max(0, rawTick));
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
    const pState = this.practiceStore.getState();
    const defaultStartIdx = pState.abLoopEnabled
      ? Math.max(0, Math.min(doc.measures.length - 1, pState.loopStartMeasure))
      : 0;
    const targetMeasureIdx = options?.startMeasureIndex ?? defaultStartIdx;

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
    if (pState.speedTrainerEnabled) {
      this.practiceStore.getState().resetSpeedTrainerRun();
    }
    const prePlayState = this.practiceStore.getState();
    const initialEffectiveBpm = this.computeEffectiveBpm(doc.bpm);
    const initialPercent = prePlayState.speedTrainerEnabled
      ? prePlayState.currentSpeedPercent
      : 100;
    this.audioEngine.setInstrument?.(prePlayState.selectedInstrumentId);

    this.store.setState({
      playbackState: startRes.value,
      startMeasureIndex: targetMeasureIdx,
      currentBpm: initialEffectiveBpm,
      currentInstrumentId: prePlayState.selectedInstrumentId,
      activeSpeedPercent: initialPercent,
      isCountingIn: false,
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
        isCountingIn: false,
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
        isCountingIn: false,
        lastError: loadRes.error,
      });
      return { ok: false, error: loadRes.error };
    }

    const readyRes = transitionPlaybackState('LOADING_AUDIO', 'AUDIO_READY');
    if (!readyRes.ok) {
      this.inputStore.getState().unlockFromPlayback();
      this.store.setState({ isCountingIn: false, lastError: readyRes.error });
      return readyRes;
    }

    const latestDoc = this.scoreStore.getState().document;
    const latestPState = this.practiceStore.getState();
    const { startTick, endTick, totalTicks } =
      this.computeMeasureBounds(targetMeasureIdx);
    this.startMeasureTick = startTick;
    this.endScoreTick = endTick;
    this.totalScoreTicks = totalTicks;

    const effectiveBpm = this.computeEffectiveBpm(latestDoc.bpm);
    const activePercent = latestPState.speedTrainerEnabled
      ? latestPState.currentSpeedPercent
      : 100;
    this.audioEngine.setInstrument?.(latestPState.selectedInstrumentId);

    this.store.setState({
      playbackState: readyRes.value,
      currentBpm: effectiveBpm,
      audioBackendMode: loadRes.value,
      currentInstrumentId: latestPState.selectedInstrumentId,
      activeSpeedPercent: activePercent,
      lastError: null,
    });

    if (endTick <= startTick) {
      const effectiveLoop =
        this.store.getState().loop || latestPState.abLoopEnabled;
      if (!effectiveLoop) {
        return this.completePlayback();
      }
      this.countInDurationMs = 0;
      this.countInBeatDurationMs = 0;
      this.countInBeats = 0;
      this.anchorScoreTick = startTick;
      this.anchorEngineTimeMs = this.audioEngine.getCurrentTimeMs();
      return { ok: true, value: 'PLAYING' };
    }

    const schedRes = this.scheduleFromTick(startTick, effectiveBpm, {
      withCountIn: latestPState.countInEnabled,
    });
    if (!schedRes.ok) {
      const errRes = transitionPlaybackState('PLAYING', 'AUDIO_FAILED');
      this.audioEngine.stopAll();
      this.inputStore.getState().unlockFromPlayback();
      this.store.setState({
        playbackState: errRes.ok ? errRes.value : 'ERROR',
        isCountingIn: false,
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
    this.countInDurationMs = 0;
    this.countInBeatDurationMs = 0;
    this.countInBeats = 0;
    this.clearCompletionTimer();
    this.audioEngine.stopAll();

    this.store.setState({
      playbackState: res.value,
      isCountingIn: false,
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
    const pState = this.practiceStore.getState();
    const { startTick, endTick, totalTicks } = this.computeMeasureBounds(
      snap.startMeasureIndex
    );
    this.startMeasureTick = startTick;
    this.endScoreTick = endTick;
    this.totalScoreTicks = totalTicks;

    const effectiveBpm = this.computeEffectiveBpm(latestDoc.bpm);
    const activePercent = pState.speedTrainerEnabled
      ? pState.currentSpeedPercent
      : 100;
    this.audioEngine.setInstrument?.(pState.selectedInstrumentId);

    this.store.setState({
      playbackState: res.value,
      currentBpm: effectiveBpm,
      currentInstrumentId: pState.selectedInstrumentId,
      activeSpeedPercent: activePercent,
      isCountingIn: false,
      lastError: null,
    });

    if (endTick <= this.pausedScoreTick) {
      const effectiveLoop = snap.loop || pState.abLoopEnabled;
      if (!effectiveLoop) {
        return this.completePlayback();
      }
      this.anchorScoreTick = this.startMeasureTick;
      this.anchorEngineTimeMs = this.audioEngine.getCurrentTimeMs();
      return { ok: true, value: 'PLAYING' };
    }

    const schedRes = this.scheduleFromTick(this.pausedScoreTick, effectiveBpm, {
      withCountIn: false,
    });
    if (!schedRes.ok) {
      const errRes = transitionPlaybackState('PLAYING', 'AUDIO_FAILED');
      this.audioEngine.stopAll();
      this.inputStore.getState().unlockFromPlayback();
      this.store.setState({
        playbackState: errRes.ok ? errRes.value : 'ERROR',
        isCountingIn: false,
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
    this.countInDurationMs = 0;
    this.countInBeatDurationMs = 0;
    this.countInBeats = 0;
    this.inputStore.getState().unlockFromPlayback();
    this.practiceStore.getState().clearActivePlaybackFrame();

    this.store.setState({
      playbackState: res.value,
      isCountingIn: false,
      lastError: null,
    });
    return res;
  }

  public completePlayback(): Result<PlaybackState> {
    const snap = this.store.getState();
    const pState = this.practiceStore.getState();
    const effectiveLoop = snap.loop || pState.abLoopEnabled;
    const res = transitionPlaybackState(snap.playbackState, 'PLAY_COMPLETE', {
      loop: effectiveLoop,
    });
    if (!res.ok) {
      this.store.setState({ lastError: res.error });
      return res;
    }

    this.clearCompletionTimer();
    this.audioEngine.stopAll();
    this.countInDurationMs = 0;
    this.countInBeatDurationMs = 0;
    this.countInBeats = 0;

    if (res.value === 'PLAYING') {
      if (pState.speedTrainerEnabled) {
        this.practiceStore.getState().advanceSpeedTrainerLoop();
      }
      const nextPState = this.practiceStore.getState();
      const latestDoc = this.scoreStore.getState().document;
      const targetStartIdx = nextPState.abLoopEnabled
        ? Math.max(
            0,
            Math.min(latestDoc.measures.length - 1, nextPState.loopStartMeasure)
          )
        : snap.startMeasureIndex;
      const { startTick, endTick, totalTicks } =
        this.computeMeasureBounds(targetStartIdx);
      this.startMeasureTick = startTick;
      this.endScoreTick = endTick;
      this.totalScoreTicks = totalTicks;

      const effectiveBpm = this.computeEffectiveBpm(latestDoc.bpm);
      const activePercent = nextPState.speedTrainerEnabled
        ? nextPState.currentSpeedPercent
        : 100;

      this.store.setState({
        startMeasureIndex: targetStartIdx,
        currentBpm: effectiveBpm,
        activeSpeedPercent: activePercent,
        isCountingIn: false,
      });

      if (endTick > startTick) {
        const schedRes = this.scheduleFromTick(startTick, effectiveBpm, {
          withCountIn: false,
        });
        if (!schedRes.ok) {
          const errRes = transitionPlaybackState('PLAYING', 'AUDIO_FAILED');
          this.inputStore.getState().unlockFromPlayback();
          this.store.setState({
            playbackState: errRes.ok ? errRes.value : 'ERROR',
            isCountingIn: false,
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
    this.practiceStore.getState().clearActivePlaybackFrame();
    this.store.setState({
      playbackState: res.value,
      isCountingIn: false,
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

  public refreshMixLive(): Result<void> {
    const snap = this.store.getState();
    if (snap.playbackState === 'PLAYING') {
      const currentTick = this.getCurrentScoreTick();
      this.clearCompletionTimer();
      this.audioEngine.stopAll();
      return this.scheduleFromTick(currentTick, snap.currentBpm, {
        withCountIn: false,
      });
    }
    return { ok: true, value: undefined };
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

    const effectiveBpm = this.computeEffectiveBpm(bpm);
    this.store.setState({ currentBpm: effectiveBpm, lastError: null });

    if (snap.playbackState === 'PLAYING') {
      this.clearCompletionTimer();
      this.audioEngine.stopAll();
      const schedRes = this.scheduleFromTick(currentTickBefore, effectiveBpm, {
        withCountIn: false,
      });
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
    return this.previewMidi(resolved.midiPitch, 280);
  }

  public previewMidi(midiPitch: number, durationMs = 280): Result<void> {
    const instId = this.practiceStore.getState().selectedInstrumentId;
    this.audioEngine.setInstrument?.(instId);

    if (this.audioEngine.getBackendMode() !== 'mock') {
      void this.audioEngine.unlock();
    }

    const res = this.audioEngine.previewNote(midiPitch, durationMs);
    if (!res.ok) {
      this.store.setState({ lastError: res.error });
    }
    return res;
  }

  public async jumpMeasureBy(delta: -1 | 1): Promise<Result<PlaybackState>> {
    const doc = this.scoreStore.getState().document;
    const measureCount = doc.measures.length;
    if (measureCount <= 0) {
      return { ok: true, value: this.store.getState().playbackState };
    }

    const snap = this.store.getState();
    const pState = this.practiceStore.getState();
    const currentTick = this.getCurrentScoreTick();
    let currentMeasureIdx = snap.startMeasureIndex;
    if (snap.playbackState === 'PLAYING' || snap.playbackState === 'PAUSED') {
      let running = 0;
      for (let i = 0; i < doc.measures.length; i += 1) {
        const mTicks =
          doc.measures[i]?.notes.reduce((s, n) => s + n.durationTicks, 0) ?? 0;
        if (currentTick >= running && currentTick < running + mTicks) {
          currentMeasureIdx = i;
          break;
        }
        running += mTicks;
      }
    } else {
      currentMeasureIdx = pState.activeMeasureIndex;
    }

    const minIdx = pState.abLoopEnabled
      ? Math.max(0, Math.min(measureCount - 1, pState.loopStartMeasure))
      : 0;
    const maxIdx = pState.abLoopEnabled
      ? Math.max(minIdx, Math.min(measureCount - 1, pState.loopEndMeasure))
      : measureCount - 1;

    const targetIdx = Math.max(minIdx, Math.min(maxIdx, currentMeasureIdx + delta));
    if (
      snap.playbackState === 'PLAYING' ||
      snap.playbackState === 'PAUSED' ||
      snap.playbackState === 'LOADING_AUDIO'
    ) {
      return this.playFromMeasure(targetIdx);
    }

    this.practiceStore.getState().setActivePlaybackFrame({
      activeMeasureIndex: targetIdx,
    });
    this.store.setState({ startMeasureIndex: targetIdx });
    return { ok: true, value: snap.playbackState };
  }

  public async restartFromLoopStart(): Promise<Result<PlaybackState>> {
    const doc = this.scoreStore.getState().document;
    const pState = this.practiceStore.getState();
    const targetIdx = pState.abLoopEnabled
      ? Math.max(0, Math.min(doc.measures.length - 1, pState.loopStartMeasure))
      : 0;
    return this.playFromMeasure(targetIdx);
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

  private computeEffectiveBpm(baseBpm: number): number {
    const pState = this.practiceStore.getState();
    const percent = pState.speedTrainerEnabled ? pState.currentSpeedPercent : 100;
    return Math.max(24, Math.min(240, Math.round((baseBpm * percent) / 100)));
  }

  private computeMeasureBounds(startMeasureIndex: number): {
    startTick: number;
    endTick: number;
    totalTicks: number;
  } {
    const doc = this.scoreStore.getState().document;
    const pState = this.practiceStore.getState();
    const measureCount = doc.measures.length;
    const clampedEndMeasure = pState.abLoopEnabled
      ? Math.max(
          startMeasureIndex,
          Math.min(measureCount - 1, pState.loopEndMeasure)
        )
      : Math.max(0, measureCount - 1);

    let runningTick = 0;
    let startTick = 0;
    let endTick = 0;

    for (let i = 0; i < measureCount; i += 1) {
      if (i === startMeasureIndex) {
        startTick = runningTick;
      }
      const measure = doc.measures[i];
      if (measure) {
        for (const note of measure.notes) {
          runningTick += note.durationTicks;
        }
      }
      if (i === clampedEndMeasure) {
        endTick = runningTick;
      }
    }

    if (endTick === 0 && !pState.abLoopEnabled) {
      endTick = runningTick;
    }

    return {
      startTick,
      endTick,
      totalTicks: runningTick,
    };
  }

  private scheduleFromTick(
    fromTick: number,
    bpm: number,
    options?: { withCountIn?: boolean }
  ): Result<void> {
    const doc = this.scoreStore.getState().document;
    const pState = this.practiceStore.getState();
    const resolvedNotes = resolveScoreNotes(doc);
    const endTick =
      this.endScoreTick > 0 ? this.endScoreTick : this.totalScoreTicks;

    let countInBeats = 0;
    let countInBeatDurationMs = 0;
    let countInDurationMs = 0;
    if (options?.withCountIn) {
      const beatTicks = getBeatTicks(doc.timeSignature);
      const measureTicks = getMeasureCapacityTicks(doc.timeSignature);
      countInBeats = Math.max(1, Math.round(measureTicks / beatTicks));
      countInBeatDurationMs = ticksToMs(beatTicks, bpm);
      countInDurationMs = countInBeats * countInBeatDurationMs;
    }
    this.countInBeats = countInBeats;
    this.countInBeatDurationMs = countInBeatDurationMs;
    this.countInDurationMs = countInDurationMs;
    this.store.setState({ isCountingIn: countInDurationMs > 0 });

    const nState = this.notationStore.getState();
    const hasBoundNotation = nState.boundScoreId === doc.id && nState.tracks.length > 0;
    const trackIds = hasBoundNotation
      ? nState.tracks.map((t) => t.id)
      : ['track_main'];
    const audibility = resolveTrackAudibility(trackIds, pState.trackMixByTrackId);
    const mainTrack = hasBoundNotation ? nState.tracks[0] : undefined;
    const mainTrackId = mainTrack?.id ?? 'track_main';
    const mainMix = audibility[mainTrackId] ?? {
      audible: true,
      effectiveGain: 1,
    };

    const scheduledNotes: ScheduledNote[] = [];
    if (!pState.muteRightHand && mainMix.audible) {
      const mainVelocity = Math.max(
        0.05,
        Math.min(1, 0.85 * mainMix.effectiveGain)
      );
      for (const rn of resolvedNotes) {
        if (rn.midiPitch === null) {
          continue;
        }
        const noteEndTick = Math.min(
          rn.startTickInScore + rn.durationTicks,
          endTick
        );
        if (noteEndTick <= fromTick || rn.startTickInScore >= endTick) {
          continue;
        }
        const effectiveStartTick = Math.max(fromTick, rn.startTickInScore);
        const remainingTicks = noteEndTick - effectiveStartTick;
        scheduledNotes.push({
          noteId: rn.noteId,
          midiPitch: rn.midiPitch,
          startTimeMs:
            countInDurationMs + ticksToMs(effectiveStartTick - fromTick, bpm),
          durationMs: ticksToMs(remainingTicks, bpm),
          velocity: mainVelocity,
          trackId: mainTrackId,
          instrumentId: pState.selectedInstrumentId,
        });
      }
    }

    // 并行调度 Voice 2（低音声部 / 钢琴左手）音符，保持时间轴同步
    if (!pState.muteLeftHand && hasBoundNotation && mainMix.audible) {
      const voice2 = mainTrack?.voices[1];
      if (voice2) {
        const v2Velocity = Math.max(
          0.05,
          Math.min(1, 0.8 * mainMix.effectiveGain)
        );
        let mStartTick = 0;
        for (let mIdx = 0; mIdx < doc.measures.length; mIdx += 1) {
          const v1Measure = doc.measures[mIdx];
          const v2Measure = voice2.measures[mIdx];
          const v1Ticks = v1Measure
            ? v1Measure.notes.reduce((sum, n) => sum + n.durationTicks, 0)
            : 0;
          if (v2Measure) {
            let v2Tick = mStartTick;
            for (const beat of v2Measure.beats) {
              const beatEnd = Math.min(v2Tick + beat.durationTicks, endTick);
              if (!beat.isRest && beatEnd > fromTick && v2Tick < endTick) {
                const effStart = Math.max(fromTick, v2Tick);
                const remTicks = beatEnd - effStart;
                for (const pNode of beat.notes) {
                  scheduledNotes.push({
                    noteId: beat.id,
                    midiPitch: pNode.midiPitch,
                    startTimeMs:
                      countInDurationMs + ticksToMs(effStart - fromTick, bpm),
                    durationMs: ticksToMs(remTicks, bpm),
                    velocity: v2Velocity,
                    trackId: mainTrackId,
                    instrumentId: pState.selectedInstrumentId,
                  });
                }
              }
              v2Tick += beat.durationTicks;
            }
          }
          mStartTick += v1Ticks;
        }
      }
    }

    // 并行调度第 2 轨及后续伴奏轨（支持 Guitar Pro / MusicXML 多轨混音 Mute / Solo）
    if (hasBoundNotation && nState.tracks.length > 1) {
      const fallbackCapTicks = getMeasureCapacityTicks(doc.timeSignature);
      const measureStartTicks: number[] = [];
      let runningMeasureTick = 0;
      for (let mIdx = 0; mIdx < doc.measures.length; mIdx += 1) {
        measureStartTicks.push(runningMeasureTick);
        const mTicks =
          doc.measures[mIdx]?.notes.reduce((s, n) => s + n.durationTicks, 0) ?? 0;
        runningMeasureTick += mTicks > 0 ? mTicks : fallbackCapTicks;
      }

      for (let tIdx = 1; tIdx < nState.tracks.length; tIdx += 1) {
        const track = nState.tracks[tIdx]!;
        const mix = audibility[track.id];
        if (!mix || !mix.audible) {
          continue;
        }
        const trackVelocity = Math.max(
          0.05,
          Math.min(1, 0.82 * mix.effectiveGain)
        );
        for (const voice of track.voices) {
          for (let mIdx = 0; mIdx < voice.measures.length; mIdx += 1) {
            const m = voice.measures[mIdx];
            if (!m) continue;
            const mStart =
              measureStartTicks[mIdx] ?? mIdx * fallbackCapTicks;
            let bTick = mStart;
            for (const beat of m.beats) {
              const beatEnd = Math.min(bTick + beat.durationTicks, endTick);
              if (!beat.isRest && beatEnd > fromTick && bTick < endTick) {
                const effStart = Math.max(fromTick, bTick);
                const remTicks = beatEnd - effStart;
                for (const pNode of beat.notes) {
                  scheduledNotes.push({
                    noteId: `${track.id}:${beat.id}`,
                    midiPitch: pNode.midiPitch,
                    startTimeMs:
                      countInDurationMs + ticksToMs(effStart - fromTick, bpm),
                    durationMs: ticksToMs(remTicks, bpm),
                    velocity: trackVelocity,
                    trackId: track.id,
                    instrumentId: track.instrumentId,
                  });
                }
              }
              bTick += beat.durationTicks;
            }
          }
        }
      }
    }

    const noteRes = this.audioEngine.scheduleNotes(scheduledNotes);
    if (!noteRes.ok) {
      return noteRes;
    }

    const metroTicks: ScheduledMetronomeTick[] = [];
    let tickIdx = 0;

    if (countInBeats > 0) {
      for (let i = 0; i < countInBeats; i += 1) {
        metroTicks.push({
          tickIndex: tickIdx,
          timeMs: i * countInBeatDurationMs,
          isAccent: i === 0,
        });
        tickIdx += 1;
      }
    }

    if (this.store.getState().metronomeEnabled) {
      const beatTicks = getBeatTicks(doc.timeSignature);
      let measureStart = 0;

      for (const measure of doc.measures) {
        let measureDuration = 0;
        for (const n of measure.notes) {
          measureDuration += n.durationTicks;
        }
        const measureEnd = measureStart + measureDuration;
        let beatPos = 0;
        for (
          let tick = measureStart;
          tick < measureEnd && tick < endTick;
          tick += beatTicks
        ) {
          if (tick >= fromTick) {
            metroTicks.push({
              tickIndex: tickIdx,
              timeMs: countInDurationMs + ticksToMs(tick - fromTick, bpm),
              isAccent: beatPos === 0,
            });
            tickIdx += 1;
          }
          beatPos += 1;
        }
        measureStart = measureEnd;
      }
    }

    if (metroTicks.length > 0) {
      const metroRes = this.audioEngine.scheduleMetronome(metroTicks);
      if (!metroRes.ok) {
        return metroRes;
      }
    }

    this.anchorScoreTick = fromTick;
    this.anchorEngineTimeMs = this.audioEngine.getCurrentTimeMs();

    const remainingBoundTicks = Math.max(0, endTick - fromTick);
    const delayMs = Math.max(
      20,
      Math.ceil(
        countInDurationMs +
          ticksToMs(remainingBoundTicks, bpm) +
          this.audioEngine.lookaheadMs
      )
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

export const playbackController: PlaybackController = createPlaybackController({
  practiceStore,
});

export function usePlaybackStore<T>(
  selector: (state: PlaybackSnapshot) => T,
  controller: PlaybackController = playbackController
): T {
  return useStore(controller.getStore(), selector);
}
