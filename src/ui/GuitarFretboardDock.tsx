import { useMemo } from 'react';
import { useInputStore } from '../application/input-store.ts';
import {
  playbackController,
  usePlaybackStore,
} from '../application/playback-controller.ts';
import {
  practiceStore,
  usePracticeStore,
} from '../application/practice-store.ts';
import {
  resolveScoreForView,
  useScoreStore,
} from '../application/score-store.ts';
import {
  assignFretboardPositions,
  clampCapo,
  getInstrumentProfile,
  getTuningPreset,
  getValidFretPositions,
  midiToNoteLabel,
} from '../domain/v2-instruments.ts';

const SINGLE_MARKER_FRETS = new Set([3, 5, 7, 9, 15, 17, 19, 21]);
const DOUBLE_MARKER_FRETS = new Set([12, 24]);

export function GuitarFretboardDock() {
  const doc = useScoreStore((s) => s.document);
  const selectedNoteId = useInputStore((s) => s.cursor.selectedNoteId);
  const playbackState = usePlaybackStore((s) => s.playbackState);

  const selectedInstrumentId = usePracticeStore((s) => s.selectedInstrumentId);
  const tuningPresetId = usePracticeStore((s) => s.tuningPresetId);
  const capo = usePracticeStore((s) => s.capo);
  const manualFretPositions = usePracticeStore((s) => s.manualFretPositions);
  const activeNoteId = usePracticeStore((s) => s.activeNoteId);
  const nextNoteId = usePracticeStore((s) => s.nextNoteId);

  const profile = getInstrumentProfile(selectedInstrumentId);
  const tuning = getTuningPreset(tuningPresetId);
  const safeCapo = profile.supportsCapo ? clampCapo(capo) : 0;
  const maxFret = profile.maxFret || 24;

  const resolvedNotes = useMemo(() => resolveScoreForView(doc), [doc]);

  const positionsByNoteId = useMemo(
    () =>
      assignFretboardPositions(
        resolvedNotes.map((rn) => ({
          noteId: rn.noteId,
          midiPitch: rn.midiPitch,
        })),
        {
          openStringMidis: tuning.openStringMidis,
          capo: safeCapo,
          maxFret,
          manualPositions: manualFretPositions,
        }
      ),
    [resolvedNotes, tuning.openStringMidis, safeCapo, maxFret, manualFretPositions]
  );

  const currentFocusNoteId =
    playbackState === 'PLAYING' || playbackState === 'PAUSED'
      ? activeNoteId
      : activeNoteId ?? selectedNoteId;

  const activePos = currentFocusNoteId
    ? positionsByNoteId[currentFocusNoteId] ?? null
    : null;
  const nextPos = nextNoteId ? positionsByNoteId[nextNoteId] ?? null : null;

  const selectedPos = selectedNoteId
    ? positionsByNoteId[selectedNoteId] ?? null
    : null;

  const candidatesForSelected = useMemo(() => {
    if (!selectedPos) {
      return [];
    }
    return getValidFretPositions(
      selectedPos.effectiveMidiPitch,
      tuning.openStringMidis,
      safeCapo,
      maxFret
    );
  }, [selectedPos, tuning.openStringMidis, safeCapo, maxFret]);

  const frets = useMemo(
    () => Array.from({ length: maxFret + 1 }, (_, i) => i),
    [maxFret]
  );

  return (
    <section
      className="nb-dock nb-fretboard-dock"
      data-testid="guitar-fretboard-dock"
      aria-label="实时指板高亮视图"
    >
      <div className="nb-dock-header">
        <div className="nb-dock-title-row">
          <strong className="nb-dock-title">{profile.name} · {maxFret} 品指板</strong>
          <span className="nb-dock-badge">{tuning.label}</span>
          {safeCapo > 0 && (
            <span className="nb-dock-badge nb-badge-warn" data-testid="dock-capo-badge">
              Capo {safeCapo} 品
            </span>
          )}
        </div>

        <div className="nb-dock-status">
          <span className="nb-dock-pill nb-pill-active" data-testid="fretboard-active-info">
            {activePos
              ? `当前音：${midiToNoteLabel(activePos.midiPitch)}（${activePos.string}弦 ${activePos.fret}品${safeCapo > 0 ? ` / 物理${activePos.physicalFret}品` : ''}）`
              : '点击品格可即时试听，点击谱面音符可手动切换把位'}
          </span>
          {nextPos && (
            <span className="nb-dock-pill nb-pill-next" data-testid="fretboard-next-info">
              下一音：{midiToNoteLabel(nextPos.midiPitch)}（{nextPos.string}弦 {nextPos.fret}品）
            </span>
          )}
        </div>
      </div>

      {playbackState !== 'PLAYING' &&
        selectedNoteId &&
        selectedPos &&
        candidatesForSelected.length > 1 && (
          <div className="nb-fret-candidates" data-testid="fret-candidate-list">
            <span className="nb-field-label">同音高可选把位：</span>
            {candidatesForSelected.map((cand) => {
              const isCurr =
                selectedPos.string === cand.string &&
                selectedPos.fret === cand.fret;
              return (
                <button
                  key={`${cand.string}-${cand.fret}`}
                  type="button"
                  className={`nb-btn nb-btn-sm ${isCurr ? 'nb-btn-active' : ''}`}
                  data-testid={`fret-cand-s${cand.string}-f${cand.fret}`}
                  onClick={() => {
                    practiceStore
                      .getState()
                      .setManualFretPosition(selectedNoteId, {
                        string: cand.string,
                        fret: cand.fret,
                      });
                    playbackController.previewMidi(
                      selectedPos.effectiveMidiPitch,
                      280
                    );
                  }}
                >
                  {cand.string}弦 {cand.fret}品
                </button>
              );
            })}
          </div>
        )}

      <div className="nb-fretboard-scroll">
        <div
          className="nb-fretboard-grid"
          style={{
            gridTemplateColumns: `46px repeat(${maxFret + 1}, minmax(30px, 1fr))`,
          }}
        >
          {/* 品位数字表头 */}
          <div className="nb-fret-label-corner">弦\品</div>
          {frets.map((fret) => (
            <div
              key={`head-${fret}`}
              className={`nb-fret-header ${fret === 0 ? 'nb-fret-nut' : ''} ${safeCapo > 0 && fret === safeCapo ? 'nb-fret-capo-col' : ''}`}
            >
              <span>{fret}</span>
              {safeCapo > 0 && fret === safeCapo && (
                <span
                  className="nb-capo-bar-marker"
                  data-testid="fretboard-capo-bar"
                  title={`Capo ${safeCapo} 品`}
                >
                  CAPO
                </span>
              )}
            </div>
          ))}

          {/* 各弦行 */}
          {tuning.openStringMidis.map((openMidi, sIdx) => {
            const stringNum = sIdx + 1;
            const stringLabel = tuning.stringLabels[sIdx] ?? `${stringNum}`;
            return (
              <div key={`row-${stringNum}`} className="nb-fret-row-contents">
                <div className="nb-string-label">
                  <span>{stringNum}弦</span>
                  <small>{stringLabel}</small>
                </div>

                {frets.map((fret) => {
                  const cellMidi = openMidi + fret;
                  const isActive =
                    activePos !== null &&
                    activePos.string === stringNum &&
                    activePos.physicalFret === fret;
                  const isNext =
                    !isActive &&
                    nextPos !== null &&
                    nextPos.string === stringNum &&
                    nextPos.physicalFret === fret;
                  const isBlockedByCapo = safeCapo > 0 && fret < safeCapo;
                  const stateAttr = isActive
                    ? 'active'
                    : isNext
                      ? 'next'
                      : undefined;

                  return (
                    <button
                      key={`cell-${stringNum}-${fret}`}
                      type="button"
                      className={`nb-fret-cell ${fret === 0 ? 'nb-fret-nut' : ''} ${isBlockedByCapo ? 'nb-fret-below-capo' : ''} ${safeCapo > 0 && fret === safeCapo ? 'nb-fret-capo-col' : ''}`}
                      data-testid={`fret-cell-s${stringNum}-f${fret}`}
                      data-string={stringNum}
                      data-fret={fret}
                      data-midi={cellMidi}
                      data-fret-state={stateAttr}
                      title={`${stringNum}弦 ${fret}品 (${midiToNoteLabel(cellMidi)})`}
                      onClick={() => {
                        playbackController.previewMidi(cellMidi, 300);
                        if (
                          playbackState !== 'PLAYING' &&
                          selectedNoteId &&
                          selectedPos &&
                          fret >= safeCapo &&
                          (cellMidi === selectedPos.midiPitch ||
                            cellMidi === selectedPos.effectiveMidiPitch)
                        ) {
                          practiceStore
                            .getState()
                            .setManualFretPosition(selectedNoteId, {
                              string: stringNum,
                              fret: fret - safeCapo,
                            });
                        }
                      }}
                    >
                      <span className="nb-string-wire" />
                      {isActive && (
                        <span
                          className="nb-fret-dot nb-fret-dot-active"
                          data-testid="fretboard-active-dot"
                        >
                          {activePos.fret}
                        </span>
                      )}
                      {isNext && (
                        <span
                          className="nb-fret-dot nb-fret-dot-next"
                          data-testid="fretboard-next-dot"
                        >
                          {nextPos.fret}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}

          {/* 指板品记圆点 */}
          <div className="nb-fret-inlay-spacer" />
          {frets.map((fret) => (
            <div key={`inlay-${fret}`} className="nb-fret-inlay-cell">
              {SINGLE_MARKER_FRETS.has(fret) && (
                <span className="nb-inlay-dot" />
              )}
              {DOUBLE_MARKER_FRETS.has(fret) && (
                <span className="nb-inlay-double">
                  <span className="nb-inlay-dot" />
                  <span className="nb-inlay-dot" />
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
