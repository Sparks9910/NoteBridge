import { computeBeamGroups } from '../domain/rhythm.ts';
import type {
  Accidental,
  BaseDuration,
  NoteEvent,
  ResolvedNote,
  ScoreDocument,
} from '../domain/types.ts';
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

  for (const m of model.measures) {
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

    // 小节右侧纵线（末小节使用双纵线）
    const barLineX = m.x + m.width;
    svg.appendChild(
      createSvgElement('line', {
        x1: barLineX,
        y1: m.y + 16,
        x2: barLineX,
        y2: m.y + 52,
        stroke: '#64748b',
        'stroke-width': m.isLastMeasure ? 2.5 : 1.2,
      })
    );
    if (m.isLastMeasure) {
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

      svg.appendChild(group);
    }
  }

  container.appendChild(svg);
  return svg;
}
