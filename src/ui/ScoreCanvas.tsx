import { type MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { inputStore, useInputStore } from '../application/input-store.ts';
import {
  playbackController,
  usePlaybackStore,
} from '../application/playback-controller.ts';
import {
  resolveScoreForView,
  useScoreStore,
} from '../application/score-store.ts';
import { CursorOverlayController } from '../rendering/cursor-overlay.ts';
import { renderJianpu } from '../rendering/jianpu-renderer.ts';
import {
  computeScoreLayout,
  type LayoutLine,
  type MeasureLayout,
} from '../rendering/layout-engine.ts';
import { renderStaff } from '../rendering/staff-renderer.ts';

function formatBeats(ticks: number): string {
  const beats = ticks / 480;
  return Number.isInteger(beats) ? String(beats) : beats.toFixed(2).replace(/\.?0+$/, '');
}

export function ScoreCanvas() {
  const doc = useScoreStore((s) => s.document);
  const measureStatuses = useScoreStore((s) => s.measureStatuses);
  const cursor = useInputStore((s) => s.cursor);
  const playbackState = usePlaybackStore((s) => s.playbackState);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const staffLayerRef = useRef<HTMLDivElement | null>(null);
  const jianpuLayerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<CursorOverlayController | null>(null);

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

  const layout = useMemo(() => {
    const staffLineHeight = doc.viewMode === 'jianpu' ? 0 : 110;
    const jianpuLineHeight = doc.viewMode === 'staff' ? 0 : 76;
    return computeScoreLayout(doc, resolvedNotes, {
      containerWidth,
      staffLineHeight,
      jianpuLineHeight,
    });
  }, [doc, resolvedNotes, containerWidth]);

  // 初始化并销毁 CursorOverlayController（兼容 React 19 StrictMode）
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    const controller = new CursorOverlayController(stage);
    overlayRef.current = controller;
    return () => {
      controller.destroy();
      if (overlayRef.current === controller) {
        overlayRef.current = null;
      }
    };
  }, []);

  // 渲染五线谱与简谱 SVG 并绑定布局到游标层
  useEffect(() => {
    if (staffLayerRef.current) {
      if (doc.viewMode === 'jianpu') {
        staffLayerRef.current.innerHTML = '';
      } else {
        renderStaff(staffLayerRef.current, doc, resolvedNotes, layout, {
          selectedNoteId: cursor.selectedNoteId,
        });
      }
    }

    if (jianpuLayerRef.current) {
      if (doc.viewMode === 'staff') {
        jianpuLayerRef.current.innerHTML = '';
      } else {
        renderJianpu(jianpuLayerRef.current, doc, resolvedNotes, layout, {
          selectedNoteId: cursor.selectedNoteId,
        });
      }
    }

    overlayRef.current?.bindScore(doc, resolvedNotes, layout);
  }, [doc, resolvedNotes, layout, cursor.selectedNoteId]);

  // 帧同步游标控制（与音频调度完全解耦）
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) {
      return;
    }
    if (playbackState === 'PLAYING') {
      overlay.start(
        () => playbackController.getCurrentPlaybackTimeMs(),
        doc.bpm
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
    overlay.stop();
  }, [playbackState, doc.bpm]);

  const handleStageClick = (e: MouseEvent<HTMLDivElement>) => {
    if (playbackState === 'PLAYING' || playbackState === 'LOADING_AUDIO') {
      return;
    }
    const target = e.target as Element | null;
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
    playbackState !== 'PLAYING' &&
    playbackState !== 'PAUSED' &&
    editCursorPos !== null;

  return (
    <section className="nb-canvas-wrapper" aria-label="乐谱双谱画布">
      <div className="nb-canvas-scroll" ref={scrollRef}>
        <div
          ref={stageRef}
          className="nb-canvas-stage"
          data-testid="score-canvas-stage"
          data-view-mode={doc.viewMode}
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

          <div className="nb-measure-overlay">
            {layout.lines.map((line) =>
              line.measures.map((mLayout) => {
                const status = measureStatuses[mLayout.measureIndex];
                const validity = status?.state ?? mLayout.validity;
                const isSelectedMeasure =
                  cursor.measureIndex === mLayout.measureIndex;

                return (
                  <div
                    key={mLayout.measureIndex}
                    className={`nb-measure-box ${isSelectedMeasure ? 'nb-measure-current' : ''} ${validity === 'OVERFLOW' ? 'nb-measure-overflow' : ''}`}
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
