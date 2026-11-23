import { getKeySignatureAccidentalCount } from '../domain/accidental.ts';
import { validateMeasureRhythm } from '../domain/rhythm.ts';
import type {
  LayoutSlot,
  MeasureValidityState,
  ResolvedNote,
  ScoreDocument,
} from '../domain/types.ts';

export interface LayoutOptions {
  containerWidth?: number;
  measuresPerLine?: number;
  paddingX?: number;
  paddingTop?: number;
  staffLineHeight?: number;
  jianpuLineHeight?: number;
  lineGap?: number;
  isGrandStaff?: boolean;
  hasLyricsOrMarkings?: boolean;
}

export interface MeasureLayout {
  measureIndex: number;
  lineIndex: number;
  x: number;
  width: number;
  contentStartX: number;
  contentWidth: number;
  startTick: number;
  endTick: number;
  validity: MeasureValidityState;
  slots: LayoutSlot[];
}

export interface LayoutLine {
  lineIndex: number;
  y: number;
  staffY: number;
  jianpuY: number;
  height: number;
  measures: MeasureLayout[];
}

export interface ScoreLayout {
  totalWidth: number;
  totalHeight: number;
  lines: LayoutLine[];
  slots: LayoutSlot[];
  slotByNoteId: Readonly<Record<string, LayoutSlot>>;
  totalTicks: number;
}

export interface CursorPosition {
  x: number;
  lineIndex: number;
  measureIndex: number;
  activeNoteId: string | null;
}

const DEFAULT_CONTAINER_WIDTH = 960;
const MIN_MEASURE_WIDTH = 160;
const DEFAULT_PADDING_X = 24;
const DEFAULT_PADDING_TOP = 24;
const DEFAULT_STAFF_HEIGHT = 110;
const DEFAULT_JIANPU_HEIGHT = 76;
const DEFAULT_LINE_GAP = 28;
const RIGHT_INNER_PADDING = 14;

function computeClefAndKeyWidth(
  keyAccidentalCount: number,
  includeTimeSignature: boolean
): number {
  const clefWidth = 34;
  const keySigWidth = keyAccidentalCount * 11;
  const timeSigWidth = includeTimeSignature ? 28 : 0;
  return clefWidth + keySigWidth + timeSigWidth + 14;
}

function getDurationWeight(durationTicks: number): number {
  return Math.pow(Math.max(60, durationTicks) / 120, 0.65);
}

