import {
  Accidental as VexAccidental,
  Beam,
  Dot,
  Renderer,
  Stave,
  StaveNote,
  Stem,
  TickContext,
} from 'vexflow';
import { computeBeamGroups } from '../domain/rhythm.ts';
import type {
  Accidental,
  BaseDuration,
  NoteEvent,
  ResolvedNote,
  ScoreDocument,
} from '../domain/types.ts';
import type { ScoreLayout } from './layout-engine.ts';

export interface StaffRenderOptions {
  activeNoteId?: string | null;
  selectedNoteId?: string | null;
}

const VEX_DURATION_MAP: Record<BaseDuration, string> = {
  whole: 'w',
  half: 'h',
  quarter: 'q',
  eighth: '8',
  sixteenth: '16',
};

const VEX_ACCIDENTAL_MAP: Record<Exclude<Accidental, null>, string> = {
  sharp: '#',
  flat: 'b',
  natural: 'n',
};

function buildVexDuration(note: NoteEvent): string {
  const base = VEX_DURATION_MAP[note.baseDuration];
  const dotted = note.dotted ? 'd' : '';
  const rest = note.isRest ? 'r' : '';
  return `${base}${dotted}${rest}`;
}

function createVexStaveNote(
  note: NoteEvent,
  resolved: ResolvedNote | undefined
): StaveNote {
  const keys =
    note.isRest || !resolved?.staffPitchName
      ? ['b/4']
      : [resolved.staffPitchName];

  const staveNote = new StaveNote({
    keys,
    duration: buildVexDuration(note),
    clef: 'treble',
  });

  if (note.dotted) {
    Dot.buildAndAttach([staveNote], { all: true });
  }

  if (!note.isRest && resolved?.displayAccidental) {
    const symbol = VEX_ACCIDENTAL_MAP[resolved.displayAccidental];
    staveNote.addModifier(new VexAccidental(symbol), 0);
  }

  if (!note.isRest && resolved?.stemDirection) {
    staveNote.setStemDirection(
      resolved.stemDirection === 'up' ? Stem.UP : Stem.DOWN
    );
  }

  return staveNote;
}

/**
 * 渲染五线谱 SVG。
 * 严格订阅 layout-engine 提供的 LayoutSlot.x，确保五线谱音符中心与简谱横坐标对齐。
 */
export function renderStaff(
  container: HTMLDivElement,
  doc: ScoreDocument,
  resolvedNotes: readonly ResolvedNote[],
  layout: ScoreLayout,
  options?: StaffRenderOptions
): SVGSVGElement | null {
  container.innerHTML = '';

  const renderer = new Renderer(container, Renderer.Backends.SVG);
  renderer.resize(layout.totalWidth, layout.totalHeight);
  const ctx = renderer.getContext();

  const resolvedMap = new Map<string, ResolvedNote>();
  for (const rn of resolvedNotes) {
    resolvedMap.set(rn.noteId, rn);
  }

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

      const stave = new Stave(mLayout.x, line.staffY + 12, mLayout.width);
      if (mOffset === 0) {
        stave.addClef('treble').addKeySignature(doc.keySignature);
        if (mLayout.measureIndex === 0) {
          stave.addTimeSignature(doc.timeSignature);
        }
      }
      stave.setNoteStartX(mLayout.contentStartX);
      stave.setContext(ctx).draw();

      const staveNotesById = new Map<string, StaveNote>();
      const orderedItems: Array<{ note: NoteEvent; staveNote: StaveNote }> = [];

      for (const note of measure.notes) {
        const slot = layout.slotByNoteId[note.id];
        if (!slot) {
          continue;
        }
        const resolved = resolvedMap.get(note.id);
        const staveNote = createVexStaveNote(note, resolved);

        const tickContext = new TickContext();
        tickContext.addTickable(staveNote);
        tickContext.preFormat();
        tickContext.setX(slot.x - stave.getNoteStartX());

        staveNote.setStave(stave).setContext(ctx);
        const delta = slot.x - staveNote.getAbsoluteX();
        if (Math.abs(delta) > 0.01) {
          tickContext.setX(tickContext.getX() + delta);
        }

        staveNotesById.set(note.id, staveNote);
        orderedItems.push({ note, staveNote });
      }

      const beamGroups = computeBeamGroups(measure.notes, doc.timeSignature);
      const beams: Beam[] = [];
      for (const group of beamGroups) {
        const groupNotes: StaveNote[] = [];
        for (const id of group.noteIds) {
          const sn = staveNotesById.get(id);
          if (sn) {
            groupNotes.push(sn);
          }
        }
        if (groupNotes.length >= 2) {
          beams.push(new Beam(groupNotes));
        }
      }

      for (const item of orderedItems) {
        item.staveNote.draw();
        const svgEl = item.staveNote.getSVGElement();
        if (svgEl) {
          const slot = layout.slotByNoteId[item.note.id];
          svgEl.setAttribute('data-note-id', item.note.id);
          svgEl.setAttribute('data-measure-index', String(mLayout.measureIndex));
          if (slot) {
            svgEl.setAttribute('data-anchor-x', String(slot.x));
          }
          if (options?.activeNoteId === item.note.id) {
            svgEl.classList.add('nb-note-active');
          }
          if (options?.selectedNoteId === item.note.id) {
            svgEl.classList.add('nb-note-selected');
          }
        }
      }

      for (const beam of beams) {
        beam.setContext(ctx).draw();
      }
    }
  }

  const svg = container.querySelector('svg');
  if (svg) {
    svg.setAttribute('class', 'nb-staff-svg');
    // 为超拍小节追加可视化红色告警框
    const svgNs = 'http://www.w3.org/2000/svg';
    for (const line of layout.lines) {
      for (const mLayout of line.measures) {
        if (mLayout.validity === 'OVERFLOW') {
          const rect = document.createElementNS(svgNs, 'rect');
          rect.setAttribute('x', String(mLayout.x + 1));
          rect.setAttribute('y', String(line.staffY + 6));
          rect.setAttribute('width', String(Math.max(10, mLayout.width - 2)));
          rect.setAttribute('height', '88');
          rect.setAttribute('fill', 'rgba(220, 38, 38, 0.08)');
          rect.setAttribute('stroke', '#dc2626');
          rect.setAttribute('stroke-width', '1.5');
          rect.setAttribute('stroke-dasharray', '4 3');
          rect.setAttribute('data-overflow-measure', String(mLayout.measureIndex));
          svg.appendChild(rect);
        }
      }
    }
  }

  return svg;
}
