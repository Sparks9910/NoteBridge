import { createAppError } from '../domain/state-machines.ts';
import type { Result, ScoreDocument } from '../domain/types.ts';
import {
  migrateV1ToV2,
  validateScoreDocumentV2,
} from '../domain/v2-serializer.ts';
import type {
  LibraryScoreEntry,
  ReferenceAttachment,
  ScoreDocumentV2,
} from '../domain/v2-types.ts';
import { appConfig } from './config.ts';
import type { StorageAdapter } from './storage-adapter.ts';

/** 原谱对照本地附件实体 */
export interface StoredReferenceFile {
  meta: ReferenceAttachment;
  data: Uint8Array;
}

/**
 * 乐谱库持久化仓库统一异步契约。
 * 默认由浏览器 IndexedDB 实现，未来可无缝替换为可选本机伴生服务适配器。
 */
export interface ScoreLibraryRepository {
  init(): Promise<Result<void>>;
  listScores(): Promise<Result<LibraryScoreEntry[]>>;
  getScore(id: string): Promise<Result<ScoreDocumentV2>>;
  saveScore(
    doc: ScoreDocumentV2,
    thumbnailSvg?: string
  ): Promise<Result<LibraryScoreEntry>>;
  deleteScore(id: string): Promise<Result<void>>;
  duplicateScore(
    id: string,
    newId: string,
    nowMs: number
  ): Promise<Result<ScoreDocumentV2>>;
  exportAllScores(): Promise<Result<ScoreDocumentV2[]>>;
  importScores(docs: ScoreDocumentV2[]): Promise<Result<number>>;
  estimateUsageBytes(): Promise<number>;
  saveReferenceAttachment?(
    attachment: StoredReferenceFile
  ): Promise<Result<ReferenceAttachment>>;
  getReferenceAttachment?(id: string): Promise<Result<StoredReferenceFile>>;
  deleteReferenceAttachment?(id: string): Promise<Result<void>>;
}

interface StoredRecord {
  id: string;
  doc: ScoreDocumentV2;
  entry: LibraryScoreEntry;
  byteLength: number;
}

function buildEntryFromDoc(
  doc: ScoreDocumentV2,
  thumbnailSvg = ''
): LibraryScoreEntry {
  const mainTrack = doc.tracks[0];
  const measureCount = mainTrack?.voices[0]?.measures.length ?? 0;
  return {
    id: doc.id,
    title: doc.title,
    subtitle: doc.subtitle,
    composer: doc.composer,
    keySignature: doc.keySignature,
    timeSignature: doc.timeSignature,
    bpm: doc.bpm,
    measureCount,
    instrumentId: mainTrack?.instrumentId ?? 'piano',
    thumbnailSvg,
    updatedAtEpochMs: doc.updatedAtEpochMs,
  };
}

function estimateJsonBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return new TextEncoder().encode(json).byteLength;
  } catch {
    return 0;
  }
}

function cloneV2<T>(value: T): T {
  return structuredClone(value);
}

/**
 * 内存乐谱库仓库实现（用于无 IndexedDB 环境降级及 L2 服务单元测试）。
 */
export class InMemoryLibraryRepository implements ScoreLibraryRepository {
  private readonly records = new Map<string, StoredRecord>();
  private readonly references = new Map<string, StoredReferenceFile>();

  public async init(): Promise<Result<void>> {
    return { ok: true, value: undefined };
  }

  public async listScores(): Promise<Result<LibraryScoreEntry[]>> {
    const list = Array.from(this.records.values())
      .map((r) => cloneV2(r.entry))
      .sort((a, b) => b.updatedAtEpochMs - a.updatedAtEpochMs);
    return { ok: true, value: list };
  }

  public async getScore(id: string): Promise<Result<ScoreDocumentV2>> {
    const record = this.records.get(id);
    if (!record) {
      return {
        ok: false,
        error: createAppError('RESOURCE_NOT_FOUND', '未在乐谱库中找到指定曲谱', 'id'),
      };
    }
    return { ok: true, value: cloneV2(record.doc) };
  }

