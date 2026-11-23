import { useEffect } from 'react';
import {
  playbackController,
  usePlaybackStore,
} from '../application/playback-controller.ts';
import {
  practiceStore,
  usePracticeStore,
} from '../application/practice-store.ts';
import { useScoreStore } from '../application/score-store.ts';
import { workspaceStore } from '../application/workspace-store.ts';
import {
  getInstrumentProfile,
  getTuningPreset,
  PRACTICE_INSTRUMENT_IDS,
  type TuningPresetId,
} from '../domain/v2-instruments.ts';
import type { InstrumentId, ViewLayerType } from '../domain/v2-types.ts';
import { TrackMixerBar } from './TrackMixerBar.tsx';

const INSTRUMENT_TEST_IDS: Record<InstrumentId, string> = {
  'electric-guitar-clean': 'practice-inst-electric-guitar',
  'electric-guitar-od': 'practice-inst-electric-guitar',
  'acoustic-guitar': 'practice-inst-acoustic-guitar',
  piano: 'practice-inst-piano',
  bass: 'practice-inst-bass',
  melody: 'practice-inst-melody',
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') {
    return false;
  }
  const el = target as HTMLElement;
  const tag = el.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  return Boolean(el.isContentEditable);
}

export function PracticeControlBar() {
  const doc = useScoreStore((s) => s.document);
  const playbackState = usePlaybackStore((s) => s.playbackState);

  const selectedInstrumentId = usePracticeStore((s) => s.selectedInstrumentId);
  const guitarTone = usePracticeStore((s) => s.guitarTone);
  const tuningPresetId = usePracticeStore((s) => s.tuningPresetId);
  const capo = usePracticeStore((s) => s.capo);
  const practiceViews = usePracticeStore((s) => s.practiceViews);
  const manualFretPositions = usePracticeStore((s) => s.manualFretPositions);
  const muteRightHand = usePracticeStore((s) => s.muteRightHand);
  const muteLeftHand = usePracticeStore((s) => s.muteLeftHand);

  const abLoopEnabled = usePracticeStore((s) => s.abLoopEnabled);
  const loopStartMeasure = usePracticeStore((s) => s.loopStartMeasure);
  const loopEndMeasure = usePracticeStore((s) => s.loopEndMeasure);
  const countInEnabled = usePracticeStore((s) => s.countInEnabled);
  const countInBeat = usePracticeStore((s) => s.countInBeat);
  const speedTrainerEnabled = usePracticeStore((s) => s.speedTrainerEnabled);
  const speedStartPercent = usePracticeStore((s) => s.speedStartPercent);
  const speedStepPercent = usePracticeStore((s) => s.speedStepPercent);
  const speedTargetPercent = usePracticeStore((s) => s.speedTargetPercent);
  const currentSpeedPercent = usePracticeStore((s) => s.currentSpeedPercent);
  const completedLoopCount = usePracticeStore((s) => s.completedLoopCount);
  const autoScrollEnabled = usePracticeStore((s) => s.autoScrollEnabled);
  const showTunerPanel = usePracticeStore((s) => s.showTunerPanel);

  const profile = getInstrumentProfile(selectedInstrumentId);
  const measureCount = Math.max(1, doc.measures.length);
  const clampedA = Math.min(loopStartMeasure, measureCount - 1);
  const clampedB = Math.max(clampedA, Math.min(loopEndMeasure, measureCount - 1));
  const manualCount = Object.keys(manualFretPositions).length;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) {
        return;
      }
      if (isEditableTarget(e.target)) {
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        const st = playbackController.getSnapshot().playbackState;
        if (st === 'PLAYING') {
          playbackController.pause();
        } else if (st === 'PAUSED') {
          playbackController.resume();
        } else if (st === 'IDLE') {
          void playbackController.play();
        }
        return;
      }

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        void playbackController.jumpMeasureBy(-1);
        return;
      }

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        void playbackController.jumpMeasureBy(1);
        return;
      }

      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        void playbackController.restartFromLoopStart();
      }
    };

    globalThis.addEventListener('keydown', onKeyDown);
    return () => {
      globalThis.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const handleSelectInstrument = (id: InstrumentId) => {
    practiceStore.getState().selectInstrument(id);
    const resolvedId = practiceStore.getState().selectedInstrumentId;
    playbackController.setInstrument(resolvedId);
  };

  const handleGuitarTone = (tone: 'clean' | 'overdrive') => {
    practiceStore.getState().setGuitarTone(tone);
    playbackController.setInstrument(
      practiceStore.getState().selectedInstrumentId
    );
  };

  const layers: ReadonlyArray<{
    id: ViewLayerType;
    label: string;
    testId: string;
  }> = [
    { id: 'staff', label: '五线谱', testId: 'practice-layer-staff' },
    { id: 'jianpu', label: '简谱', testId: 'practice-layer-jianpu' },
    { id: 'tab', label: '六线谱 TAB', testId: 'practice-layer-tab' },
  ];

  return (
    <section
      className="nb-practice-bar"
      data-testid="practice-mode-bar"
      aria-label="练谱模式控制中心"
    >
      <div className="nb-practice-row">
        <div className="nb-practice-group">
          <span className="nb-practice-badge">练谱模式</span>
          <div className="nb-practice-inst-tabs" role="group" aria-label="练习乐器">
            {PRACTICE_INSTRUMENT_IDS.map((instId) => {
              const p = getInstrumentProfile(instId);
              const isSelected =
                instId === 'electric-guitar-clean'
                  ? selectedInstrumentId === 'electric-guitar-clean' ||
                    selectedInstrumentId === 'electric-guitar-od'
                  : selectedInstrumentId === instId;
              return (
                <button
                  key={instId}
                  type="button"
                  className={`nb-btn nb-btn-sm ${isSelected ? 'nb-btn-active' : ''}`}
                  data-testid={INSTRUMENT_TEST_IDS[instId]}
                  aria-pressed={isSelected}
                  onClick={() => handleSelectInstrument(instId)}
                >
                  {p.shortName}
                </button>
              );
            })}
          </div>
        </div>

        <div className="nb-practice-group" role="group" aria-label="练谱图层">
          <span className="nb-field-label">谱面：</span>
          {layers.map((layer) => (
            <button
              key={layer.id}
              type="button"
              className={`nb-btn nb-btn-sm ${practiceViews[layer.id] ? 'nb-btn-active' : ''}`}
              data-testid={layer.testId}
              aria-pressed={practiceViews[layer.id]}
              onClick={() => practiceStore.getState().togglePracticeView(layer.id)}
            >
              {layer.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          className={`nb-btn nb-btn-sm ${showTunerPanel ? 'nb-btn-active' : ''}`}
          data-testid="btn-toggle-tuner"
          aria-pressed={showTunerPanel}
          onClick={() => practiceStore.getState().toggleTunerPanel()}
        >
          调音器
        </button>

        <button
          type="button"
          className="nb-btn nb-btn-primary nb-btn-sm"
          data-testid="btn-practice-to-studio"
          onClick={() => workspaceStore.getState().setWorkMode('studio')}
        >
          返回制谱对照
        </button>
      </div>

      <div className="nb-practice-row nb-practice-subrow">
        {profile.supportsGuitarTone && (
          <div className="nb-practice-group">
            <span className="nb-field-label">音色：</span>
            <button
              type="button"
              className={`nb-btn nb-btn-sm ${guitarTone === 'clean' ? 'nb-btn-active' : ''}`}
              data-testid="guitar-tone-clean"
              aria-pressed={guitarTone === 'clean'}
              onClick={() => handleGuitarTone('clean')}
            >
              清音 Clean
            </button>
            <button
              type="button"
              className={`nb-btn nb-btn-sm ${guitarTone === 'overdrive' ? 'nb-btn-active' : ''}`}
              data-testid="guitar-tone-od"
              aria-pressed={guitarTone === 'overdrive'}
              onClick={() => handleGuitarTone('overdrive')}
            >
              过载 Overdrive
            </button>
          </div>
        )}

        {profile.availableTuningIds.length > 0 && (
          <label className="nb-field">
            <span className="nb-field-label">调弦</span>
            <select
              className="nb-select nb-select-sm"
              data-testid="select-tuning-preset"
              value={tuningPresetId}
              onChange={(e) =>
                practiceStore
                  .getState()
                  .setTuningPreset(e.target.value as TuningPresetId)
              }
            >
              {profile.availableTuningIds.map((tid) => (
                <option key={tid} value={tid}>
                  {getTuningPreset(tid).label}
                </option>
              ))}
            </select>
          </label>
        )}

        {profile.supportsCapo && (
          <label className="nb-field">
            <span className="nb-field-label">变调夹</span>
            <select
              className="nb-select nb-select-sm"
              data-testid="select-capo"
              value={capo}
              onChange={(e) =>
                practiceStore.getState().setCapo(Number(e.target.value))
              }
            >
              {Array.from({ length: 13 }, (_, i) => (
                <option key={i} value={i}>
                  {i === 0 ? '无变调夹 (0品)' : `Capo ${i} 品`}
                </option>
              ))}
            </select>
          </label>
        )}

        {profile.dockType === 'fretboard' && manualCount > 0 && (
          <button
            type="button"
            className="nb-btn nb-btn-sm"
            data-testid="btn-reset-manual-frets"
            onClick={() => practiceStore.getState().clearManualFretPositions()}
          >
            重置手动把位 ({manualCount})
          </button>
        )}

        {profile.category === 'piano' && (
          <div className="nb-practice-group">
            <label className="nb-toggle">
              <input
                type="checkbox"
                data-testid="toggle-mute-right-hand"
                checked={muteRightHand}
                onChange={(e) =>
                  practiceStore.getState().setMuteRightHand(e.target.checked)
                }
              />
              <span>静音右手 (Voice 1)</span>
            </label>
            <label className="nb-toggle">
              <input
                type="checkbox"
                data-testid="toggle-mute-left-hand"
                checked={muteLeftHand}
                onChange={(e) =>
                  practiceStore.getState().setMuteLeftHand(e.target.checked)
                }
              />
              <span>静音左手 (Voice 2)</span>
            </label>
          </div>
        )}
      </div>

      <div className="nb-practice-row nb-practice-subrow">
        <div className="nb-practice-group">
          <label className="nb-toggle">
            <input
              type="checkbox"
              data-testid="toggle-ab-loop"
              checked={abLoopEnabled}
              onChange={(e) =>
                practiceStore.getState().setAbLoopEnabled(e.target.checked)
              }
            />
            <span>A–B 循环</span>
          </label>

          <select
            className="nb-select nb-select-sm"
            data-testid="select-loop-start"
            aria-label="循环起点小节 A"
            value={clampedA}
            onChange={(e) =>
              practiceStore
                .getState()
                .setLoopRange(Number(e.target.value), clampedB, measureCount)
            }
          >
            {doc.measures.map((m) => (
              <option key={m.id} value={m.index}>
                A: 第{m.index + 1}小节
              </option>
            ))}
          </select>

          <select
            className="nb-select nb-select-sm"
            data-testid="select-loop-end"
            aria-label="循环终点小节 B"
            value={clampedB}
            onChange={(e) =>
              practiceStore
                .getState()
                .setLoopRange(clampedA, Number(e.target.value), measureCount)
            }
          >
            {doc.measures.map((m) => (
              <option key={m.id} value={m.index} disabled={m.index < clampedA}>
                B: 第{m.index + 1}小节
              </option>
            ))}
          </select>

          <button
            type="button"
            className="nb-btn nb-btn-sm"
            data-testid="btn-jump-loop-start"
            onClick={() => {
              void playbackController.restartFromLoopStart();
            }}
          >
            回 A 点 (R)
          </button>
        </div>

        <div className="nb-practice-group">
          <label className="nb-toggle">
            <input
              type="checkbox"
              data-testid="toggle-count-in"
              checked={countInEnabled}
              onChange={(e) =>
                practiceStore.getState().setCountInEnabled(e.target.checked)
              }
            />
            <span>1小节预备拍</span>
          </label>

          {countInBeat !== null && playbackState === 'PLAYING' && (
            <span
              className="nb-count-in-badge"
              data-testid="count-in-indicator"
            >
              预备拍 {countInBeat}
            </span>
          )}
        </div>

        <div className="nb-practice-group">
          <label className="nb-toggle">
            <input
              type="checkbox"
              data-testid="toggle-speed-trainer"
              checked={speedTrainerEnabled}
              onChange={(e) =>
                practiceStore.getState().setSpeedTrainerEnabled(e.target.checked)
              }
            />
            <span>渐进提速</span>
          </label>

          <label className="nb-field nb-field-compact">
            <span className="nb-field-label">起%</span>
            <input
              type="number"
              className="nb-bpm-number"
              data-testid="input-speed-start"
              min={40}
              max={100}
              value={speedStartPercent}
              onChange={(e) =>
                practiceStore
                  .getState()
                  .setSpeedTrainerConfig({ startPercent: Number(e.target.value) })
              }
            />
          </label>

          <label className="nb-field nb-field-compact">
            <span className="nb-field-label">步%</span>
            <input
              type="number"
              className="nb-bpm-number"
              data-testid="input-speed-step"
              min={1}
              max={25}
              value={speedStepPercent}
              onChange={(e) =>
                practiceStore
                  .getState()
                  .setSpeedTrainerConfig({ stepPercent: Number(e.target.value) })
              }
            />
          </label>

          <label className="nb-field nb-field-compact">
            <span className="nb-field-label">终%</span>
            <input
              type="number"
              className="nb-bpm-number"
              data-testid="input-speed-target"
              min={50}
              max={150}
              value={speedTargetPercent}
              onChange={(e) =>
                practiceStore
                  .getState()
                  .setSpeedTrainerConfig({ targetPercent: Number(e.target.value) })
              }
            />
          </label>

          {speedTrainerEnabled && (
            <span
              className="nb-speed-badge"
              data-testid="speed-trainer-status"
            >
              {currentSpeedPercent}% · 第{completedLoopCount + 1}轮
            </span>
          )}
        </div>

        <label className="nb-toggle">
          <input
            type="checkbox"
            data-testid="toggle-auto-scroll"
            checked={autoScrollEnabled}
            onChange={(e) =>
              practiceStore.getState().setAutoScrollEnabled(e.target.checked)
            }
          />
          <span>自动跟随</span>
        </label>

        <span className="nb-shortcut-hint">
          快捷键：空格 播/停 · ←/→ 跳小节 · R 回A点
        </span>
      </div>

      <TrackMixerBar />
    </section>
  );
}
