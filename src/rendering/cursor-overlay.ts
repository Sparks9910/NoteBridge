import { msToTicks } from '../domain/rhythm.ts';
import type { ResolvedNote, ScoreDocument } from '../domain/types.ts';
import {
  getCursorXForTick,
  type CursorPosition,
  type ScoreLayout,
} from './layout-engine.ts';

export interface CursorOverlayOptions {
  raf?: (cb: FrameRequestCallback) => number;
  cancelRaf?: (id: number) => void;
  onFrame?: (position: CursorPosition) => void;
}

/**
 * 播放游标与音符同步高亮层（与音频调度完全解耦，仅每帧读取当前播放时间）。
 */
export class CursorOverlayController {
  private readonly container: HTMLElement;
  private readonly raf: (cb: FrameRequestCallback) => number;
  private readonly cancelRaf: (id: number) => void;
  private readonly onFrame?: (position: CursorPosition) => void;

  private layout: ScoreLayout | null = null;
  private resolvedNotes: readonly ResolvedNote[] = [];
  private cursorEl: HTMLDivElement | null = null;
  private rafId: number | null = null;
  private lastActiveNoteId: string | null = null;

  constructor(container: HTMLElement, options?: CursorOverlayOptions) {
    this.container = container;
    this.raf =
      options?.raf ?? ((cb) => globalThis.requestAnimationFrame(cb));
    this.cancelRaf =
      options?.cancelRaf ?? ((id) => globalThis.cancelAnimationFrame(id));
    this.onFrame = options?.onFrame;
  }

  public bindScore(
    _doc: ScoreDocument,
    resolvedNotes: readonly ResolvedNote[],
    layout: ScoreLayout
  ): void {
    this.resolvedNotes = resolvedNotes;
    this.layout = layout;
    this.ensureCursorElement();
  }

  public start(
    getCurrentTimeMs: () => number,
    bpm: number | (() => number)
  ): void {
    this.stop();
    const tickFrame = () => {
      const timeMs = getCurrentTimeMs();
      const activeBpm = typeof bpm === 'function' ? bpm() : bpm;
      this.updateToTimeMs(timeMs, activeBpm);
      this.rafId = this.raf(tickFrame);
    };
    this.rafId = this.raf(tickFrame);
  }

  public updateToTimeMs(timeMs: number, bpm: number): CursorPosition | null {
    const tick = msToTicks(Math.max(0, timeMs), bpm);
    return this.updateToTick(tick);
  }

  public updateToTick(tick: number): CursorPosition | null {
    if (!this.layout) {
      return null;
    }
    const pos = getCursorXForTick(this.layout, this.resolvedNotes, tick);
    const line = this.layout.lines[pos.lineIndex];
    const cursor = this.ensureCursorElement();

    cursor.style.display = 'block';
    cursor.style.left = `${pos.x}px`;
    if (line) {
      cursor.style.top = `${line.y}px`;
      cursor.style.height = `${line.height}px`;
    }
    cursor.setAttribute('data-cursor-x', String(pos.x));
    cursor.setAttribute('data-active-note-id', pos.activeNoteId ?? '');

    if (this.lastActiveNoteId !== pos.activeNoteId) {
      this.syncActiveHighlight(pos.activeNoteId);
      this.lastActiveNoteId = pos.activeNoteId;
    }

    this.onFrame?.(pos);
    return pos;
  }

  public stop(): void {
    if (this.rafId !== null) {
      this.cancelRaf(this.rafId);
      this.rafId = null;
    }
    if (this.cursorEl) {
      this.cursorEl.style.display = 'none';
    }
    this.syncActiveHighlight(null);
    this.lastActiveNoteId = null;
  }

  public destroy(): void {
    this.stop();
    if (this.cursorEl && this.cursorEl.parentElement === this.container) {
      this.container.removeChild(this.cursorEl);
    }
    this.cursorEl = null;
  }

  private ensureCursorElement(): HTMLDivElement {
    if (this.cursorEl && this.cursorEl.parentElement === this.container) {
      return this.cursorEl;
    }
    const el = document.createElement('div');
    el.className = 'nb-playback-cursor';
    el.style.position = 'absolute';
    el.style.width = '2px';
    el.style.backgroundColor = '#2563eb';
    el.style.pointerEvents = 'none';
    el.style.display = 'none';
    this.container.appendChild(el);
    this.cursorEl = el;
    return el;
  }

  private syncActiveHighlight(activeNoteId: string | null): void {
    const prevNodes = this.container.querySelectorAll('.nb-note-active');
    prevNodes.forEach((node) => {
      node.classList.remove('nb-note-active');
    });

    if (activeNoteId) {
      const targets = this.container.querySelectorAll(
        `[data-note-id="${activeNoteId}"], [data-tab-note-id="${activeNoteId}"]`
      );
      targets.forEach((node) => {
        node.classList.add('nb-note-active');
      });
    }
  }
}