  public async saveScore(
    doc: ScoreDocumentV2,
    thumbnailSvg?: string
  ): Promise<Result<LibraryScoreEntry>> {
    const validated = validateScoreDocumentV2(doc);
    if (!validated.ok) {
      return validated;
    }
    const existing = this.records.get(validated.value.id);
    const svg = thumbnailSvg ?? existing?.entry.thumbnailSvg ?? '';
    const entry = buildEntryFromDoc(validated.value, svg);
    const clonedDoc = cloneV2(validated.value);
    const byteLength = estimateJsonBytes({ doc: clonedDoc, entry });
    this.records.set(validated.value.id, {
      id: validated.value.id,
      doc: clonedDoc,
      entry: cloneV2(entry),
      byteLength,
    });
    return { ok: true, value: cloneV2(entry) };
  }

  public async deleteScore(id: string): Promise<Result<void>> {
    const existing = this.records.get(id);
    if (existing?.doc.referenceSource?.id) {
      this.references.delete(existing.doc.referenceSource.id);
    }
    this.records.delete(id);
    return { ok: true, value: undefined };
  }

  public async duplicateScore(
    id: string,
    newId: string,
    nowMs: number
  ): Promise<Result<ScoreDocumentV2>> {
    const existing = this.records.get(id);
    if (!existing) {
      return {
        ok: false,
        error: createAppError('RESOURCE_NOT_FOUND', '未找到要复制的曲谱', 'id'),
      };
    }
    const duplicated: ScoreDocumentV2 = {
      ...cloneV2(existing.doc),
      id: newId,
      title: `${existing.doc.title}（副本）`,
      updatedAtEpochMs: Math.trunc(nowMs),
    };
    const saveRes = await this.saveScore(duplicated, existing.entry.thumbnailSvg);
    if (!saveRes.ok) {
      return saveRes;
    }
    return { ok: true, value: duplicated };
  }

  public async exportAllScores(): Promise<Result<ScoreDocumentV2[]>> {
    const docs = Array.from(this.records.values())
      .sort((a, b) => b.entry.updatedAtEpochMs - a.entry.updatedAtEpochMs)
      .map((r) => cloneV2(r.doc));
    return { ok: true, value: docs };
  }

  public async importScores(docs: ScoreDocumentV2[]): Promise<Result<number>> {
    let imported = 0;
    for (const doc of docs) {
      const res = await this.saveScore(doc);
      if (!res.ok) {
        return res;
      }
      imported += 1;
    }
    return { ok: true, value: imported };
  }

  public async estimateUsageBytes(): Promise<number> {
    let total = 0;
    for (const r of this.records.values()) {
      total += r.byteLength;
    }
    for (const ref of this.references.values()) {
      total += ref.data.byteLength;
    }
    return total;
  }

  public async saveReferenceAttachment(
    attachment: StoredReferenceFile
  ): Promise<Result<ReferenceAttachment>> {
    const clonedData = new Uint8Array(attachment.data);
    const meta: ReferenceAttachment = {
      ...attachment.meta,
      sizeBytes: clonedData.byteLength,
    };
    this.references.set(meta.id, { meta, data: clonedData });
    return { ok: true, value: { ...meta } };
  }

  public async getReferenceAttachment(
    id: string
  ): Promise<Result<StoredReferenceFile>> {
    const found = this.references.get(id);
    if (!found) {
      return {
        ok: false,
        error: createAppError('RESOURCE_NOT_FOUND', '未找到关联的原谱对照附件', 'id'),
      };
    }
    return {
      ok: true,
      value: {
        meta: { ...found.meta },
        data: new Uint8Array(found.data),
      },
    };
  }

  public async deleteReferenceAttachment(id: string): Promise<Result<void>> {
    this.references.delete(id);
    return { ok: true, value: undefined };
  }
}

const STORE_NAME = 'scores';
const REF_STORE_NAME = 'references';

interface StoredReferenceRecord {
  id: string;
  meta: ReferenceAttachment;
  data: ArrayBuffer;
}

function isIdbQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const maybe = err as { name?: unknown };
  return maybe.name === 'QuotaExceededError';
}

/**
 * 浏览器原生 IndexedDB 乐谱库实现。
 */
export class IndexedDbLibraryRepository implements ScoreLibraryRepository {
  private readonly dbName: string;
  private db: IDBDatabase | null = null;
  private initPromise: Promise<Result<void>> | null = null;

  constructor(namespace = appConfig.storageNamespace) {
    this.dbName = `${namespace}_v2_library`;
  }

