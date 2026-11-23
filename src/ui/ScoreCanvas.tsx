import { type MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { inputStore, useInputStore } from '../application/input-store.ts';
import { useNotationStore } from '../application/notation-store.ts';
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
import { useWorkspaceStore } from '../application/workspace-store.ts';
import {
  assignFretboardPositions,
  clampCapo,
  cycleManualFretPosition,
  getInstrumentProfile,
  getTuningPreset,
} from '../domain/v2-instruments.ts';
import { CursorOverlayController } from '../rendering/cursor-overlay.ts';
import { renderJianpu } from '../rendering/jianpu-renderer.ts';
import {
  computeScoreLayout,
  type CursorPosition,
  type LayoutLine,
  type MeasureLayout,
} from '../rendering/layout-engine.ts';
import { renderStaff } from '../rendering/staff-renderer.ts';
import { renderTab } from '../rendering/tab-renderer.ts';

function formatBeats(ticks: number): string {
  const beats = ticks / 480;
  return Number.isInteger(beats) ? String(beats) : beats.toFixed(2).replace(/\.?0+$/, '');
}

export function ScoreCanvas() {
  const doc = useScoreStore((s) => s.document);
  const measureStatuses = useScoreStore((s) => s.measureStatuses);
  const cursor = useInputStore((s) => s.cursor);
  const playbackState = usePlaybackStore((s) => s.playbackState);
  const workMode = useWorkspaceStore((s) => s.workMode);
  const boundScoreId = useNotationStore((s) => s.boundScoreId);
  const clef = useNotationStore((s) => s.clef);
  const tracks = useNotationStore((s) => s.tracks);
  const activeTrackIndex = useNotationStore((s) => s.activeTrackIndex);
  const noteExtrasById = useNotationStore((s) => s.noteExtrasById);
  const measureExtrasByIndex = useNotationStore((s) => s.measureExtrasByIndex);
  const showReferencePanel = useNotationStore((s) => s.showReferencePanel);

  const selectedInstrumentId = usePracticeStore((s) => s.selectedInstrumentId);
  const tuningPresetId = usePracticeStore((s) => s.tuningPresetId);
  const capo = usePracticeStore((s) => s.capo);
  const practiceViews = usePracticeStore((s) => s.practiceViews);
  const manualFretPositions = usePracticeStore((s) => s.manualFretPositions);
  const abLoopEnabled = usePracticeStore((s) => s.abLoopEnabled);
  const loopStartMeasure = usePracticeStore((s) => s.loopStartMeasure);
  const loopEndMeasure = usePracticeStore((s) => s.loopEndMeasure);

  const profile = getInstrumentProfile(selectedInstrumentId);
  const tuning = getTuningPreset(tuningPresetId);
  const safeCapo = profile.supportsCapo ? clampCapo(capo) : 0;

  const isNotationActive = boundScoreId === null || boundScoreId === doc.id;
  const activeClef = isNotationActive ? clef : 'treble';
  const effectiveClef =
    workMode === 'practice'
      ? profile.category === 'bass'
        ? 'bass'
        : profile.category === 'piano'
          ? 'grand'
          : activeClef
      : activeClef;

  const showStaff =
    workMode === 'practice' ? practiceViews.staff : doc.viewMode !== 'jianpu';
  const showJianpu =
    workMode === 'practice' ? practiceViews.jianpu : doc.viewMode !== 'staff';
  const showTab = workMode === 'practice' ? practiceViews.tab : false;

  const voice2Measures = isNotationActive
    ? tracks[activeTrackIndex]?.voices[1]?.measures
    : undefined;
  const activeNoteExtras = isNotationActive ? noteExtrasById : undefined;
  const activeMeasureExtras = isNotationActive ? measureExtrasByIndex : undefined;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const staffLayerRef = useRef<HTMLDivElement | null>(null);
  const jianpuLayerRef = useRef<HTMLDivElement | null>(null);
  const tabLayerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<CursorOverlayController | null>(null);
  const resolvedNotesRef = useRef<ReturnType<typeof resolveScoreForView>>([]);
  const voice2MeasuresRef = useRef(voice2Measures);
  const docRef = useRef(doc);
  const layoutRef = useRef<ReturnType<typeof computeScoreLayout> | null>(null);
  const lastFrameKeyRef = useRef<string>('');
  const lastScrolledLineRef = useRef<number>(-1);

  const [containerWidth, setContainerWidth] = useState<number>(960);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') {
      return;
    }
    const updateWidth = () => {
      const next = Math.max(420, Math.floor(el.clientWidth - 16));
      setContainerWidth((prev) => (Math.abs(prev - next) >= 4 ? next : prev));
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const resolvedNotes = useMemo(() => resolveScoreForView(doc), [doc]);
  resolvedNotesRef.current = resolvedNotes;
  voice2MeasuresRef.current = voice2Measures;
  docRef.current = doc;

  const hasLyricsOrMarkings = useMemo(() => {
    if (!activeNoteExtras) return false;
    return Object.keys(activeNoteExtras).length > 0;
  }, [activeNoteExtras]);

  const fretPositionsByNoteId = useMemo(() => {
    if (!showTab) {
      return {};
    }
    return assignFretboardPositions(
      resolvedNotes.map((rn) => ({
        noteId: rn.noteId,
        midiPitch: rn.midiPitch,
      })),
      {
        openStringMidis: tuning.openStringMidis,
        capo: safeCapo,
        maxFret: profile.maxFret || 24,
        manualPositions: manualFretPositions,
      }
    );
  }, [
    showTab,
    resolvedNotes,
    tuning.openStringMidis,
    safeCapo,
    profile.maxFret,
    manualFretPositions,
  ]);

  const layout = useMemo(() => {
    const staffLineHeight = !showStaff
      ? 0
      : effectiveClef === 'grand'
        ? 210
        : 110;
    const jianpuLineHeight = !showJianpu
      ? 0
      : hasLyricsOrMarkings
        ? 96
        : 76;
    const tabLineHeight = !showTab
      ? 0
      : tuning.stringCount <= 4
        ? 105
        : 120;
    return computeScoreLayout(doc, resolvedNotes, {
      containerWidth,
      staffLineHeight,
      jianpuLineHeight,
      tabLineHeight,
    });
  }, [
    doc,
    resolvedNotes,
    containerWidth,
    showStaff,
    showJianpu,
    showTab,
    effectiveClef,
    hasLyricsOrMarkings,
    tuning.stringCount,
    showReferencePanel,
  ]);
  layoutRef.current = layout;

  // 初始化并销毁 CursorOverlayController（兼容 React 19 StrictMode）
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    const handleFrame = (pos: CursorPosition) => {
      const countInBeat = playbackController.getCountInBeat();
      const frameKey = `${pos.activeNoteId ?? ''}|${pos.measureIndex}|${countInBeat ?? ''}`;

      if (frameKey !== lastFrameKeyRef.current) {
        lastFrameKeyRef.current = frameKey;
        const notes = resolvedNotesRef.current;
        const activeIdx = pos.activeNoteId
          ? notes.findIndex((n) => n.noteId === pos.activeNoteId)
          : -1;
        const activeRn = activeIdx >= 0 ? notes[activeIdx] : undefined;
        let nextRn: (typeof notes)[number] | undefined;
        if (activeIdx >= 0) {
          for (let i = activeIdx + 1; i < notes.length; i += 1) {
            if (notes[i]?.midiPitch !== null) {
              nextRn = notes[i];
              break;
            }
          }
        }

        const v2Midis: number[] = [];
        const v2Measures = voice2MeasuresRef.current;
        const currDoc = docRef.current;
        if (v2Measures && activeRn) {
          let mStart = 0;
          for (let mIdx = 0; mIdx < currDoc.measures.length; mIdx += 1) {
            const v1M = currDoc.measures[mIdx];
            const v1Dur =
              v1M?.notes.reduce((s, n) => s + n.durationTicks, 0) ?? 0;
            const v2M = v2Measures[mIdx];
            if (
              v2M &&
              activeRn.startTickInScore >= mStart &&
              activeRn.startTickInScore < mStart + v1Dur
            ) {
              let v2Tick = mStart;
              for (const beat of v2M.beats) {
                const beatEnd = v2Tick + beat.durationTicks;
                if (
                  !beat.isRest &&
                  activeRn.startTickInScore >= v2Tick &&
                  activeRn.startTickInScore < beatEnd
                ) {
                  for (const pn of beat.notes) {
                    v2Midis.push(pn.midiPitch);
                  }
                }
                v2Tick = beatEnd;
              }
              break;
            }
            mStart += v1Dur;
          }
        }

        practiceStore.getState().setActivePlaybackFrame({
          activeNoteId: pos.activeNoteId,
          activeMidiPitchesV1:
            activeRn && activeRn.midiPitch !== null ? [activeRn.midiPitch] : [],
          activeMidiPitchesV2: v2Midis,
          nextNoteId: nextRn?.noteId ?? null,
          nextMidiPitch: nextRn?.midiPitch ?? null,
          activeMeasureIndex: pos.measureIndex,
          countInBeat,
        });
      }

      if (
        practiceStore.getState().autoScrollEnabled &&
        pos.lineIndex !== lastScrolledLineRef.current
      ) {
        lastScrolledLineRef.current = pos.lineIndex;
        const scrollEl = scrollRef.current;
        const targetLine = layoutRef.current?.lines[pos.lineIndex];
        if (scrollEl && targetLine) {
          scrollEl.setAttribute('data-auto-scroll-line', String(pos.lineIndex));
          if (typeof scrollEl.scrollTo === 'function') {
            scrollEl.scrollTo({
              top: Math.max(0, targetLine.y - 24),
              behavior: 'smooth',
            });
          } else {
            scrollEl.scrollTop = Math.max(0, targetLine.y - 24);
          }
        }
      }
    };

    const controller = new CursorOverlayController(stage, {
      onFrame: handleFrame,
    });
    overlayRef.current = controller;
    return () => {
      controller.destroy();
      if (overlayRef.current === controller) {
        overlayRef.current = null;
      }
    };
  }, []);

  // 渲染五线谱、简谱与六线谱 SVG 并绑定布局到游标层
  useEffect(() => {
    if (staffLayerRef.current) {
      if (!showStaff) {
        staffLayerRef.current.innerHTML = '';
      } else {
        renderStaff(staffLayerRef.current, doc, resolvedNotes, layout, {
          selectedNoteId: cursor.selectedNoteId,
          clef: effectiveClef,
          voice2Measures,
          noteExtrasById: activeNoteExtras,
          measureExtrasByIndex: activeMeasureExtras,
        });
      }
    }

    if (jianpuLayerRef.current) {
      if (!showJianpu) {
        jianpuLayerRef.current.innerHTML = '';
      } else {
        renderJianpu(jianpuLayerRef.current, doc, resolvedNotes, layout, {
          selectedNoteId: cursor.selectedNoteId,
          noteExtrasById: activeNoteExtras,
          measureExtrasByIndex: activeMeasureExtras,
        });
      }
    }

    if (tabLayerRef.current) {
      if (!showTab) {
        tabLayerRef.current.innerHTML = '';
      } else {
        renderTab(tabLayerRef.current, doc, layout, {
          stringCount: tuning.stringCount,
          positionsByNoteId: fretPositionsByNoteId,
          selectedNoteId: cursor.selectedNoteId,
          capo: safeCapo,
          tuningLabel: tuning.label,
          measureExtrasByIndex: activeMeasureExtras,
        });
      }
    }

    overlayRef.current?.bindScore(doc, resolvedNotes, layout);
  }, [
    doc,
    resolvedNotes,
    layout,
    cursor.selectedNoteId,
    showStaff,
    showJianpu,
    showTab,
    effectiveClef,
    voice2Measures,
    activeNoteExtras,
    activeMeasureExtras,
    tuning.stringCount,
    tuning.label,
    fretPositionsByNoteId,
    safeCapo,
  ]);

  // 帧同步游标控制（与音频调度完全解耦）
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) {
      return;
    }
    if (playbackState === 'PLAYING') {
      overlay.start(
        () => playbackController.getCurrentPlaybackTimeMs(),
        () => playbackController.getSnapshot().currentBpm
      );
      return () => {
        overlay.stop();
      };
    }
    if (playbackState === 'PAUSED') {
      overlay.stop();
      overlay.updateToTick(playbackController.getCurrentScoreTick());
      return;
    }
    lastFrameKeyRef.current = '';
    lastScrolledLineRef.current = -1;
    overlay.stop();
  }, [playbackState, doc.bpm]);

  const handleStageClick = (e: MouseEvent<HTMLDivElement>) => {
    if (playbackState === 'PLAYING' || playbackState === 'LOADING_AUDIO') {
      return;
    }
    const target = e.target as Element | null;
    const v2El = target?.closest('[data-v2-note-id]');
    if (v2El) {
      const v2Id = v2El.getAttribute('data-v2-note-id');
      const mIdxStr = v2El.getAttribute('data-measure-index');
      if (v2Id) {
        inputStore.getState().setCursor({
          measureIndex: mIdxStr ? Number(mIdxStr) : cursor.measureIndex,
          selectedNoteId: v2Id,
        });
        return;
      }
    }

    const tabEl = target?.closest('[data-tab-note-id]');
    if (tabEl) {
      const tabNoteId = tabEl.getAttribute('data-tab-note-id');
      if (tabNoteId) {
        for (let mIdx = 0; mIdx < doc.measures.length; mIdx += 1) {
          const m = doc.measures[mIdx];
          if (!m) continue;
          const nIdx = m.notes.findIndex((n) => n.id === tabNoteId);
          if (nIdx !== -1) {
            if (cursor.selectedNoteId === tabNoteId) {
              const currentPos = fretPositionsByNoteId[tabNoteId];
              if (currentPos) {
                const nextPos = cycleManualFretPosition(
                  currentPos.effectiveMidiPitch,
                  { string: currentPos.string, fret: currentPos.fret },
                  tuning.openStringMidis,
                  safeCapo,
                  profile.maxFret || 24
                );
                if (nextPos) {
                  practiceStore.getState().setManualFretPosition(tabNoteId, {
                    string: nextPos.string,
                    fret: nextPos.fret,
                  });
                }
              }
            }
            inputStore.getState().setCursor({
              measureIndex: mIdx,
              noteIndex: nIdx + 1,
              selectedNoteId: tabNoteId,
            });
            return;
          }
        }
      }
    }

    const noteEl = target?.closest('[data-note-id]');
    if (!noteEl) {
      return;
    }
    const noteId = noteEl.getAttribute('data-note-id');
    if (!noteId) {
      return;
    }
    for (let mIdx = 0; mIdx < doc.measures.length; mIdx += 1) {
      const m = doc.measures[mIdx];
      if (!m) {
        continue;
      }
      const nIdx = m.notes.findIndex((n) => n.id === noteId);
      if (nIdx !== -1) {
        inputStore.getState().setCursor({
          measureIndex: mIdx,
          noteIndex: nIdx + 1,
          selectedNoteId: noteId,
        });
        return;
      }
    }
  };

  const handleSelectMeasure = (measureIndex: number) => {
    if (playbackState === 'PLAYING' || playbackState === 'LOADING_AUDIO') {
      return;
    }
    const m = doc.measures[measureIndex];
    inputStore.getState().setCursor({
      measureIndex,
      noteIndex: m ? m.notes.length : 0,
      selectedNoteId: null,
    });
  };

  const editCursorPos = useMemo(() => {
    let targetLine: LayoutLine | undefined;
    let targetMeasure: MeasureLayout | undefined;

    for (const line of layout.lines) {
      for (const mLayout of line.measures) {
        if (mLayout.measureIndex === cursor.measureIndex) {
          targetLine = line;
          targetMeasure = mLayout;
          break;
        }
      }
      if (targetMeasure) {
        break;
      }
    }

    if (!targetLine || !targetMeasure) {
      return null;
    }

    const docMeasure = doc.measures[cursor.measureIndex];
    let x = targetMeasure.contentStartX;
    if (docMeasure && docMeasure.notes.length > 0 && cursor.noteIndex > 0) {
      const refIdx = Math.min(cursor.noteIndex - 1, docMeasure.notes.length - 1);
      const refNote = docMeasure.notes[refIdx];
      const slot = refNote ? layout.slotByNoteId[refNote.id] : undefined;
      if (slot) {
        x = slot.x + Math.min(18, slot.width * 0.45);
      }
    }

    return {
      x,
      top: targetLine.y + 8,
      height: Math.max(40, targetLine.height - 16),
    };
  }, [layout, doc.measures, cursor.measureIndex, cursor.noteIndex]);

  const showEditCursor =
    workMode === 'studio' &&
    playbackState !== 'PLAYING' &&
    playbackState !== 'PAUSED' &&
    editCursorPos !== null;

  const clampedLoopA = Math.min(loopStartMeasure, Math.max(0, doc.measures.length - 1));
  const clampedLoopB = Math.max(
    clampedLoopA,
    Math.min(loopEndMeasure, Math.max(0, doc.measures.length - 1))
  );

  return (
    <section className="nb-canvas-wrapper" aria-label="乐谱双谱画布">
      <div className="nb-canvas-scroll" ref={scrollRef}>
        <div
          ref={stageRef}
          className="nb-canvas-stage"
          data-testid="score-canvas-stage"
          data-view-mode={doc.viewMode}
          data-practice-tab={showTab ? 'true' : 'false'}
          style={{
            width: `${layout.totalWidth}px`,
            height: `${layout.totalHeight}px`,
          }}
          onClick={handleStageClick}
        >
          <div
            ref={staffLayerRef}
            className="nb-staff-layer"
            data-testid="staff-layer"
          />
          <div
            ref={jianpuLayerRef}
            className="nb-jianpu-layer"
            data-testid="jianpu-layer"
          />
          <div
            ref={tabLayerRef}
            className="nb-tab-layer"
            data-testid="tab-layer"
          />

          <div className="nb-measure-overlay">
            {layout.lines.map((line) =>
              line.measures.map((mLayout) => {
                const status = measureStatuses[mLayout.measureIndex];
                const validity = status?.state ?? mLayout.validity;
                const isSelectedMeasure =
                  workMode === 'studio' &&
                  cursor.measureIndex === mLayout.measureIndex;
                const isInAbLoop =
                  workMode === 'practice' &&
                  abLoopEnabled &&
                  mLayout.measureIndex >= clampedLoopA &&
                  mLayout.measureIndex <= clampedLoopB;

                return (
                  <div
                    key={mLayout.measureIndex}
                    className={`nb-measure-box ${isSelectedMeasure ? 'nb-measure-current' : ''} ${workMode === 'studio' && validity === 'OVERFLOW' ? 'nb-measure-overflow' : ''} ${isInAbLoop ? 'nb-measure-in-loop' : ''}`}
                    style={{
                      left: `${mLayout.x}px`,
                      top: `${line.y}px`,
                      width: `${mLayout.width}px`,
                      height: `${line.height}px`,
                    }}
                  >
                    <div className="nb-measure-header">
                      <button
                        type="button"
                        className="nb-measure-play-btn"
                        data-testid={`measure-play-${mLayout.measureIndex}`}
                        title={`从第 ${mLayout.measureIndex + 1} 小节起播`}
                        onClick={() => {
                          void playbackController.playFromMeasure(
                            mLayout.measureIndex
                          );
                        }}
                      >
                        {mLayout.measureIndex + 1} ▶
                      </button>

                      {workMode === 'practice' && (
                        <>
                          <button
                            type="button"
                            className={`nb-measure-select-btn ${abLoopEnabled && clampedLoopA === mLayout.measureIndex ? 'nb-btn-active' : ''}`}
                            data-testid={`measure-set-a-${mLayout.measureIndex}`}
                            title={`设第 ${mLayout.measureIndex + 1} 小节为循环起点 A`}
                            onClick={() => {
                              practiceStore.getState().setAbLoopEnabled(true);
                              practiceStore
                                .getState()
                                .setLoopRange(
                                  mLayout.measureIndex,
                                  Math.max(mLayout.measureIndex, clampedLoopB),
                                  doc.measures.length
                                );
                            }}
                          >
                            A
                          </button>
                          <button
                            type="button"
                            className={`nb-measure-select-btn ${abLoopEnabled && clampedLoopB === mLayout.measureIndex ? 'nb-btn-active' : ''}`}
                            data-testid={`measure-set-b-${mLayout.measureIndex}`}
                            title={`设第 ${mLayout.measureIndex + 1} 小节为循环终点 B`}
                            onClick={() => {
                              practiceStore.getState().setAbLoopEnabled(true);
                              practiceStore
                                .getState()
                                .setLoopRange(
                                  Math.min(clampedLoopA, mLayout.measureIndex),
                                  mLayout.measureIndex,
                                  doc.measures.length
                                );
                            }}
                          >
                            B
                          </button>
                        </>
                      )}

                      {workMode === 'studio' && (
                        <>
                          <button
                            type="button"
                            className="nb-measure-select-btn"
                            data-testid={`measure-select-${mLayout.measureIndex}`}
                            title={`定位光标到第 ${mLayout.measureIndex + 1} 小节`}
                            onClick={() => handleSelectMeasure(mLayout.measureIndex)}
                          >
                            定位
                          </button>

                          <span
                            className={`nb-measure-badge nb-validity-${validity.toLowerCase()}`}
                            data-testid={`measure-status-${mLayout.measureIndex}`}
                            data-validity={validity}
                          >
                            {validity === 'EMPTY' && '空小节'}
                            {validity === 'UNDERFLOW' &&
                              status &&
                              `缺 ${formatBeats(status.remainingTicks)} 拍`}
                            {validity === 'VALID' && '满拍'}
                            {validity === 'OVERFLOW' &&
                              status &&
                              `超拍 +${formatBeats(status.overflowTicks)} 拍`}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {showEditCursor && editCursorPos && (
            <div
              className="nb-edit-cursor"
              data-testid="edit-cursor"
              style={{
                left: `${editCursorPos.x}px`,
                top: `${editCursorPos.top}px`,
                height: `${editCursorPos.height}px`,
              }}
            />
          )}
        </div>
      </div>
    </section>
  );
}
