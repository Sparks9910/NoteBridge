import type { AppError } from '../domain/types.ts';

export type AppEnv = 'development' | 'test' | 'production';

export interface AppConfig {
  appEnv: AppEnv;
  enableDemoMode: boolean;
  defaultBpm: number;
  audioLookaheadMs: number;
  storageNamespace: string;
}

export type RawEnv = Record<string, string | boolean | undefined>;

const VALID_APP_ENVS: readonly AppEnv[] = ['development', 'test', 'production'];

function createRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return '00000000-0000-4000-8000-000000000000';
}

export class ConfigError extends Error {
  public readonly appError: AppError;

  constructor(detail: string, field?: string) {
    super(`[CONFIG_INVALID] ${detail}`);
    this.name = 'ConfigError';
    this.appError = {
      detail,
      code: 'CONFIG_INVALID',
      request_id: createRequestId(),
      ...(field ? { field } : {}),
    };
  }
}

function parseStrictIntInRange(
  raw: string | boolean | undefined,
  defaultStr: string,
  min: number,
  max: number,
  field: string,
  label: string
): number {
  const value = raw === undefined ? defaultStr : String(raw);
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`${label}必须为 ${min} 到 ${max} 之间的整数`, field);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${label}超出允许范围（${min}..${max}）`, field);
  }
  return parsed;
}

function parseAppEnv(raw: string | boolean | undefined): AppEnv {
  const value = raw === undefined ? 'development' : String(raw);
  if (!VALID_APP_ENVS.includes(value as AppEnv)) {
    throw new ConfigError(
      '运行环境标识 VITE_APP_ENV 仅允许 development、test 或 production',
      'VITE_APP_ENV'
    );
  }
  return value as AppEnv;
}

function parseEnableDemoMode(raw: string | boolean | undefined): boolean {
  if (raw === undefined) {
    return false;
  }
  const value = String(raw);
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new ConfigError(
    '演示模式开关 VITE_ENABLE_DEMO_MODE 仅允许 true 或 false',
    'VITE_ENABLE_DEMO_MODE'
  );
}

function parseStorageNamespace(raw: string | boolean | undefined): string {
  const value = raw === undefined ? 'notebridge_v1' : String(raw);
  if (value.trim().length === 0) {
    throw new ConfigError(
      '本地存储命名空间 VITE_STORAGE_NAMESPACE 不能为空字符串',
      'VITE_STORAGE_NAMESPACE'
    );
  }
  return value;
}

/**
 * 读取并校验运行时环境变量。
 * 生产环境（VITE_APP_ENV === 'production'）与 VITE_ENABLE_DEMO_MODE === 'true' 同时存在时立即抛出 CONFIG_INVALID。
 */
export function loadConfig(env?: RawEnv): AppConfig {
  const sourceEnv: RawEnv =
    env ??
    ((typeof import.meta !== 'undefined' &&
      (import.meta as unknown as { env?: RawEnv }).env) ||
      {});

  const appEnv = parseAppEnv(sourceEnv.VITE_APP_ENV);
  const enableDemoMode = parseEnableDemoMode(sourceEnv.VITE_ENABLE_DEMO_MODE);

  if (appEnv === 'production' && enableDemoMode) {
    throw new ConfigError(
      '生产环境严禁开启演示模式（VITE_ENABLE_DEMO_MODE=true）',
      'VITE_ENABLE_DEMO_MODE'
    );
  }

  const defaultBpm = parseStrictIntInRange(
    sourceEnv.VITE_DEFAULT_BPM,
    '90',
    40,
    200,
    'VITE_DEFAULT_BPM',
    '默认速度 VITE_DEFAULT_BPM'
  );

  const audioLookaheadMs = parseStrictIntInRange(
    sourceEnv.VITE_AUDIO_LOOKAHEAD_MS,
    '100',
    25,
    200,
    'VITE_AUDIO_LOOKAHEAD_MS',
    '音频预调度窗口 VITE_AUDIO_LOOKAHEAD_MS'
  );

  const storageNamespace = parseStorageNamespace(
    sourceEnv.VITE_STORAGE_NAMESPACE
  );

  return {
    appEnv,
    enableDemoMode,
    defaultBpm,
    audioLookaheadMs,
    storageNamespace,
  };
}

/** 启动阶段立即校验当前环境配置 */
export const appConfig: AppConfig = loadConfig();
