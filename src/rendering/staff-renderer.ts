import {
  Accidental as VexAccidental,
  BarlineType,
  Beam,
  Dot,
  Renderer,
  Stave,
  StaveConnector,
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
import type {
  Beat,
  MeasureNotationExtra,
  NoteNotationExtra,
  Track,
  V2Measure,
} from '../domain/v2-types.ts';
import type { ScoreLayout } from './layout-engine.ts';

export interface StaffRenderOptions {
  activeNoteId?: string | null;
  selectedNoteId?: string | null;
  clef?: Track['clef'];
  voice2Measures?: readonly V2Measure[];
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

const VEX_ACCIDENTAL_MAP: Record<Exclude<Accidental, null>, string> = {
  sharp: '#',
  flat: 'b',
  natural: 'n',
};

function buildVexDurationFromFields(
  baseDuration: BaseDuration,
  dotted: boolean,
  isRest: boolean
): string {
  const base = VEX_DURATION_MAP[baseDuration];
  const d = dotted ? 'd' : '';
  const r = isRest ? 'r' : '';
  return `${base}${d}${r}`;
}

function buildVexDuration(note: NoteEvent): string {
  return buildVexDurationFromFields(note.baseDuration, note.dotted, note.isRest);
}

const SHARP_PITCH_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];

function midiToVexKey(midiPitch: number): string {
  const clamped = Math.max(24, Math.min(108, Math.round(midiPitch)));
  const pc = ((clamped % 12) + 12) % 12;
  const octave = Math.floor(clamped / 12) - 1;
  return `${SHARP_PITCH_NAMES[pc] ?? 'c'}/${octave}`;
}

function createVexStaveNote(
  note: NoteEvent,
  resolved: ResolvedNote | undefined,
  clef: 'treble' | 'bass' = 'treble'
): StaveNote {
  const restKey = clef === 'bass' ? 'd/3' : 'b/4';
  const keys =
    note.isRest || !resolved?.staffPitchName
      ? [restKey]
      : [resolved.staffPitchName];

  const staveNote = new StaveNote({
    keys,
    duration: buildVexDuration(note),
    clef,
  });

  if (note.dotted) {
    Dot.buildAndAttach([staveNote], { all: true });
  }

  if (!note.isRest && resolved?.displayAccidental) {
    const symbol = VEX_ACCIDENTAL_MAP[resolved.displayAccidental];
    staveNote.addModifier(new VexAccidental(symbol), 0);
  }

  if (!note.isRest && clef === 'treble' && resolved?.stemDirection) {
    staveNote.setStemDirection(
      resolved.stemDirection === 'up' ? Stem.UP : Stem.DOWN
    );
  }

  return staveNote;
}

function createVoice2StaveNote(beat: Beat, clef: 'treble' | 'bass'): StaveNote {
  const restKey = clef === 'bass' ? 'd/3' : 'b/4';
  const keys =
    beat.isRest || beat.notes.length === 0
      ? [restKey]
      : beat.notes.map((n) => midiToVexKey(n.midiPitch));

  const staveNote = new StaveNote({
    keys,
    duration: buildVexDurationFromFields(beat.baseDuration, beat.dotted, beat.isRest),
    clef,
  });

  if (beat.dotted) {
    Dot.buildAndAttach([staveNote], { all: true });
  }

  if (!beat.isRest) {
    beat.notes.forEach((n, idx) => {
      if (n.accidental) {
        staveNote.addModifier(new VexAccidental(VEX_ACCIDENTAL_MAP[n.accidental]), idx);
      }
    });
    if (clef === 'treble') {
      staveNote.setStemDirection(Stem.DOWN);
    }
  }

  return staveNote;
}

function applyBarlineToStave(stave: Stave, extra: MeasureNotationExtra | undefined): void {
  if (!extra) return;
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

const SVG_NS = 'http://www.w3.org/2000/svg';

function appendOverlayText(
  svg: SVGSVGElement,
  x: number,
  y: number,
  text: string,
  attrs?: Record<string, string | number>
): void {
  const el = document.createElementNS(SVG_NS, 'text');
  el.setAttribute('x', String(x));
  el.setAttribute('y', String(y));
  el.setAttribute('text-anchor', 'middle');
  el.setAttribute('font-family', "'Times New Roman', Georgia, serif");
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, String(v));
    }
  }
  el.textContent = text;
  svg.appendChild(el);
}

