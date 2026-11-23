import {
  BarlineType,
  Dot,
  Renderer,
  TabNote,
  TabStave,
  TickContext,
} from 'vexflow';
import type { BaseDuration, ScoreDocument } from '../domain/types.ts';
import {
  type FretboardPosition,
  GUITAR_TECHNIQUE_OPTIONS,
} from '../domain/v2-instruments.ts';
import type {
  GuitarTechnique,
  MeasureNotationExtra,
  NoteNotationExtra,
} from '../domain/v2-types.ts';
import type { ScoreLayout } from './layout-engine.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

const TECH_SYMBOL_MAP: Readonly<Record<GuitarTechnique, string>> = Object.fromEntries(
  GUITAR_TECHNIQUE_OPTIONS.map((t) => [t.id, t.tabSymbol])
) as Record<GuitarTechnique, string>;

export interface TabRenderOptions {
  stringCount: number;
  positionsByNoteId: Readonly<Record<string, FretboardPosition>>;
  selectedNoteId?: string | null;
  activeNoteId?: string | null;
  capo?: number;
  tuningLabel?: string;
  noteExtrasById?: Readonly<Record<string, NoteNotationExtra>>;
  measureExtrasByIndex?: Readonly<Record<number, MeasureNotationExtra>>;
}

const VEX_DURATION_MAP: Record<BaseDuration, string> = {
  whole: 'w',
  half: 'h',
  quarter: 'q',
  eighth: '8',
  sixteenth: '16',
};

function applyBarlineToTabStave(
  stave: TabStave,
  extra?: MeasureNotationExtra
): void {
  if (!extra) {
    return;
  }
  if (extra.repeatStart) {
    stave.setBegBarType(BarlineType.REPEAT_BEGIN);
  }
  if (extra.repeatEnd) {
    stave.setEndBarType(BarlineType.REPEAT_END);
  } else if (extra.barline === 'double') {
    stave.setEndBarType(BarlineType.DOUBLE);
  } else if (extra.barline === 'final') {
    stave.setEndBarType(BarlineType.END);
  }
}

/**
 * 渲染 VexFlow 5 六线谱（TAB）。
 * 严格订阅 layout-engine 提供的 LayoutSlot.x，且仅使用 data-tab-note-id（绝不使用 data-note-id）。
 */
