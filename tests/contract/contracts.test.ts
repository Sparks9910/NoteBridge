import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deserializeScoreDocument,
  serializeScoreDocument,
  validateScoreDocument,
} from '../../src/domain/serializer.ts';
import { transitionPlaybackState } from '../../src/domain/state-machines.ts';
import {
  PPQ,
  type AppError,
  type ErrorCode,
  type ScoreDocument,
} from '../../src/domain/types.ts';
import { msToSeconds } from '../../src/infrastructure/audio-engine.ts';

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ALLOWED_ERROR_CODES: ReadonlySet<ErrorCode> = new Set([
  'CONFIG_INVALID',
  'STATE_INVALID_TRANSITION',
  'SCORE_INVALID_KEY_SIGNATURE',
  'SCORE_INVALID_TIME_SIGNATURE',
  'SCORE_INVALID_BPM',
  'SCORE_INVALID_DURATION',
  'SCORE_MEASURE_NOT_FOUND',
  'AUDIO_CONTEXT_BLOCKED',
  'AUDIO_SOUNDFONT_LOAD_FAILED',
  'STORAGE_QUOTA_EXCEEDED',
  'STORAGE_SCHEMA_CORRUPTED',
  'AUTH_UNAUTHORIZED',
  'AUTH_FORBIDDEN',
  'RESOURCE_NOT_FOUND',
]);

function assertChineseAppError(error: AppError): void {
  expect(ALLOWED_ERROR_CODES.has(error.code)).toBe(true);
  expect(error.request_id).toMatch(UUID_V4_RE);
  expect(error.detail.trim().length).toBeGreaterThan(0);
  expect(/[\u4e00-\u9fa5]/.test(error.detail)).toBe(true);
  expect(error.detail).not.toMatch(
    /Error:|TypeError|SyntaxError|at\s+\w+\s*\(|stack/i
  );
}

function makeValidDoc(): ScoreDocument {
  return {
    schemaVersion: 1,
    id: 'contract-doc-1',
    title: '契约测试曲谱',
    keySignature: 'G',
    timeSignature: '3/4',
    bpm: 90,
    viewMode: 'dual',
    updatedAtEpochMs: 1730000000000,
    measures: [
      {
        id: 'm1',
        index: 0,
        notes: [
          {
            id: 'n1',
            isRest: false,
            degree: 1,
            octaveOffset: 0,
            accidental: null,
            baseDuration: 'quarter',
            dotted: false,
            durationTicks: 480,
          },
          {
            id: 'n2',
            isRest: true,
            degree: 0,
            octaveOffset: 0,
            accidental: null,
            baseDuration: 'half',
            dotted: false,
            durationTicks: 960,
          },
        ],
      },
    ],
  };
}

describe('L3 契约测试 - ScoreDocument Schema / AppError / 单位 / 依赖边界', () => {
  it('ScoreDocument 序列化与反序列化严格保持契约字段往返一致', () => {
    const doc = makeValidDoc();
    const sRes = serializeScoreDocument(doc);
    expect(sRes.ok).toBe(true);
    if (!sRes.ok) {
      return;
    }

    const dRes = deserializeScoreDocument(sRes.value);
    expect(dRes.ok).toBe(true);
    if (dRes.ok) {
      expect(dRes.value).toEqual(doc);
    }
  });

  it('非法字段与损坏数据精确返回约定 ErrorCode 与中文 AppError', () => {
    const base = makeValidDoc();

    const invalidKey = validateScoreDocument({ ...base, keySignature: 'H#' });
    expect(invalidKey.ok).toBe(false);
    if (!invalidKey.ok) {
      expect(invalidKey.error.code).toBe('SCORE_INVALID_KEY_SIGNATURE');
      assertChineseAppError(invalidKey.error);
    }

    const invalidTime = validateScoreDocument({ ...base, timeSignature: '5/4' });
    expect(invalidTime.ok).toBe(false);
    if (!invalidTime.ok) {
      expect(invalidTime.error.code).toBe('SCORE_INVALID_TIME_SIGNATURE');
      assertChineseAppError(invalidTime.error);
    }

    const invalidBpm = validateScoreDocument({ ...base, bpm: 240 });
    expect(invalidBpm.ok).toBe(false);
    if (!invalidBpm.ok) {
      expect(invalidBpm.error.code).toBe('SCORE_INVALID_BPM');
      assertChineseAppError(invalidBpm.error);
    }

    const badTicks = structuredClone(base);
    if (badTicks.measures[0]?.notes[0]) {
      badTicks.measures[0].notes[0].durationTicks = 999;
    }
    const invalidDuration = validateScoreDocument(badTicks);
    expect(invalidDuration.ok).toBe(false);
    if (!invalidDuration.ok) {
      expect(invalidDuration.error.code).toBe('SCORE_INVALID_DURATION');
      assertChineseAppError(invalidDuration.error);
    }

    const badSchema = validateScoreDocument({ ...base, schemaVersion: 2 });
    expect(badSchema.ok).toBe(false);
    if (!badSchema.ok) {
      expect(badSchema.error.code).toBe('STORAGE_SCHEMA_CORRUPTED');
      assertChineseAppError(badSchema.error);
    }

    const badJson = deserializeScoreDocument('{not valid json');
    expect(badJson.ok).toBe(false);
    if (!badJson.ok) {
      expect(badJson.error.code).toBe('STORAGE_SCHEMA_CORRUPTED');
      assertChineseAppError(badJson.error);
    }

    const badTransition = transitionPlaybackState('IDLE', 'PAUSE');
    expect(badTransition.ok).toBe(false);
    if (!badTransition.ok) {
      assertChineseAppError(badTransition.error);
    }
  });

  it('时间单位契约：PPQ=480 且毫秒与秒换算精确', () => {
    expect(PPQ).toBe(480);
    expect(Number.isInteger(PPQ)).toBe(true);
    expect(msToSeconds(250)).toBe(0.25);
    expect(msToSeconds(0)).toBe(0);
  });

  it('架构底线：src/domain 100% 纯 TypeScript，零外部框架或浏览器全局对象依赖', () => {
    const domainDir = resolve(import.meta.dirname, '../../src/domain');
    const files = readdirSync(domainDir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(6);

    const forbiddenImports =
      /from\s+['"](?:react|vexflow|tone|smplr|\.\.\/(?:ui|rendering|application|infrastructure))/;
    const forbiddenGlobals =
      /\b(?:window|document|localStorage|AudioContext|requestAnimationFrame)\b/;

    for (const file of files) {
      const content = readFileSync(resolve(domainDir, file), 'utf8');
      expect(content).not.toMatch(forbiddenImports);
      expect(content).not.toMatch(forbiddenGlobals);
    }
  });
});