/**
 * 渲染五线谱 SVG（支持高音/低音/钢琴大谱表、多声部 Voice 2、指法与演奏记号）。
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

  const activeClef = options?.clef ?? 'treble';
  const isGrand = activeClef === 'grand';
  const primaryStaveClef: 'treble' | 'bass' = activeClef === 'bass' ? 'bass' : 'treble';

  const resolvedMap = new Map<string, ResolvedNote>();
  for (const rn of resolvedNotes) {
    resolvedMap.set(rn.noteId, rn);
  }

  const measureMap = new Map<number, (typeof doc.measures)[number]>();
  for (const m of doc.measures) {
    measureMap.set(m.index, m);
  }

  const overlayMarkings: Array<{
    noteId: string;
    x: number;
    staffY: number;
    extra: NoteNotationExtra;
  }> = [];

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

      const mExtra = options?.measureExtrasByIndex?.[mLayout.measureIndex];
      const stave = new Stave(mLayout.x, line.staffY + 14, mLayout.width);
      if (mOffset === 0) {
        stave.addClef(primaryStaveClef).addKeySignature(doc.keySignature);
        if (mLayout.measureIndex === 0) {
          stave.addTimeSignature(doc.timeSignature);
        }
      }
      stave.setNoteStartX(mLayout.contentStartX);
      applyBarlineToStave(stave, mExtra);
      stave.setContext(ctx).draw();

      let bassStave: Stave | null = null;
      if (isGrand) {
        bassStave = new Stave(mLayout.x, line.staffY + 108, mLayout.width);
        if (mOffset === 0) {
          bassStave.addClef('bass').addKeySignature(doc.keySignature);
          if (mLayout.measureIndex === 0) {
            bassStave.addTimeSignature(doc.timeSignature);
          }
        }
        bassStave.setNoteStartX(mLayout.contentStartX);
        applyBarlineToStave(bassStave, mExtra);
        bassStave.setContext(ctx).draw();

        if (mOffset === 0) {
          new StaveConnector(stave, bassStave)
            .setType(StaveConnector.type.BRACE ?? 3)
            .setContext(ctx)
            .draw();
          new StaveConnector(stave, bassStave)
            .setType(StaveConnector.type.SINGLE_LEFT ?? 1)
            .setContext(ctx)
            .draw();
        }
        if (mOffset === line.measures.length - 1) {
          new StaveConnector(stave, bassStave)
            .setType(
              mExtra?.barline === 'final'
                ? (StaveConnector.type.BOLD_DOUBLE_RIGHT ?? 6)
                : (StaveConnector.type.SINGLE_RIGHT ?? 0)
            )
            .setContext(ctx)
            .draw();
        }
      }

      const staveNotesById = new Map<string, StaveNote>();
      const orderedItems: Array<{ note: NoteEvent; staveNote: StaveNote }> = [];

      for (const note of measure.notes) {
        const slot = layout.slotByNoteId[note.id];
        if (!slot) {
          continue;
        }
        const resolved = resolvedMap.get(note.id);
        const staveNote = createVexStaveNote(note, resolved, primaryStaveClef);

        staveNote.setStave(stave).setContext(ctx);
        const tickContext = new TickContext();
        tickContext.addTickable(staveNote);
        tickContext.preFormat();
        tickContext.setX(slot.x - stave.getNoteStartX());

        const headBegin = staveNote.getNoteHeadBeginX();
        const headEnd = staveNote.getNoteHeadEndX();
        const glyphWidth =
          staveNote.getMetrics().glyphWidth || staveNote.getGlyphWidth() || 11.76;
        const headCenterX =
          headEnd > headBegin
            ? (headBegin + headEnd) / 2
            : staveNote.getAbsoluteX() + glyphWidth / 2;
        const delta = slot.x - headCenterX;
        if (Math.abs(delta) > 0.01) {
          tickContext.setX(tickContext.getX() + delta);
        }

        staveNotesById.set(note.id, staveNote);
        orderedItems.push({ note, staveNote });

        const noteExtra = options?.noteExtrasById?.[note.id];
        if (noteExtra) {
          overlayMarkings.push({
            noteId: note.id,
            x: slot.x,
            staffY: line.staffY,
            extra: noteExtra,
          });
        }
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

      // 渲染 Voice 2（钢琴左手低音谱表或同谱表第二声部，绝不使用 data-note-id 以免干扰双谱对齐选择器）
      const v2Measure = options?.voice2Measures?.[mLayout.measureIndex];
      if (v2Measure && v2Measure.beats.length > 0) {
        const targetStave = bassStave ?? stave;
        const targetClef: 'treble' | 'bass' = bassStave ? 'bass' : primaryStaveClef;
        const totalV2Ticks = v2Measure.beats.reduce((s, b) => s + b.durationTicks, 0) || 1;
        let v2CursorX = mLayout.contentStartX;

        for (let bIdx = 0; bIdx < v2Measure.beats.length; bIdx += 1) {
          const beat = v2Measure.beats[bIdx]!;
          const v1MatchSlot = mLayout.slots[bIdx];
          const segWidth = (mLayout.contentWidth * beat.durationTicks) / totalV2Ticks;
          const anchorX = v1MatchSlot && v2Measure.beats.length === mLayout.slots.length
            ? v1MatchSlot.x
            : v2CursorX + segWidth / 2;
          v2CursorX += segWidth;

          const v2Note = createVoice2StaveNote(beat, targetClef);
          v2Note.setStave(targetStave).setContext(ctx);
          const tc = new TickContext();
          tc.addTickable(v2Note);
          tc.preFormat();
          tc.setX(anchorX - targetStave.getNoteStartX());

          const hb = v2Note.getNoteHeadBeginX();
          const he = v2Note.getNoteHeadEndX();
          const gw = v2Note.getMetrics().glyphWidth || v2Note.getGlyphWidth() || 11.76;
          const hc = he > hb ? (hb + he) / 2 : v2Note.getAbsoluteX() + gw / 2;
          const delta = anchorX - hc;
          if (Math.abs(delta) > 0.01) {
            tc.setX(tc.getX() + delta);
          }

          v2Note.draw();
          const v2Svg = v2Note.getSVGElement();
          if (v2Svg) {
            v2Svg.setAttribute('data-v2-note-id', beat.id);
            v2Svg.setAttribute('data-voice-index', '1');
            v2Svg.setAttribute('data-measure-index', String(mLayout.measureIndex));
            v2Svg.classList.add('nb-voice2-note');
            if (options?.selectedNoteId === beat.id) {
              v2Svg.classList.add('nb-note-selected');
            }
          }
        }
      }
    }
  }

  const svg = container.querySelector('svg');
  if (svg) {
    svg.setAttribute('class', 'nb-staff-svg');
    // 为超拍小节追加可视化红色告警框
    for (const line of layout.lines) {
      for (const mLayout of line.measures) {
        if (mLayout.validity === 'OVERFLOW') {
          const rect = document.createElementNS(SVG_NS, 'rect');
          rect.setAttribute('x', String(mLayout.x + 1));
          rect.setAttribute('y', String(line.staffY + 6));
          rect.setAttribute('width', String(Math.max(10, mLayout.width - 2)));
          rect.setAttribute('height', isGrand ? '186' : '88');
          rect.setAttribute('fill', 'rgba(220, 38, 38, 0.08)');
          rect.setAttribute('stroke', '#dc2626');
          rect.setAttribute('stroke-width', '1.5');
          rect.setAttribute('stroke-dasharray', '4 3');
          rect.setAttribute('data-overflow-measure', String(mLayout.measureIndex));
          svg.appendChild(rect);
        }

        const mExtra = options?.measureExtrasByIndex?.[mLayout.measureIndex];
        if (mExtra?.ending) {
          const bracketY = line.staffY + 10;
          const path = document.createElementNS(SVG_NS, 'path');
          path.setAttribute(
            'd',
            `M ${mLayout.x + 4} ${bracketY + 10} L ${mLayout.x + 4} ${bracketY} L ${mLayout.x + mLayout.width - 4} ${bracketY} L ${mLayout.x + mLayout.width - 4} ${bracketY + 8}`
          );
          path.setAttribute('fill', 'none');
          path.setAttribute('stroke', '#1e293b');
          path.setAttribute('stroke-width', '1.2');
          path.setAttribute('data-ending-measure', String(mLayout.measureIndex));
          svg.appendChild(path);

          appendOverlayText(svg, mLayout.x + 14, bracketY + 11, `${mExtra.ending}.`, {
            'font-size': 11,
            'font-weight': 700,
            fill: '#0f172a',
          });
        }
      }
    }

    // 绘制叠加记号（指法、装饰音、强弱、连音线弧线）
    let openTie: { x: number; staffY: number } | null = null;
    let openSlur: { x: number; staffY: number } | null = null;

    for (const item of overlayMarkings) {
      const { extra, x, staffY } = item;
      if (extra.fingering) {
        appendOverlayText(svg, x, staffY + 16, extra.fingering, {
          'font-size': 11,
          'font-weight': 700,
          fill: '#2563eb',
          'data-staff-fingering': item.noteId,
        });
      }
      if (extra.ornament) {
        const label =
          extra.ornament === 'trill'
            ? 'tr'
            : extra.ornament === 'staccato'
              ? '•'
              : extra.ornament === 'accent'
                ? '>'
                : '𝄐';
        appendOverlayText(svg, x, staffY + 26, label, {
          'font-size': extra.ornament === 'trill' ? 12 : 13,
          'font-style': extra.ornament === 'trill' ? 'italic' : 'normal',
          'font-weight': 700,
          fill: '#0f172a',
          'data-staff-ornament': item.noteId,
        });
      }
      if (extra.dynamic) {
        appendOverlayText(svg, x, staffY + 96, extra.dynamic, {
          'font-size': 12,
          'font-style': 'italic',
          'font-weight': 700,
          fill: '#475569',
          'data-staff-dynamic': item.noteId,
        });
      }
      if (extra.tieEnd && openTie) {
        const path = document.createElementNS(SVG_NS, 'path');
        const midX = (openTie.x + x) / 2;
        const y = staffY + 76;
        path.setAttribute(
          'd',
          `M ${openTie.x + 4} ${y} Q ${midX} ${y + 12} ${x - 4} ${y}`
        );
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', '#0f172a');
        path.setAttribute('stroke-width', '1.4');
        path.setAttribute('data-staff-tie', item.noteId);
        svg.appendChild(path);
        openTie = null;
      }
      if (extra.tieStart) {
        openTie = { x, staffY };
      }
      if (extra.slurEnd && openSlur) {
        const path = document.createElementNS(SVG_NS, 'path');
        const midX = (openSlur.x + x) / 2;
        const y = staffY + 28;
        path.setAttribute(
          'd',
          `M ${openSlur.x} ${y} Q ${midX} ${y - 14} ${x} ${y}`
        );
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', '#2563eb');
        path.setAttribute('stroke-width', '1.4');
        path.setAttribute('data-staff-slur', item.noteId);
        svg.appendChild(path);
        openSlur = null;
      }
      if (extra.slurStart) {
        openSlur = { x, staffY };
      }
    }
  }

  return svg;
}