  public async init(): Promise<Result<void>> {
    if (this.db) {
      return { ok: true, value: undefined };
    }
    if (this.initPromise) {
      return this.initPromise;
    }
    if (typeof globalThis === 'undefined' || !globalThis.indexedDB) {
      return {
        ok: false,
        error: createAppError(
          'STORAGE_QUOTA_EXCEEDED',
          '当前浏览器环境不支持 IndexedDB 本地乐谱库'
        ),
      };
    }

    this.initPromise = new Promise<Result<void>>((resolve) => {
      try {
        const request = globalThis.indexedDB.open(this.dbName, 2);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(REF_STORE_NAME)) {
            db.createObjectStore(REF_STORE_NAME, { keyPath: 'id' });
          }
        };
        request.onsuccess = () => {
          this.db = request.result;
          this.db.onversionchange = () => {
            this.db?.close();
            this.db = null;
          };
          resolve({ ok: true, value: undefined });
        };
        request.onerror = () => {
          this.initPromise = null;
          resolve({
            ok: false,
            error: createAppError(
              'STORAGE_QUOTA_EXCEEDED',
              '打开本地 IndexedDB 乐谱库失败，请检查浏览器存储权限'
            ),
          });
        };
        request.onblocked = () => {
          this.initPromise = null;
          resolve({
            ok: false,
            error: createAppError(
              'STORAGE_QUOTA_EXCEEDED',
              '本地乐谱库正被其他标签页占用，请稍后重试'
            ),
          });
        };
      } catch {
        this.initPromise = null;
        resolve({
          ok: false,
          error: createAppError(
            'STORAGE_QUOTA_EXCEEDED',
            '初始化本地 IndexedDB 乐谱库时发生异常'
          ),
        });
      }
    });

    return this.initPromise;
  }

  private async ensureDb(): Promise<Result<IDBDatabase>> {
    const initRes = await this.init();
    if (!initRes.ok) {
      return initRes;
    }
    if (!this.db) {
      return {
        ok: false,
        error: createAppError(
          'STORAGE_QUOTA_EXCEEDED',
          '本地乐谱库连接不可用，请刷新页面重试'
        ),
      };
    }
    return { ok: true, value: this.db };
  }

  private runTransaction<T>(
    mode: IDBTransactionMode,
    executor: (store: IDBObjectStore) => IDBRequest<T>,
    storeName: string = STORE_NAME
  ): Promise<Result<T>> {
    return this.ensureDb().then((dbRes) => {
      if (!dbRes.ok) {
        return dbRes;
      }
      return new Promise<Result<T>>((resolve) => {
        try {
          const tx = dbRes.value.transaction(storeName, mode);
          const store = tx.objectStore(storeName);
          const req = executor(store);
          req.onsuccess = () => {
            resolve({ ok: true, value: req.result });
          };
          req.onerror = () => {
            if (isIdbQuotaError(req.error)) {
              resolve({
                ok: false,
                error: createAppError(
                  'STORAGE_QUOTA_EXCEEDED',
                  '本地乐谱库存储空间已满，请导出备份并清理旧曲谱'
                ),
              });
              return;
            }
            resolve({
              ok: false,
              error: createAppError(
                'STORAGE_SCHEMA_CORRUPTED',
                '读写本地乐谱库数据时发生存储错误'
              ),
            });
          };
        } catch (err) {
          if (isIdbQuotaError(err)) {
            resolve({
              ok: false,
              error: createAppError(
                'STORAGE_QUOTA_EXCEEDED',
                '本地乐谱库存储空间已满，请导出备份并清理旧曲谱'
              ),
            });
            return;
          }
          resolve({
            ok: false,
            error: createAppError(
              'STORAGE_SCHEMA_CORRUPTED',
              '本地乐谱库事务执行失败'
            ),
          });
        }
      });
    });
  }

  public async listScores(): Promise<Result<LibraryScoreEntry[]>> {
    const res = await this.runTransaction<StoredRecord[]>('readonly', (store) =>
      store.getAll() as IDBRequest<StoredRecord[]>
    );
    if (!res.ok) {
      return res;
    }
    const entries = res.value
      .filter((r): r is StoredRecord => Boolean(r && r.entry && r.doc))
      .map((r) => r.entry)
      .sort((a, b) => b.updatedAtEpochMs - a.updatedAtEpochMs);
    return { ok: true, value: entries };
  }

  public async getScore(id: string): Promise<Result<ScoreDocumentV2>> {
    const res = await this.runTransaction<StoredRecord | undefined>(
      'readonly',
      (store) => store.get(id) as IDBRequest<StoredRecord | undefined>
    );
    if (!res.ok) {
      return res;
    }
    if (!res.value || !res.value.doc) {
      return {
        ok: false,
        error: createAppError('RESOURCE_NOT_FOUND', '未在乐谱库中找到指定曲谱', 'id'),
      };
    }
    return validateScoreDocumentV2(res.value.doc);
  }

  public async saveScore(
    doc: ScoreDocumentV2,
    thumbnailSvg?: string
  ): Promise<Result<LibraryScoreEntry>> {
    const validated = validateScoreDocumentV2(doc);
    if (!validated.ok) {
      return validated;
    }

    let svg = thumbnailSvg ?? '';
    if (thumbnailSvg === undefined) {
      const existing = await this.runTransaction<StoredRecord | undefined>(
        'readonly',
        (store) =>
          store.get(validated.value.id) as IDBRequest<StoredRecord | undefined>
      );
      if (existing.ok && existing.value?.entry) {
        svg = existing.value.entry.thumbnailSvg;
      }
    }

    const entry = buildEntryFromDoc(validated.value, svg);
    const record: StoredRecord = {
      id: validated.value.id,
      doc: validated.value,
      entry,
      byteLength: estimateJsonBytes({ doc: validated.value, entry }),
    };

    const putRes = await this.runTransaction<IDBValidKey>('readwrite', (store) =>
      store.put(record)
    );
    if (!putRes.ok) {
      return putRes;
    }
    return { ok: true, value: entry };
  }

  public async deleteScore(id: string): Promise<Result<void>> {
    const existing = await this.getScore(id);
    if (existing.ok && existing.value.referenceSource?.id) {
      await this.deleteReferenceAttachment(existing.value.referenceSource.id);
    }
    const res = await this.runTransaction<undefined>('readwrite', (store) =>
      store.delete(id) as IDBRequest<undefined>
    );
    if (!res.ok) {
      return res;
    }
    return { ok: true, value: undefined };
  }

  public async duplicateScore(
    id: string,
    newId: string,
    nowMs: number
  ): Promise<Result<ScoreDocumentV2>> {
    const existing = await this.runTransaction<StoredRecord | undefined>(
      'readonly',
      (store) => store.get(id) as IDBRequest<StoredRecord | undefined>
    );
    if (!existing.ok) {
      return existing;
    }
    if (!existing.value || !existing.value.doc) {
      return {
        ok: false,
        error: createAppError('RESOURCE_NOT_FOUND', '未找到要复制的曲谱', 'id'),
      };
    }
    const duplicated: ScoreDocumentV2 = {
      ...cloneV2(existing.value.doc),
      id: newId,
      title: `${existing.value.doc.title}（副本）`,
      updatedAtEpochMs: Math.trunc(nowMs),
    };
    const saveRes = await this.saveScore(
      duplicated,
      existing.value.entry.thumbnailSvg
    );
    if (!saveRes.ok) {
      return saveRes;
    }
    return { ok: true, value: duplicated };
  }

  public async exportAllScores(): Promise<Result<ScoreDocumentV2[]>> {
    const res = await this.runTransaction<StoredRecord[]>('readonly', (store) =>
      store.getAll() as IDBRequest<StoredRecord[]>
    );
    if (!res.ok) {
      return res;
    }
    const validDocs: ScoreDocumentV2[] = [];
    const sorted = res.value
      .filter((r): r is StoredRecord => Boolean(r && r.doc && r.entry))
      .sort((a, b) => b.entry.updatedAtEpochMs - a.entry.updatedAtEpochMs);
    for (const r of sorted) {
      const v = validateScoreDocumentV2(r.doc);
      if (v.ok) {
        validDocs.push(v.value);
      }
    }
    return { ok: true, value: validDocs };
  }

  public async importScores(docs: ScoreDocumentV2[]): Promise<Result<number>> {
    let imported = 0;
    for (const doc of docs) {
      const saveRes = await this.saveScore(doc);
      if (!saveRes.ok) {
        return saveRes;
      }
      imported += 1;
    }
    return { ok: true, value: imported };
  }

  public async estimateUsageBytes(): Promise<number> {
    const res = await this.runTransaction<StoredRecord[]>('readonly', (store) =>
      store.getAll() as IDBRequest<StoredRecord[]>
    );
    let total = 0;
    if (res.ok) {
      for (const r of res.value) {
        total += r?.byteLength ?? 0;
      }
    }
    const refRes = await this.runTransaction<StoredReferenceRecord[]>(
      'readonly',
      (store) => store.getAll() as IDBRequest<StoredReferenceRecord[]>,
      REF_STORE_NAME
    );
    if (refRes.ok) {
      for (const rf of refRes.value) {
        total += rf?.meta?.sizeBytes ?? 0;
      }
    }
    return total;
  }

  public async saveReferenceAttachment(
    attachment: StoredReferenceFile
  ): Promise<Result<ReferenceAttachment>> {
    const copied = new Uint8Array(attachment.data);
    const meta: ReferenceAttachment = {
      ...attachment.meta,
      sizeBytes: copied.byteLength,
    };
    const record: StoredReferenceRecord = {
      id: meta.id,
      meta,
      data: copied.buffer,
    };
    const res = await this.runTransaction<IDBValidKey>(
      'readwrite',
      (store) => store.put(record),
      REF_STORE_NAME
    );
    if (!res.ok) {
      return res;
    }
    return { ok: true, value: { ...meta } };
  }

  public async getReferenceAttachment(
    id: string
  ): Promise<Result<StoredReferenceFile>> {
    const res = await this.runTransaction<StoredReferenceRecord | undefined>(
      'readonly',
      (store) => store.get(id) as IDBRequest<StoredReferenceRecord | undefined>,
      REF_STORE_NAME
    );
    if (!res.ok) {
      return res;
    }
    if (!res.value || !res.value.meta) {
      return {
        ok: false,
        error: createAppError('RESOURCE_NOT_FOUND', '未在本地仓库找到原谱对照附件', 'id'),
      };
    }
    return {
      ok: true,
      value: {
        meta: { ...res.value.meta },
        data: new Uint8Array(res.value.data),
      },
    };
  }

  public async deleteReferenceAttachment(id: string): Promise<Result<void>> {
    const res = await this.runTransaction<undefined>(
      'readwrite',
      (store) => store.delete(id) as IDBRequest<undefined>,
      REF_STORE_NAME
    );
    if (!res.ok) {
      return res;
    }
    return { ok: true, value: undefined };
  }
}