function roundPx(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 计算整份乐谱的共享横坐标布局。
 * 五线谱与简谱必须同时订阅本函数输出的 LayoutSlot.x，确保双谱 0 错位。
 */
export function computeScoreLayout(
  doc: ScoreDocument,
  resolvedNotes: readonly ResolvedNote[],
  options?: LayoutOptions
): ScoreLayout {
  const containerWidth = Math.max(
    420,
    options?.containerWidth ?? DEFAULT_CONTAINER_WIDTH
  );
  const paddingX = options?.paddingX ?? DEFAULT_PADDING_X;
  const paddingTop = options?.paddingTop ?? DEFAULT_PADDING_TOP;
  const staffHeight =
    options?.staffLineHeight ??
    (options?.isGrandStaff ? 210 : DEFAULT_STAFF_HEIGHT);
  const jianpuHeight =
    options?.jianpuLineHeight ??
    (options?.hasLyricsOrMarkings ? 96 : DEFAULT_JIANPU_HEIGHT);
  const lineGap = options?.lineGap ?? DEFAULT_LINE_GAP;
  const usableWidth = containerWidth - paddingX * 2;

  const requestedPerLine = Math.max(1, options?.measuresPerLine ?? 4);
  const maxFitPerLine = Math.max(1, Math.floor(usableWidth / MIN_MEASURE_WIDTH));
  const measuresPerLine = Math.min(requestedPerLine, maxFitPerLine);

  const keyAccCount = getKeySignatureAccidentalCount(doc.keySignature);
  const resolvedByNoteId = new Map<string, ResolvedNote>();
  for (const rn of resolvedNotes) {
    resolvedByNoteId.set(rn.noteId, rn);
  }

  const lines: LayoutLine[] = [];
  const allSlots: LayoutSlot[] = [];
  const slotByNoteId: Record<string, LayoutSlot> = {};

  let runningTick = 0;
  const totalMeasures = doc.measures.length;
  const lineCount = Math.max(1, Math.ceil(totalMeasures / measuresPerLine));
  const lineBlockHeight = staffHeight + jianpuHeight + lineGap;

  for (let lineIdx = 0; lineIdx < lineCount; lineIdx += 1) {
    const startIdx = lineIdx * measuresPerLine;
    const endIdx = Math.min(totalMeasures, startIdx + measuresPerLine);
    const lineMeasures = doc.measures.slice(startIdx, endIdx);
    const countInLine = Math.max(1, lineMeasures.length);

    const firstExtraWidth = computeClefAndKeyWidth(
      keyAccCount,
      lineIdx === 0
    );
    const remainingForBars = Math.max(
      MIN_MEASURE_WIDTH * countInLine,
      usableWidth - firstExtraWidth
    );
    const baseMeasureContentWidth = remainingForBars / countInLine;

    const lineY = paddingTop + lineIdx * lineBlockHeight;
    const staffY = lineY;
    const jianpuY = lineY + staffHeight;

    const measureLayouts: MeasureLayout[] = [];
    let cursorMeasureX = paddingX;

    for (let mOffset = 0; mOffset < lineMeasures.length; mOffset += 1) {
      const measure = lineMeasures[mOffset];
      if (!measure) {
        continue;
      }
      const isFirstInLine = mOffset === 0;
      const prefixWidth = isFirstInLine ? firstExtraWidth : 12;
      const measureWidth = roundPx(baseMeasureContentWidth + (isFirstInLine ? firstExtraWidth : 0));
      const contentStartX = roundPx(cursorMeasureX + prefixWidth);
      const contentWidth = Math.max(
        40,
        roundPx(measureWidth - prefixWidth - RIGHT_INNER_PADDING)
      );

      const rhythmRes = validateMeasureRhythm(measure, doc.timeSignature);
      const validity: MeasureValidityState = rhythmRes.ok
        ? rhythmRes.value.state
        : 'EMPTY';

      const measureStartTick = runningTick;
      const slots: LayoutSlot[] = [];

      if (measure.notes.length > 0) {
        const weights = measure.notes.map((n) => getDurationWeight(n.durationTicks));
        const totalWeight = weights.reduce((acc, w) => acc + w, 0) || 1;
        let noteCursorX = contentStartX;

        for (let i = 0; i < measure.notes.length; i += 1) {
          const note = measure.notes[i];
          if (!note) {
            continue;
          }
          const weight = weights[i] ?? 1;
          const slotWidth = roundPx((contentWidth * weight) / totalWeight);
          const anchorX = roundPx(noteCursorX + slotWidth / 2);

          const slot: LayoutSlot = {
            noteId: note.id,
            measureIndex: measure.index,
            lineIndex: lineIdx,
            x: anchorX,
            width: slotWidth,
          };
          slots.push(slot);
          allSlots.push(slot);
          slotByNoteId[note.id] = slot;

          noteCursorX += slotWidth;
          runningTick += note.durationTicks;
        }
      }

      measureLayouts.push({
        measureIndex: measure.index,
        lineIndex: lineIdx,
        x: roundPx(cursorMeasureX),
        width: measureWidth,
        contentStartX,
        contentWidth,
        startTick: measureStartTick,
        endTick: runningTick,
        validity,
        slots,
      });

      cursorMeasureX += measureWidth;
    }

    lines.push({
      lineIndex: lineIdx,
      y: lineY,
      staffY,
      jianpuY,
      height: staffHeight + jianpuHeight,
      measures: measureLayouts,
    });
  }

  const totalHeight = paddingTop * 2 + lineCount * lineBlockHeight;

  return {
    totalWidth: containerWidth,
    totalHeight,
    lines,
    slots: allSlots,
    slotByNoteId,
    totalTicks: runningTick,
  };
}

/** 根据全局 Tick 计算播放游标横坐标及当前高亮音符 */
export function getCursorXForTick(
  layout: ScoreLayout,
  resolvedNotes: readonly ResolvedNote[],
  currentTick: number
): CursorPosition {
  const firstLine = layout.lines[0];
  const firstMeasure = firstLine?.measures[0];
  const fallbackX = firstMeasure ? firstMeasure.contentStartX : DEFAULT_PADDING_X;

  if (resolvedNotes.length === 0) {
    return {
      x: fallbackX,
      lineIndex: 0,
      measureIndex: 0,
      activeNoteId: null,
    };
  }

  const clampedTick = Math.max(0, Math.min(currentTick, layout.totalTicks));

  for (let i = 0; i < resolvedNotes.length; i += 1) {
    const note = resolvedNotes[i];
    if (!note) {
      continue;
    }
    const start = note.startTickInScore;
    const end = start + note.durationTicks;

    if (clampedTick >= start && clampedTick < end) {
      const slot = layout.slotByNoteId[note.noteId];
      if (!slot) {
        break;
      }
      const nextNote = resolvedNotes[i + 1];
      const nextSlot = nextNote ? layout.slotByNoteId[nextNote.noteId] : undefined;
      const progress = note.durationTicks > 0
        ? (clampedTick - start) / note.durationTicks
        : 0;

      let x = slot.x;
      if (nextSlot && nextSlot.lineIndex === slot.lineIndex) {
        x = roundPx(slot.x + (nextSlot.x - slot.x) * progress);
      } else {
        x = roundPx(slot.x + (slot.width * 0.5) * progress);
      }

      return {
        x,
        lineIndex: slot.lineIndex,
        measureIndex: slot.measureIndex,
        activeNoteId: note.noteId,
      };
    }
  }

  const lastNote = resolvedNotes[resolvedNotes.length - 1];
  const lastSlot = lastNote ? layout.slotByNoteId[lastNote.noteId] : undefined;
  if (lastSlot) {
    return {
      x: roundPx(lastSlot.x + lastSlot.width * 0.5),
      lineIndex: lastSlot.lineIndex,
      measureIndex: lastSlot.measureIndex,
      activeNoteId: null,
    };
  }

  return {
    x: fallbackX,
    lineIndex: 0,
    measureIndex: 0,
    activeNoteId: null,
  };
}