export function renderTab(
  container: HTMLDivElement,
  doc: ScoreDocument,
  layout: ScoreLayout,
  options: TabRenderOptions
): SVGSVGElement | null {
  container.innerHTML = '';

  const stringCount = Math.max(4, Math.min(6, Math.round(options.stringCount || 6)));
  const renderer = new Renderer(container, Renderer.Backends.SVG);
  renderer.resize(layout.totalWidth, layout.totalHeight);
  const ctx = renderer.getContext();

  const measureMap = new Map<number, (typeof doc.measures)[number]>();
  for (const m of doc.measures) {
    measureMap.set(m.index, m);
  }

  for (const line of layout.lines) {
    for (let mOffset = 0; mOffset < line.measures.length; mOffset += 1) {
      const mLayout = line.measures[mOffset];
      if (!mLayout) {
        continue;
      }
      const measure = measureMap.get(mLayout.measureIndex);
      if (!measure) {
        continue;
      }

      const mExtra = options.measureExtrasByIndex?.[mLayout.measureIndex];
      const tabStave = new TabStave(mLayout.x, line.tabY + 10, mLayout.width, {
        numLines: stringCount,
      });
      if (mOffset === 0) {
        tabStave.addTabGlyph();
      }
      tabStave.setNoteStartX(mLayout.contentStartX);
      applyBarlineToTabStave(tabStave, mExtra);
      tabStave.setContext(ctx).draw();

      for (const note of measure.notes) {
        if (note.isRest || note.degree === 0) {
          continue;
        }
        const slot = layout.slotByNoteId[note.id];
        const pos = options.positionsByNoteId[note.id];
        if (!slot || !pos) {
          continue;
        }

        const duration = `${VEX_DURATION_MAP[note.baseDuration]}${note.dotted ? 'd' : ''}`;
        const tabNote = new TabNote({
          positions: [{ str: pos.string, fret: pos.fret }],
          duration,
        });

        if (note.dotted) {
          Dot.buildAndAttach([tabNote], { all: true });
        }

        tabNote.setStave(tabStave).setContext(ctx);
        const tickContext = new TickContext();
        tickContext.addTickable(tabNote);
        tickContext.preFormat();
        tickContext.setX(slot.x - tabStave.getNoteStartX());

        const absX = tabNote.getAbsoluteX();
        const glyphWidth =
          tabNote.getMetrics().glyphWidth || tabNote.getGlyphWidth() || 8;
        const delta = slot.x - (absX + glyphWidth / 2);
        if (Math.abs(delta) > 0.01) {
          tickContext.setX(tickContext.getX() + delta);
        }

        const group = ctx.openGroup('nb-tab-note');
        tabNote.draw();
        ctx.closeGroup();

        const targetEl = group ?? tabNote.getSVGElement();
        if (targetEl) {
          targetEl.setAttribute('data-tab-note-id', note.id);
          targetEl.setAttribute(
            'data-measure-index',
            String(mLayout.measureIndex)
          );
          targetEl.setAttribute('data-anchor-x', String(slot.x));
          targetEl.setAttribute('data-string', String(pos.string));
          targetEl.setAttribute('data-fret', String(pos.fret));
          if (pos.isManual) {
            targetEl.setAttribute('data-manual-fret', 'true');
          }
          if (options.activeNoteId === note.id) {
            targetEl.classList.add('nb-note-active');
          }
          if (options.selectedNoteId === note.id) {
            targetEl.classList.add('nb-note-selected');
          }

          const hitY = tabStave.getYForLine(Math.max(0, pos.string - 1));
          const hitRect = document.createElementNS(SVG_NS, 'rect');
          hitRect.setAttribute('x', String(slot.x - 10));
          hitRect.setAttribute('y', String(hitY - 10));
          hitRect.setAttribute('width', '20');
          hitRect.setAttribute('height', '20');
          hitRect.setAttribute('fill', 'transparent');
          hitRect.setAttribute('stroke', 'none');
          targetEl.appendChild(hitRect);

          const techs = options.noteExtrasById?.[note.id]?.guitarTechniques;
          if (techs && techs.length > 0) {
            const techGroup = document.createElementNS(SVG_NS, 'g');
            techGroup.setAttribute('data-tab-tech-note-id', note.id);
            techGroup.setAttribute('data-tab-techniques', techs.join(','));

            if (techs.includes('bend')) {
              const bendPath = document.createElementNS(SVG_NS, 'path');
              bendPath.setAttribute(
                'd',
                `M ${slot.x + 7} ${hitY - 2} Q ${slot.x + 13} ${hitY - 4} ${slot.x + 13} ${hitY - 13}`
              );
              bendPath.setAttribute('fill', 'none');
              bendPath.setAttribute('stroke', '#b45309');
              bendPath.setAttribute('stroke-width', '1.3');
              techGroup.appendChild(bendPath);
            }

            if (techs.includes('slide')) {
              const slideLine = document.createElementNS(SVG_NS, 'line');
              slideLine.setAttribute('x1', String(slot.x + 6));
              slideLine.setAttribute('y1', String(hitY + 4));
              slideLine.setAttribute('x2', String(slot.x + 14));
              slideLine.setAttribute('y2', String(hitY - 5));
              slideLine.setAttribute('stroke', '#0284c7');
              slideLine.setAttribute('stroke-width', '1.4');
              techGroup.appendChild(slideLine);
            }

            const topLabels = techs
              .map((t) => TECH_SYMBOL_MAP[t] ?? t)
              .join(' ');
            const labelEl = document.createElementNS(SVG_NS, 'text');
            labelEl.setAttribute('x', String(slot.x));
            labelEl.setAttribute('y', String(line.tabY + 8));
            labelEl.setAttribute('text-anchor', 'middle');
            labelEl.setAttribute('font-size', '10');
            labelEl.setAttribute('font-weight', '700');
            labelEl.setAttribute('fill', '#b45309');
            labelEl.setAttribute('class', 'nb-tab-tech-label');
            labelEl.textContent = topLabels;
            techGroup.appendChild(labelEl);

            targetEl.appendChild(techGroup);
          }
        }
      }
    }
  }

  const svg = container.querySelector('svg');
  if (svg && layout.lines[0]) {
    const firstLine = layout.lines[0];
    const capo = options.capo ?? 0;
    if (capo > 0) {
      const capoEl = document.createElementNS(SVG_NS, 'text');
      capoEl.setAttribute('x', String((firstLine.measures[0]?.x ?? 24) + 8));
      capoEl.setAttribute('y', String(firstLine.tabY + 12));
      capoEl.setAttribute('font-size', '11');
      capoEl.setAttribute('font-weight', '700');
      capoEl.setAttribute('fill', '#b45309');
      capoEl.setAttribute('data-testid', 'tab-capo-badge');
      capoEl.textContent = `Capo ${capo}`;
      svg.appendChild(capoEl);
    }
  }

  return svg;
}
