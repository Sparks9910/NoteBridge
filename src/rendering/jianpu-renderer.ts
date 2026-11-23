import { computeBeamGroups } from '../domain/rhythm.ts';
import type {
  Accidental,
  BaseDuration,
  NoteEvent,
  ResolvedNote,
  ScoreDocument,
} from '../domain/types.ts';
import type {
  MeasureNotationExtra,
  NoteNotationExtra,
} from '../domain/v2-types.ts';
import type { ScoreLayout } from './layout-engine.ts';

export interface JianpuNoteViewModel {
  noteId: string;
  measureIndex: number;
  lineIndex: number;
  x: number;
  y: number;
  width: number;
  label: string;
  accidentalSymbol: string | null;
  octaveOffset: -2 | -1 | 0 | 1 | 2;
  underlineCount: 0 | 1 | 2;
  dashCount: number;
  dotted: boolean;
}

export interface JianpuBeamSegment {
  lineIndex: number;
  x1: number;
  x2: number;
  y: number;
  underlineCount: 1 | 2;
}

export interface JianpuMeasureViewModel {
  measureIndex: number;
  lineIndex: number;
  x: number;
  y: number;
  width: number;
  isOverflow: boolean;
  isLastMeasure: boolean;
  notes: JianpuNoteViewModel[];
  beamSegments: JianpuBeamSegment[];
}

export interface JianpuRenderModel {
  totalWidth: number;
  totalHeight: number;
  keyLabel: string;
  timeSignature: string;
  measures: JianpuMeasureViewModel[];
}

export interface JianpuRenderOptions {
  activeNoteId?: string | null;
  selectedNoteId?: string | null;
  noteExtrasById?: Readonly<Record<string, NoteNotationExtra>>;
  measureExtrasByIndex?: Readonly<Record<number, MeasureNotationExtra>>;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function getAccidentalSymbol(accidental: Accidental): string | null {
  if (accidental === 'sharp') {
    return '♯';
  }
  if (accidental === 'flat') {
    return '♭';
  }
  if (accidental === 'natural') {
    return '♮';
  }
  return null;
}

function getUnderlineCount(baseDuration: BaseDuration): 0 | 1 | 2 {
  if (baseDuration === 'eighth') {
    return 1;
  }
  if (baseDuration === 'sixteenth') {
    return 2;
  }
  return 0;
}

function getDashCount(note: NoteEvent): number {
  if (note.baseDuration === 'whole') {
    return 3;
  }
  if (note.baseDuration === 'half') {
    return note.dotted ? 2 : 1;
  }
  return 0;
}

/**
 * 构建纯数据简谱渲染模型，确保每个简谱音符的 x 坐标严格等于 LayoutSlot.x。
 */
export function buildJianpuRenderModel(
  doc: ScoreDocument,
  _resolvedNotes: readonly ResolvedNote[],
  layout: ScoreLayout
): JianpuRenderModel {
  const measureMap = new Map<number, (typeof doc.measures)[number]>();
  for (const m of doc.measures) {
    measureMap.set(m.index, m);
  }

  const totalMeasures = doc.measures.length;
  const measures: JianpuMeasureViewModel[] = [];

  for (const line of layout.lines) {
    const baselineY = line.jianpuY + 34;

    for (const mLayout of line.measures) {
      const measure = measureMap.get(mLayout.measureIndex);
      if (!measure) {
        continue;
      }

      const noteViewModels: JianpuNoteViewModel[] = [];
      const noteVmById = new Map<string, JianpuNoteViewModel>();

      for (const note of measure.notes) {
        const slot = layout.slotByNoteId[note.id];
        if (!slot) {
          continue;
        }
        const vm: JianpuNoteViewModel = {
          noteId: note.id,
          measureIndex: measure.index,
          lineIndex: line.lineIndex,
          x: slot.x,
          y: baselineY,
          width: slot.width,
          label: note.isRest ? '0' : String(note.degree),
          accidentalSymbol: note.isRest
            ? null
            : getAccidentalSymbol(note.accidental),
          octaveOffset: note.isRest ? 0 : note.octaveOffset,
          underlineCount: getUnderlineCount(note.baseDuration),
          dashCount: getDashCount(note),
          dotted: note.dotted && note.baseDuration !== 'half' && note.baseDuration !== 'whole',
        };
        noteViewModels.push(vm);
        noteVmById.set(note.id, vm);
      }

      const beamGroups = computeBeamGroups(measure.notes, doc.timeSignature);
      const beamSegments: JianpuBeamSegment[] = [];
      for (const group of beamGroups) {
        const firstId = group.noteIds[0];
        const lastId = group.noteIds[group.noteIds.length - 1];
        const firstVm = firstId ? noteVmById.get(firstId) : undefined;
        const lastVm = lastId ? noteVmById.get(lastId) : undefined;
        if (firstVm && lastVm) {
          const maxLines = group.noteIds.some(
            (id) => (noteVmById.get(id)?.underlineCount ?? 0) === 2
          )
            ? 2
            : 1;
          beamSegments.push({
            lineIndex: line.lineIndex,
            x1: firstVm.x - 7,
            x2: lastVm.x + 7,
            y: baselineY + 7,
            underlineCount: maxLines,
          });
        }
      }

      measures.push({
        measureIndex: measure.index,
        lineIndex: line.lineIndex,
        x: mLayout.x,
        y: line.jianpuY,
        width: mLayout.width,
        isOverflow: mLayout.validity === 'OVERFLOW',
        isLastMeasure: measure.index === totalMeasures - 1,
        notes: noteViewModels,
        beamSegments,
      });
    }
  }

  return {
    totalWidth: layout.totalWidth,
    totalHeight: layout.totalHeight,
    keyLabel: `1 = ${doc.keySignature}`,
    timeSignature: doc.timeSignature,
    measures,
  };
}

function createSvgElement<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  return el;
}

