import {
  deserializeScoreDocument,
  serializeScoreDocument,
} from '../domain/serializer.ts';
import { createAppError } from '../domain/state-machines.ts';
import type { Result, ScoreDocument } from '../domain/types.ts';
import { appConfig } from './config.ts';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ScoreSummary {
  id: string;
  title: string;
  keySignature: ScoreDocument['keySignature'];
  timeSignature: ScoreDocument['timeSignature'];
  bpm: number;
  updatedAtEpochMs: number;
}

export interface StorageAdapterOptions {
  storage?: StorageLike;
  namespace?: string;
}

function isQuotaExceededError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const maybeDomErr = err as { name?: unknown; code?: unknown };
  return (
    maybeDomErr.name === 'QuotaExceededError' ||
    maybeDomErr.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    maybeDomErr.code === 22 ||
    maybeDomErr.code === 1014
  );
}

/**
 * localStorage 持久化适配器，统一返回 Result<T> 与中文 AppError。
 */
export class StorageAdapter {
  private readonly storage: StorageLike | null;
  private readonly namespace: string;

  constructor(options?: StorageAdapterOptions) {
    this.namespace = options?.namespace ?? appConfig.storageNamespace;
    if (options?.storage) {
      this.storage = options.storage;
    } else if (
      typeof globalThis !== 'undefined' &&
      'localStorage' in globalThis &&
      globalThis.localStorage
    ) {
      this.storage = globalThis.localStorage;
    } else {
      this.storage = null;
    }
  }

  private getIndexKey(): string {
    return `${this.namespace}:index`;
  }

  private getScoreKey(id: string): string {
    return `${this.namespace}:score:${id}`;
  }

  private getLastOpenedKey(): string {
    return `${this.namespace}:last_opened_id`;
  }

  public saveScore(doc: ScoreDocument): Result<ScoreDocument> {
    if (!this.storage) {
      return {
        ok: false,
        error: createAppError(
          'STORAGE_QUOTA_EXCEEDED',
          '当前运行环境不支持本地存储，无法保存乐谱'
        ),
      };
    }

    const serialized = serializeScoreDocument(doc);
    if (!serialized.ok) {
      return serialized;
    }

    try {
      this.storage.setItem(this.getScoreKey(doc.id), serialized.value);
      this.storage.setItem(this.getLastOpenedKey(), doc.id);

      const listRes = this.listScores();
      const currentList = listRes.ok ? listRes.value : [];
      const nextSummary: ScoreSummary = {
        id: doc.id,
        title: doc.title,
        keySignature: doc.keySignature,
        timeSignature: doc.timeSignature,
        bpm: doc.bpm,
        updatedAtEpochMs: doc.updatedAtEpochMs,
      };
      const filtered = currentList.filter((item) => item.id !== doc.id);
      filtered.unshift(nextSummary);
      this.storage.setItem(this.getIndexKey(), JSON.stringify(filtered));

      return { ok: true, value: doc };
    } catch (err) {
      if (isQuotaExceededError(err)) {
        return {
          ok: false,
          error: createAppError(
            'STORAGE_QUOTA_EXCEEDED',
            '本地存储空间已满，请删除旧乐谱或导出备份后重试'
          ),
        };
      }
      return {
        ok: false,
        error: createAppError(
          'STORAGE_QUOTA_EXCEEDED',
          '保存乐谱到本地存储失败，请检查浏览器存储权限'
        ),
      };
    }
  }

  public loadScore(id: string): Result<ScoreDocument> {
    if (!this.storage) {
      return {
        ok: false,
        error: createAppError(
          'RESOURCE_NOT_FOUND',
          '当前运行环境不支持本地存储，未找到指定乐谱'
        ),
      };
    }

    let raw: string | null = null;
    try {
      raw = this.storage.getItem(this.getScoreKey(id));
    } catch {
      return {
        ok: false,
        error: createAppError(
          'STORAGE_SCHEMA_CORRUPTED',
          '读取本地乐谱存储失败，请检查浏览器存储权限'
        ),
      };
    }

    if (raw === null) {
      return {
        ok: false,
        error: createAppError(
          'RESOURCE_NOT_FOUND',
          '未找到指定的本地乐谱工程',
          'id'
        ),
      };
    }

    return deserializeScoreDocument(raw);
  }

  public loadLastOpenedScore(): Result<ScoreDocument | null> {
    if (!this.storage) {
      return { ok: true, value: null };
    }
    try {
      const lastId = this.storage.getItem(this.getLastOpenedKey());
      if (!lastId) {
        return { ok: true, value: null };
      }
      const res = this.loadScore(lastId);
      if (!res.ok && res.error.code === 'RESOURCE_NOT_FOUND') {
        return { ok: true, value: null };
      }
      return res;
    } catch {
      return {
        ok: false,
        error: createAppError(
          'STORAGE_SCHEMA_CORRUPTED',
          '读取最近打开的乐谱记录失败'
        ),
      };
    }
  }

  public listScores(): Result<ScoreSummary[]> {
    if (!this.storage) {
      return { ok: true, value: [] };
    }
    try {
      const raw = this.storage.getItem(this.getIndexKey());
      if (!raw) {
        return { ok: true, value: [] };
      }
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return {
          ok: false,
          error: createAppError(
            'STORAGE_SCHEMA_CORRUPTED',
            '本地乐谱索引列表格式已损坏'
          ),
        };
      }
      const validItems = parsed.filter(
        (item): item is ScoreSummary =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as ScoreSummary).id === 'string' &&
          typeof (item as ScoreSummary).title === 'string'
      );
      return { ok: true, value: validItems };
    } catch {
      return {
        ok: false,
        error: createAppError(
          'STORAGE_SCHEMA_CORRUPTED',
          '本地乐谱索引列表解析失败，存储内容可能已损坏'
        ),
      };
    }
  }

  public deleteScore(id: string): Result<void> {
    if (!this.storage) {
      return { ok: true, value: undefined };
    }
    try {
      this.storage.removeItem(this.getScoreKey(id));
      const lastId = this.storage.getItem(this.getLastOpenedKey());
      if (lastId === id) {
        this.storage.removeItem(this.getLastOpenedKey());
      }
      const listRes = this.listScores();
      if (listRes.ok) {
        const filtered = listRes.value.filter((item) => item.id !== id);
        this.storage.setItem(this.getIndexKey(), JSON.stringify(filtered));
      }
      return { ok: true, value: undefined };
    } catch {
      return {
        ok: false,
        error: createAppError(
          'STORAGE_QUOTA_EXCEEDED',
          '删除本地乐谱工程时发生存储写入异常'
        ),
      };
    }
  }
}

export function createStorageAdapter(
  options?: StorageAdapterOptions
): StorageAdapter {
  return new StorageAdapter(options);
}