export function createLibraryRepository(options?: {
  namespace?: string;
  forceInMemory?: boolean;
}): ScoreLibraryRepository {
  if (
    options?.forceInMemory ||
    typeof globalThis === 'undefined' ||
    !globalThis.indexedDB
  ) {
    return new InMemoryLibraryRepository();
  }
  return new IndexedDbLibraryRepository(options?.namespace);
}

/**
 * 幂等扫描 P0 localStorage 中的既有曲谱并无损迁入 V2 乐谱库。
 * 不会修改或删除旧 localStorage 数据。
 */
export async function migrateLegacyLocalStorageToLibrary(
  legacyAdapter: StorageAdapter,
  repo: ScoreLibraryRepository,
  thumbnailBuilder?: (doc: ScoreDocument) => string
): Promise<Result<number>> {
  const initRes = await repo.init();
  if (!initRes.ok) {
    return initRes;
  }

  const legacyListRes = legacyAdapter.listScores();
  if (!legacyListRes.ok) {
    return { ok: true, value: 0 };
  }
  if (legacyListRes.value.length === 0) {
    return { ok: true, value: 0 };
  }

  const repoListRes = await repo.listScores();
  if (!repoListRes.ok) {
    return repoListRes;
  }
  const existingIds = new Set(repoListRes.value.map((item) => item.id));

  let migratedCount = 0;
  for (const summary of legacyListRes.value) {
    if (existingIds.has(summary.id)) {
      continue;
    }
    const loaded = legacyAdapter.loadScore(summary.id);
    if (!loaded.ok) {
      continue;
    }
    const v2Doc = migrateV1ToV2(loaded.value);
    const thumb = thumbnailBuilder ? thumbnailBuilder(loaded.value) : '';
    const saveRes = await repo.saveScore(v2Doc, thumb);
    if (saveRes.ok) {
      migratedCount += 1;
      existingIds.add(summary.id);
    }
  }

  return { ok: true, value: migratedCount };
}