/** 渲染自研简谱 SVG（严格对齐 LayoutSlot.x） */
export function renderJianpu(
  container: HTMLElement,
  doc: ScoreDocument,
  resolvedNotes: readonly ResolvedNote[],
  layout: ScoreLayout,
  options?: JianpuRenderOptions
): SVGSVGElement | null {
  container.innerHTML = '';

  const model = buildJianpuRenderModel(doc, resolvedNotes, layout);
  const svg = createSvgElement('svg', {
    class: 'nb-jianpu-svg',
    width: model.totalWidth,
    height: model.totalHeight,
    viewBox: `0 0 ${model.totalWidth} ${model.totalHeight}`,
  });

  const firstMeasure = model.measures[0];
  if (firstMeasure) {
    const header = createSvgElement('text', {
      x: firstMeasure.x + 4,
      y: firstMeasure.y + 18,
      class: 'nb-jianpu-header',
      'font-size': '12',
      'font-weight': '600',
      fill: '#334155',
    });
    header.textContent = `${model.keyLabel}  ${model.timeSignature}`;
    svg.appendChild(header);
  }

  let openTie: { x: number; y: number } | null = null;
  let openSlur: { x: number; y: number } | null = null;

  for (const m of model.measures) {
    const mExtra = options?.measureExtrasByIndex?.[m.measureIndex];
    if (m.isOverflow) {
      svg.appendChild(
        createSvgElement('rect', {
          x: m.x + 1,
          y: m.y + 4,
          width: Math.max(10, m.width - 2),
          height: 62,
          fill: 'rgba(220, 38, 38, 0.08)',
          stroke: '#dc2626',
          'stroke-width': 1.5,
          'stroke-dasharray': '4 3',
          'data-overflow-measure': m.measureIndex,
        })
      );
    }

    if (mExtra?.repeatStart) {
      svg.appendChild(
        createSvgElement('line', {
          x1: m.x + 2,
          y1: m.y + 16,
          x2: m.x + 2,
          y2: m.y + 52,
          stroke: '#0f172a',
          'stroke-width': 2.5,
        })
      );
      svg.appendChild(
        createSvgElement('line', {
          x1: m.x + 6,
          y1: m.y + 16,
          x2: m.x + 6,
          y2: m.y + 52,
          stroke: '#0f172a',
          'stroke-width': 1,
        })
      );
      svg.appendChild(createSvgElement('circle', { cx: m.x + 10, cy: m.y + 28, r: 1.6, fill: '#0f172a' }));
      svg.appendChild(createSvgElement('circle', { cx: m.x + 10, cy: m.y + 39, r: 1.6, fill: '#0f172a' }));
    }

    if (mExtra?.ending) {
      const endingText = createSvgElement('text', {
        x: m.x + 16,
        y: m.y + 14,
        'font-size': 10,
        'font-weight': 700,
        fill: '#0f172a',
      });
      endingText.textContent = `${mExtra.ending}.`;
      svg.appendChild(endingText);
    }

    // 小节右侧纵线（末小节或反复结束线）
    const barLineX = m.x + m.width;
    const isDoubleOrFinal = m.isLastMeasure || mExtra?.repeatEnd || mExtra?.barline === 'double' || mExtra?.barline === 'final';
    svg.appendChild(
      createSvgElement('line', {
        x1: barLineX,
        y1: m.y + 16,
        x2: barLineX,
        y2: m.y + 52,
        stroke: '#64748b',
        'stroke-width': m.isLastMeasure || mExtra?.repeatEnd || mExtra?.barline === 'final' ? 2.5 : 1.2,
      })
    );
    if (isDoubleOrFinal) {
      svg.appendChild(
        createSvgElement('line', {
          x1: barLineX - 4,
          y1: m.y + 16,
          x2: barLineX - 4,
          y2: m.y + 52,
          stroke: '#64748b',
          'stroke-width': 1,
        })
      );
      if (mExtra?.repeatEnd) {
        svg.appendChild(createSvgElement('circle', { cx: barLineX - 8, cy: m.y + 28, r: 1.6, fill: '#0f172a' }));
        svg.appendChild(createSvgElement('circle', { cx: barLineX - 8, cy: m.y + 39, r: 1.6, fill: '#0f172a' }));
      }
    }

    // 减时线连杠
    for (const seg of m.beamSegments) {
      svg.appendChild(
        createSvgElement('line', {
          x1: seg.x1,
          y1: seg.y,
          x2: seg.x2,
          y2: seg.y,
          stroke: '#0f172a',
          'stroke-width': 1.5,
        })
      );
      if (seg.underlineCount === 2) {
        svg.appendChild(
          createSvgElement('line', {
            x1: seg.x1,
            y1: seg.y + 4,
            x2: seg.x2,
            y2: seg.y + 4,
            stroke: '#0f172a',
            'stroke-width': 1.5,
          })
        );
      }
    }

    for (const noteVm of m.notes) {
      const classes = ['nb-jianpu-note'];
      if (options?.activeNoteId === noteVm.noteId) {
        classes.push('nb-note-active');
      }
      if (options?.selectedNoteId === noteVm.noteId) {
        classes.push('nb-note-selected');
      }

      const group = createSvgElement('g', {
        class: classes.join(' '),
        'data-note-id': noteVm.noteId,
        'data-measure-index': noteVm.measureIndex,
        'data-anchor-x': noteVm.x,
      });

      // 音符数字（严格以 noteVm.x === LayoutSlot.x 居中）
      const digit = createSvgElement('text', {
        x: noteVm.x,
        y: noteVm.y,
        'text-anchor': 'middle',
        'font-size': '18',
        'font-weight': '600',
        fill: options?.activeNoteId === noteVm.noteId ? '#2563eb' : '#0f172a',
      });
      digit.textContent = noteVm.label;
      group.appendChild(digit);

      // 临时升降/还原记号
      if (noteVm.accidentalSymbol) {
        const acc = createSvgElement('text', {
          x: noteVm.x - 11,
          y: noteVm.y - 7,
          'font-size': '12',
          fill: '#0f172a',
        });
        acc.textContent = noteVm.accidentalSymbol;
        group.appendChild(acc);
      }

      // 附点
      if (noteVm.dotted) {
        group.appendChild(
          createSvgElement('circle', {
            cx: noteVm.x + 11,
            cy: noteVm.y - 4,
            r: 1.8,
            fill: '#0f172a',
          })
        );
      }

      // 增时线
      for (let d = 0; d < noteVm.dashCount; d += 1) {
        const dashX = noteVm.x + 14 + d * 14;
        group.appendChild(
          createSvgElement('line', {
            x1: dashX - 4,
            y1: noteVm.y - 6,
            x2: dashX + 4,
            y2: noteVm.y - 6,
            stroke: '#0f172a',
            'stroke-width': 1.6,
          })
        );
      }

      // 独立减时线（单音符自身下划线）
      for (let u = 0; u < noteVm.underlineCount; u += 1) {
        const lineY = noteVm.y + 7 + u * 4;
        group.appendChild(
          createSvgElement('line', {
            x1: noteVm.x - 7,
            y1: lineY,
            x2: noteVm.x + 7,
            y2: lineY,
            stroke: '#0f172a',
            'stroke-width': 1.4,
          })
        );
      }

      // 高音点
      if (noteVm.octaveOffset > 0) {
        for (let o = 0; o < noteVm.octaveOffset; o += 1) {
          group.appendChild(
            createSvgElement('circle', {
              cx: noteVm.x,
              cy: noteVm.y - 18 - o * 5,
              r: 1.8,
              fill: '#0f172a',
            })
          );
        }
      }

      // 低音点
      if (noteVm.octaveOffset < 0) {
        const lowBaseY = noteVm.y + 10 + noteVm.underlineCount * 4;
        for (let o = 0; o < Math.abs(noteVm.octaveOffset); o += 1) {
          group.appendChild(
            createSvgElement('circle', {
              cx: noteVm.x,
              cy: lowBaseY + o * 5,
              r: 1.8,
              fill: '#0f172a',
            })
          );
        }
      }

      const extra = options?.noteExtrasById?.[noteVm.noteId];
      if (extra) {
        if (extra.fingering) {
          const fg = createSvgElement('text', {
            x: noteVm.x,
            y: noteVm.y - 24 - Math.max(0, noteVm.octaveOffset) * 5,
            'text-anchor': 'middle',
            'font-size': 10,
            'font-weight': 700,
            fill: '#2563eb',
            'data-jianpu-fingering': noteVm.noteId,
          });
          fg.textContent = extra.fingering;
          group.appendChild(fg);
        }

        if (extra.ornament) {
          const ornLabel =
            extra.ornament === 'trill'
              ? 'tr'
              : extra.ornament === 'staccato'
                ? '•'
                : extra.ornament === 'accent'
                  ? '>'
                  : '𝄐';
          const ornEl = createSvgElement('text', {
            x: noteVm.x + 9,
            y: noteVm.y - 16,
            'text-anchor': 'middle',
            'font-size': 10,
            'font-weight': 700,
            fill: '#0f172a',
            'data-jianpu-ornament': noteVm.noteId,
          });
          ornEl.textContent = ornLabel;
          group.appendChild(ornEl);
        }

        if (extra.dynamic) {
          const dynEl = createSvgElement('text', {
            x: noteVm.x - 10,
            y: noteVm.y + 16,
            'text-anchor': 'end',
            'font-size': 10,
            'font-style': 'italic',
            'font-weight': 700,
            fill: '#475569',
            'data-jianpu-dynamic': noteVm.noteId,
          });
          dynEl.textContent = extra.dynamic;
          group.appendChild(dynEl);
        }

        if (extra.lyric && extra.lyric.trim().length > 0) {
          const lyricY =
            noteVm.y +
            22 +
            noteVm.underlineCount * 4 +
            Math.max(0, -noteVm.octaveOffset) * 5;
          const lyricEl = createSvgElement('text', {
            x: noteVm.x,
            y: lyricY,
            'text-anchor': 'middle',
            'font-size': 12,
            fill: '#1e293b',
            'data-jianpu-lyric': noteVm.noteId,
          });
          lyricEl.textContent = extra.lyric.trim();
          group.appendChild(lyricEl);
        }

        if (extra.tieEnd && openTie) {
          const midX = (openTie.x + noteVm.x) / 2;
          const arcY = noteVm.y - 14;
          svg.appendChild(
            createSvgElement('path', {
              d: `M ${openTie.x + 3} ${arcY} Q ${midX} ${arcY - 10} ${noteVm.x - 3} ${arcY}`,
              fill: 'none',
              stroke: '#0f172a',
              'stroke-width': 1.2,
              'data-jianpu-tie': noteVm.noteId,
            })
          );
          openTie = null;
        }
        if (extra.tieStart) {
          openTie = { x: noteVm.x, y: noteVm.y };
        }

        if (extra.slurEnd && openSlur) {
          const midX = (openSlur.x + noteVm.x) / 2;
          const arcY = noteVm.y - 16;
          svg.appendChild(
            createSvgElement('path', {
              d: `M ${openSlur.x} ${arcY} Q ${midX} ${arcY - 12} ${noteVm.x} ${arcY}`,
              fill: 'none',
              stroke: '#2563eb',
              'stroke-width': 1.2,
              'data-jianpu-slur': noteVm.noteId,
            })
          );
          openSlur = null;
        }
        if (extra.slurStart) {
          openSlur = { x: noteVm.x, y: noteVm.y };
        }
      }

      svg.appendChild(group);
    }
  }

  container.appendChild(svg);
  return svg;
}
