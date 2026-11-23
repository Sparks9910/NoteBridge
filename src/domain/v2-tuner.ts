import { midiToNoteLabel } from './v2-instruments.ts';

export const DEFAULT_A4_HZ = 440;

export type TunerStatus = 'flat' | 'in-tune' | 'sharp';

export interface TunerTargetString {
  stringNumber: number;
  label: string;
  midi: number;
  frequencyHz: number;
}

export interface AutocorrelationResult {
  frequencyHz: number;
  clarity: number;
  rms: number;
}

export interface TunerPitchReading {
  frequencyHz: number;
  clarity: number;
  rms: number;
  nearestMidi: number;
  noteLabel: string;
  centsOff: number;
  status: TunerStatus;
  matchedString: (TunerTargetString & { centsFromTarget: number }) | null;
}

export interface AutocorrelationOptions {
  minFreqHz?: number;
  maxFreqHz?: number;
  rmsThreshold?: number;
  clarityThreshold?: number;
}

export function midiToFrequency(midi: number, a4Hz = DEFAULT_A4_HZ): number {
  const safeA4 = Number.isFinite(a4Hz) && a4Hz > 0 ? a4Hz : DEFAULT_A4_HZ;
  return safeA4 * Math.pow(2, (midi - 69) / 12);
}

export function frequencyToMidiFloat(
  freqHz: number,
  a4Hz = DEFAULT_A4_HZ
): number {
  const safeA4 = Number.isFinite(a4Hz) && a4Hz > 0 ? a4Hz : DEFAULT_A4_HZ;
  return 69 + 12 * Math.log2(freqHz / safeA4);
}

export function buildTargetStringsFromTuning(
  openStringMidis: readonly number[],
  stringLabels: readonly string[],
  capo = 0,
  a4Hz = DEFAULT_A4_HZ
): TunerTargetString[] {
  const safeCapo = Number.isFinite(capo)
    ? Math.max(0, Math.min(12, Math.round(capo)))
    : 0;
  return openStringMidis.map((openMidi, idx) => {
    const effectiveMidi = openMidi + safeCapo;
    const baseLabel = stringLabels[idx] ?? midiToNoteLabel(effectiveMidi);
    const label = safeCapo > 0 ? midiToNoteLabel(effectiveMidi) : baseLabel;
    return {
      stringNumber: idx + 1,
      label,
      midi: effectiveMidi,
      frequencyHz: midiToFrequency(effectiveMidi, a4Hz),
    };
  });
}

/**
 * 纯 TypeScript 时域归一化自相关音高检测算法（带抛物线插值与八度倍频抑制）。
 */
