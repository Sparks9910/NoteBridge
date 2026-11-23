import { useNotationStore } from '../application/notation-store.ts';
import { playbackController } from '../application/playback-controller.ts';
import {
  practiceStore,
  resolveTrackAudibility,
  usePracticeStore,
} from '../application/practice-store.ts';
import { useScoreStore } from '../application/score-store.ts';
import { getInstrumentProfile } from '../domain/v2-instruments.ts';

export function TrackMixerBar() {
  const docId = useScoreStore((s) => s.document.id);
  const boundScoreId = useNotationStore((s) => s.boundScoreId);
  const tracks = useNotationStore((s) => s.tracks);
  const trackMixByTrackId = usePracticeStore((s) => s.trackMixByTrackId);

  const isBound = boundScoreId === null || boundScoreId === docId;
  if (!isBound || tracks.length < 2) {
    return null;
  }

  const audibility = resolveTrackAudibility(
    tracks.map((t) => t.id),
    trackMixByTrackId
  );
  const leadTrackId = tracks[0]!.id;

  return (
    <div
      className="nb-mixer-bar"
      data-testid="track-mixer-bar"
      aria-label="多轨伴奏混音条"
    >
      <div className="nb-mixer-header">
        <span className="nb-group-label">多轨混音（{tracks.length} 轨）</span>
        <div className="nb-mixer-actions">
          <button
            type="button"
            className="nb-btn nb-btn-sm"
            data-testid="btn-mute-lead-track"
            onClick={() => {
              practiceStore.getState().muteLeadTrackForPlayAlong(leadTrackId);
              playbackController.refreshMixLive();
            }}
          >
            消主音跟弹
          </button>
          <button
            type="button"
            className="nb-btn nb-btn-sm"
            data-testid="btn-reset-mixer"
            onClick={() => {
              practiceStore.getState().resetTrackMixer();
              playbackController.refreshMixLive();
            }}
          >
            重置混音
          </button>
        </div>
      </div>

      <div className="nb-mixer-channels">
        {tracks.map((tr) => {
          const ch = trackMixByTrackId[tr.id] ?? {
            muted: false,
            solo: false,
            gain: 1,
          };
          const res = audibility[tr.id] ?? { audible: true, effectiveGain: 1 };
          const instName = getInstrumentProfile(tr.instrumentId).shortName;
          const gainPercent = Math.round(ch.gain * 100);

          return (
            <div
              key={tr.id}
              className={`nb-mixer-channel ${res.audible ? '' : 'nb-mixer-channel-silenced'}`}
              data-testid={`mixer-track-${tr.id}`}
              data-audible={res.audible ? 'true' : 'false'}
            >
              <div className="nb-mixer-track-info">
                <strong className="nb-mixer-track-name" title={tr.name}>
                  {tr.name}
                </strong>
                <span className="nb-mixer-track-inst">{instName}</span>
              </div>

              <div className="nb-mixer-controls">
                <button
                  type="button"
                  className={`nb-btn nb-btn-sm ${ch.muted ? 'nb-btn-danger-active' : ''}`}
                  data-testid={`mixer-mute-${tr.id}`}
                  aria-pressed={ch.muted}
                  title="静音此轨"
                  onClick={() => {
                    practiceStore.getState().toggleTrackMute(tr.id);
                    playbackController.refreshMixLive();
                  }}
                >
                  M 静音
                </button>
                <button
                  type="button"
                  className={`nb-btn nb-btn-sm ${ch.solo ? 'nb-btn-solo-active' : ''}`}
                  data-testid={`mixer-solo-${tr.id}`}
                  aria-pressed={ch.solo}
                  title="独奏此轨"
                  onClick={() => {
                    practiceStore.getState().toggleTrackSolo(tr.id);
                    playbackController.refreshMixLive();
                  }}
                >
                  S 独奏
                </button>
                <label className="nb-mixer-gain-field">
                  <input
                    type="range"
                    min={0}
                    max={150}
                    step={5}
                    aria-label={`${tr.name} 音量`}
                    data-testid={`mixer-gain-${tr.id}`}
                    value={gainPercent}
                    onChange={(e) => {
                      practiceStore
                        .getState()
                        .setTrackGain(tr.id, Number(e.target.value) / 100);
                      playbackController.refreshMixLive();
                    }}
                  />
                  <span className="nb-mixer-gain-val">{gainPercent}%</span>
                </label>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
