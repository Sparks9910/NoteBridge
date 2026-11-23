import { useEffect, useMemo } from 'react';
import { playbackController } from '../application/playback-controller.ts';
import {
  practiceStore,
  usePracticeStore,
} from '../application/practice-store.ts';
import { tunerStore, useTunerStore } from '../application/tuner-store.ts';
import {
  getInstrumentProfile,
  getTuningPreset,
} from '../domain/v2-instruments.ts';
import {
  buildTargetStringsFromTuning,
  type TunerStatus,
} from '../domain/v2-tuner.ts';

const STATUS_LABELS: Record<TunerStatus, string> = {
  flat: '偏低 (需拧紧)',
  'in-tune': '音准准确',
  sharp: '偏高 (需放松)',
};

export function TunerPanel() {
  const selectedInstrumentId = usePracticeStore((s) => s.selectedInstrumentId);
  const tuningPresetId = usePracticeStore((s) => s.tuningPresetId);
  const capo = usePracticeStore((s) => s.capo);

  const status = useTunerStore((s) => s.status);
  const a4Hz = useTunerStore((s) => s.a4Hz);
  const selectedStringNumber = useTunerStore((s) => s.selectedStringNumber);
  const reading = useTunerStore((s) => s.reading);
  const error = useTunerStore((s) => s.error);

  const profile = getInstrumentProfile(selectedInstrumentId);
  const effectivePreset = getTuningPreset(
    profile.availableTuningIds.length > 0 ? tuningPresetId : 'standard-6'
  );
  const safeCapo = profile.supportsCapo ? capo : 0;

  const targetStrings = useMemo(
    () =>
      buildTargetStringsFromTuning(
        effectivePreset.openStringMidis,
        effectivePreset.stringLabels,
        safeCapo,
        a4Hz
      ),
    [
      effectivePreset.openStringMidis,
      effectivePreset.stringLabels,
      safeCapo,
      a4Hz,
    ]
  );

  useEffect(() => {
    tunerStore.getState().setTargetStrings(targetStrings);
  }, [targetStrings]);

  useEffect(() => {
    return () => {
      tunerStore.getState().stop();
    };
  }, []);

  const isListening = status === 'listening' || status === 'starting';
  const activeCents = reading
    ? Math.max(
        -50,
        Math.min(
          50,
          reading.matchedString
            ? reading.matchedString.centsFromTarget
            : reading.centsOff
        )
      )
    : 0;
  const needlePercent = 50 + activeCents;

  return (
    <section
      className="nb-tuner-panel"
      data-testid="tuner-panel"
      aria-label="内置网页调音器"
    >
      <div className="nb-tuner-header">
        <div className="nb-tuner-title-wrap">
          <strong>内置网页调音器</strong>
          <span className="nb-help-text">
            当前调弦：{effectivePreset.label}
            {safeCapo > 0 ? ` · Capo ${safeCapo}` : ''}
          </span>
        </div>

        <div className="nb-tuner-actions">
          <label className="nb-field nb-field-compact">
            <span className="nb-field-label">标准音</span>
            <select
              className="nb-select nb-select-sm"
              data-testid="tuner-a4-select"
              value={a4Hz}
              onChange={(e) => tunerStore.getState().setA4Hz(Number(e.target.value))}
            >
              <option value={432}>A4 = 432 Hz</option>
              <option value={440}>A4 = 440 Hz</option>
              <option value={442}>A4 = 442 Hz</option>
            </select>
          </label>

          <button
            type="button"
            className={`nb-btn nb-btn-sm ${isListening ? 'nb-btn-danger' : 'nb-btn-primary'}`}
            data-testid="btn-tuner-mic-toggle"
            onClick={() => {
              if (isListening) {
                tunerStore.getState().stop();
              } else {
                void tunerStore.getState().start(targetStrings);
              }
            }}
          >
            {status === 'starting'
              ? '正在启动麦克风...'
              : isListening
                ? '停止收音'
                : '开启麦克风校音'}
          </button>

          <button
            type="button"
            className="nb-btn nb-btn-sm"
            data-testid="btn-tuner-close"
            onClick={() => {
              tunerStore.getState().stop();
              practiceStore.getState().toggleTunerPanel(false);
            }}
          >
            关闭
          </button>
        </div>
      </div>

      {error && (
        <div
          className="nb-error-banner"
          data-testid="tuner-error-banner"
          role="alert"
        >
          <span>{error.detail}</span>
          <button
            type="button"
            className="nb-btn-close"
            onClick={() => tunerStore.getState().clearError()}
          >
            关闭
          </button>
        </div>
      )}

      <div className="nb-tuner-body">
        <div className="nb-tuner-meter-card">
          <div className="nb-tuner-readouts">
            <span className="nb-tuner-note" data-testid="tuner-detected-note">
              {reading ? reading.noteLabel : '--'}
            </span>
            <span className="nb-tuner-hz" data-testid="tuner-detected-hz">
              {reading ? `${reading.frequencyHz.toFixed(1)} Hz` : '等待拨弦或点击右侧弦号试听'}
            </span>
            <span
              className={`nb-tuner-status nb-tuner-${reading?.status ?? 'idle'}`}
              data-testid="tuner-status-badge"
            >
              {reading ? STATUS_LABELS[reading.status] : '待机中'}
            </span>
          </div>

          <div className="nb-tuner-gauge" aria-label="音分偏差表盘">
            <div className="nb-tuner-gauge-track">
              <div className="nb-tuner-gauge-sweetspot" />
              <div
                className="nb-tuner-gauge-needle"
                style={{ left: `${needlePercent}%` }}
              />
            </div>
            <div className="nb-tuner-gauge-labels">
              <span>-50 ¢ 偏低</span>
              <span data-testid="tuner-cents-readout">
                {reading
                  ? `${activeCents >= 0 ? '+' : ''}${activeCents} 音分`
                  : '0 音分'}
              </span>
              <span>+50 ¢ 偏高</span>
            </div>
          </div>
        </div>

        <div className="nb-tuner-strings" role="group" aria-label="目标琴弦">
          <button
            type="button"
            className={`nb-btn nb-btn-sm ${selectedStringNumber === null ? 'nb-btn-active' : ''}`}
            data-testid="tuner-string-auto"
            onClick={() => tunerStore.getState().setSelectedString(null)}
          >
            自动识别弦
          </button>
          {targetStrings.map((str) => {
            const isLocked = selectedStringNumber === str.stringNumber;
            const isMatched =
              reading?.matchedString?.stringNumber === str.stringNumber;
            return (
              <button
                key={str.stringNumber}
                type="button"
                className={`nb-btn nb-btn-sm nb-tuner-str-btn ${isLocked ? 'nb-btn-active' : ''} ${isMatched ? 'nb-tuner-str-matched' : ''}`}
                data-testid={`tuner-string-${str.stringNumber}`}
                aria-pressed={isLocked}
                onClick={() => {
                  tunerStore
                    .getState()
                    .setSelectedString(isLocked ? null : str.stringNumber);
                  playbackController.previewMidi(str.midi, 550);
                }}
              >
                <strong>
                  {str.stringNumber}弦 {str.label}
                </strong>
                <small>{str.frequencyHz.toFixed(1)}Hz</small>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