export function detectPitchAutocorrelation(
  samples: Float32Array,
  sampleRate: number,
  options?: AutocorrelationOptions
): AutocorrelationResult | null {
  if (!(samples instanceof Float32Array) || samples.length < 64) {
    return null;
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    return null;
  }

  const minFreqHz = options?.minFreqHz ?? 27.5;
  const maxFreqHz = options?.maxFreqHz ?? 1400;
  const rmsThreshold = options?.rmsThreshold ?? 0.01;
  const clarityThreshold = options?.clarityThreshold ?? 0.65;

  const n = samples.length;
  let mean = 0;
  for (let i = 0; i < n; i += 1) {
    mean += samples[i]!;
  }
  mean /= n;

  const centered = new Float32Array(n);
  let sumSq = 0;
  for (let i = 0; i < n; i += 1) {
    const v = samples[i]! - mean;
    centered[i] = v;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / n);
  if (!Number.isFinite(rms) || rms < rmsThreshold) {
    return null;
  }

  const minLag = Math.max(2, Math.floor(sampleRate / maxFreqHz));
  const maxLag = Math.min(
    Math.floor(n / 2),
    Math.ceil(sampleRate / minFreqHz)
  );
  if (maxLag <= minLag + 2) {
    return null;
  }

  const corr = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let num = 0;
    let energyA = 0;
    let energyB = 0;
    const limit = n - lag;
    for (let i = 0; i < limit; i += 1) {
      const a = centered[i]!;
      const b = centered[i + lag]!;
      num += a * b;
      energyA += a * a;
      energyB += b * b;
    }
    const denom = Math.sqrt(energyA * energyB);
    corr[lag] = denom > 1e-12 ? num / denom : 0;
  }

  const peaks: Array<{ lag: number; value: number }> = [];
  let globalMax = -1;
  for (let lag = minLag + 1; lag < maxLag; lag += 1) {
    const prev = corr[lag - 1]!;
    const curr = corr[lag]!;
    const next = corr[lag + 1]!;
    if (curr > 0 && curr >= prev && curr >= next) {
      peaks.push({ lag, value: curr });
      if (curr > globalMax) {
        globalMax = curr;
      }
    }
  }

  if (peaks.length === 0 || globalMax < clarityThreshold) {
    return null;
  }

  const threshold = globalMax * 0.9;
  const chosen = peaks.find((p) => p.value >= threshold) ?? peaks[0]!;
  const bestLag = chosen.lag;

  const y0 = corr[bestLag - 1]!;
  const y1 = corr[bestLag]!;
  const y2 = corr[bestLag + 1]!;
  const denom = y0 - 2 * y1 + y2;
  let shift = Math.abs(denom) > 1e-9 ? (0.5 * (y0 - y2)) / denom : 0;
  if (shift < -0.5) shift = -0.5;
  if (shift > 0.5) shift = 0.5;

  const refinedLag = bestLag + shift;
  if (refinedLag <= 0) {
    return null;
  }

  const frequencyHz = sampleRate / refinedLag;
  if (!Number.isFinite(frequencyHz) || frequencyHz < minFreqHz || frequencyHz > maxFreqHz) {
    return null;
  }

  return {
    frequencyHz,
    clarity: globalMax,
    rms,
  };
}

export function analyzeTunerReading(
  detected: AutocorrelationResult,
  targetStrings: readonly TunerTargetString[],
  options?: { a4Hz?: number; lockedStringNumber?: number | null }
): TunerPitchReading {
  const a4Hz = options?.a4Hz ?? DEFAULT_A4_HZ;
  const midiFloat = frequencyToMidiFloat(detected.frequencyHz, a4Hz);
  const nearestMidi = Math.round(midiFloat);
  const centsOff = Math.round((midiFloat - nearestMidi) * 100);
  const clampedCents = Math.max(-50, Math.min(50, centsOff));

  let matchedString: TunerPitchReading['matchedString'] = null;
  if (targetStrings.length > 0) {
    const locked =
      options?.lockedStringNumber !== undefined &&
      options.lockedStringNumber !== null
        ? targetStrings.find((s) => s.stringNumber === options.lockedStringNumber)
        : undefined;

    let target = locked;
    if (!target) {
      let bestDist = Number.POSITIVE_INFINITY;
      for (const candidate of targetStrings) {
        const dist = Math.abs(midiFloat - candidate.midi);
        if (dist < bestDist) {
          bestDist = dist;
          target = candidate;
        }
      }
    }

    if (target) {
      matchedString = {
        ...target,
        centsFromTarget: Math.round((midiFloat - target.midi) * 100),
      };
    }
  }

  const isLocked =
    options?.lockedStringNumber !== undefined &&
    options?.lockedStringNumber !== null;
  const basisCents =
    matchedString &&
    (isLocked || Math.abs(midiFloat - matchedString.midi) <= 1.5)
      ? matchedString.centsFromTarget
      : clampedCents;
  const status: TunerStatus =
    Math.abs(basisCents) <= 5
      ? 'in-tune'
      : basisCents < -5
        ? 'flat'
        : 'sharp';

  return {
    frequencyHz: detected.frequencyHz,
    clarity: detected.clarity,
    rms: detected.rms,
    nearestMidi,
    noteLabel: midiToNoteLabel(nearestMidi),
    centsOff: clampedCents,
    status,
    matchedString,
  };
}
