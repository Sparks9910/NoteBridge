import {
  playbackController,
  usePlaybackStore,
} from '../application/playback-controller.ts';
import type { PlaybackState } from '../domain/types.ts';

const PLAYBACK_STATUS_LABELS: Record<PlaybackState, string> = {
  IDLE: '空闲就绪',
  LOADING_AUDIO: '正在加载音源...',
  PLAYING: '播放中',
  PAUSED: '已暂停',
  ERROR: '播放异常',
};

export function PlaybackBar() {
  const playbackState = usePlaybackStore((s) => s.playbackState);
  const loop = usePlaybackStore((s) => s.loop);
  const metronomeEnabled = usePlaybackStore((s) => s.metronomeEnabled);
  const startMeasureIndex = usePlaybackStore((s) => s.startMeasureIndex);
  const currentBpm = usePlaybackStore((s) => s.currentBpm);
  const activeSpeedPercent = usePlaybackStore((s) => s.activeSpeedPercent);
  const lastError = usePlaybackStore((s) => s.lastError);

  const canStop =
    playbackState === 'PLAYING' ||
    playbackState === 'PAUSED' ||
    playbackState === 'LOADING_AUDIO';

  return (
    <section className="nb-playback-bar" aria-label="播放控制栏">
      <div className="nb-playback-controls">
        {(playbackState === 'IDLE' || playbackState === 'LOADING_AUDIO') && (
          <button
            type="button"
            className="nb-btn nb-btn-primary"
            data-testid="btn-play"
            disabled={playbackState === 'LOADING_AUDIO'}
            onClick={() => {
              void playbackController.play();
            }}
          >
            {playbackState === 'LOADING_AUDIO' ? '加载音源中...' : '播放'}
          </button>
        )}

        {playbackState === 'PLAYING' && (
          <button
            type="button"
            className="nb-btn nb-btn-primary"
            data-testid="btn-pause"
            onClick={() => playbackController.pause()}
          >
            暂停
          </button>
        )}

        {playbackState === 'PAUSED' && (
          <button
            type="button"
            className="nb-btn nb-btn-primary"
            data-testid="btn-resume"
            onClick={() => playbackController.resume()}
          >
            继续
          </button>
        )}

        <button
          type="button"
          className="nb-btn"
          data-testid="btn-stop"
          disabled={!canStop}
          onClick={() => playbackController.stop()}
        >
          停止
        </button>

        <label className="nb-toggle">
          <input
            type="checkbox"
            data-testid="toggle-loop"
            checked={loop}
            onChange={(e) => playbackController.setLoop(e.target.checked)}
          />
          <span>循环播放</span>
        </label>

        <label className="nb-toggle">
          <input
            type="checkbox"
            data-testid="toggle-metronome"
            checked={metronomeEnabled}
            onChange={(e) =>
              playbackController.setMetronomeEnabled(e.target.checked)
            }
          />
          <span>节拍器</span>
        </label>

        <span
          className={`nb-playback-status nb-pb-${playbackState.toLowerCase()}`}
          data-testid="playback-status"
        >
          {PLAYBACK_STATUS_LABELS[playbackState]}
          {playbackState === 'PLAYING' && startMeasureIndex > 0
            ? `（第 ${startMeasureIndex + 1} 小节起）`
            : ''}
          {playbackState === 'PLAYING' && activeSpeedPercent !== 100
            ? ` · ${activeSpeedPercent}% (${currentBpm} BPM)`
            : ''}
        </span>
      </div>

      {lastError && (
        <div
          className="nb-error-banner"
          data-testid="playback-error-banner"
          role="alert"
        >
          <span>{lastError.detail}</span>
          {playbackState === 'ERROR' && (
            <button
              type="button"
              className="nb-btn nb-btn-sm"
              data-testid="btn-reset-playback-error"
              onClick={() => playbackController.resetError()}
            >
              重置播放状态
            </button>
          )}
        </div>
      )}
    </section>
  );
}
