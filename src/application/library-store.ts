import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { createAppError, createRequestId } from '../domain/state-machines.ts';
import type { Result, ScoreDocument } from '../domain/types.ts';
import { parseJianpuTextToScoreV2 } from '../domain/v2-jianpu-text.ts';
import {
  deserializeLibraryBackup,
  projectV2ToV1,
  serializeLibraryBackup,
  serializeScoreDocumentV2,
} from '../domain/v2-serializer.ts';
import type {
  AppError,
  LibraryScoreEntry,
  ReferenceAttachment,
  ScoreDocumentV2,
  ScoreMetadata,
  WorkMode,
} from '../domain/v2-types.ts';
import { importScoreFromFileData } from '../infrastructure/codecs/codec-registry.ts';
import {
  createLibraryRepository,
  migrateLegacyLocalStorageToLibrary,
  type ScoreLibraryRepository,
  type StoredReferenceFile,
} from '../infrastructure/indexeddb-adapter.ts';
import {
  createStorageAdapter,
  type StorageAdapter,
} from '../infrastructure/storage-adapter.ts';
import { buildThumbnailSvg } from '../rendering/export-renderer.ts';
import { inputStore, type InputStoreApi } from './input-store.ts';
import { notationStore, type NotationStoreApi } from './notation-store.ts';
import { scoreStore, type ScoreStoreApi } from './score-store.ts';
import {
  workspaceStore,
  type WorkspaceStoreApi,
} from './workspace-store.ts';

export interface LibraryStoreDeps {
  repository?: ScoreLibraryRepository;
  legacyStorage?: StorageAdapter;
  scoreStore?: ScoreStoreApi;
  workspaceStore?: WorkspaceStoreApi;
  inputStore?: InputStoreApi;
  notationStore?: NotationStoreApi;
  now?: () => number;
  idGenerator?: (prefix: string) => string;
}

const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const ALLOWED_REFERENCE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'application/pdf',
]);

export interface LibraryStoreState {
  entries: LibraryScoreEntry[];
  searchQuery: string;
  isInitialized: boolean;
  isLoading: boolean;
  storageUsageBytes: number;
  lastError: AppError | null;

  initialize: () => Promise<Result<void>>;
  refreshList: () => Promise<Result<LibraryScoreEntry[]>>;
  setSearchQuery: (query: string) => void;
  syncScoreToLibrary: (
    doc: ScoreDocument,
    meta?: ScoreMetadata
  ) => Promise<Result<LibraryScoreEntry>>;
  openScore: (
    id: string,
    targetMode?: WorkMode
  ) => Promise<Result<ScoreDocumentV2>>;
  createAndOpenNewScore: (title?: string) => Promise<Result<ScoreDocument>>;
  duplicateScore: (id: string) => Promise<Result<ScoreDocumentV2>>;
  deleteScore: (id: string) => Promise<Result<void>>;
  exportSingleScoreJson: (
    doc: ScoreDocument,
    meta?: ScoreMetadata
  ) => Result<string>;
  exportAllBackupJson: () => Promise<Result<string>>;
  importBackupJson: (rawText: string) => Promise<Result<number>>;
  importExternalScore: (
    v2Doc: ScoreDocumentV2,
    openImmediately?: boolean
  ) => Promise<Result<ScoreDocumentV2>>;
  importExternalFile: (
    filename: string,
    bytes: Uint8Array,
    openImmediately?: boolean
  ) => Promise<Result<ScoreDocumentV2[]>>;
  importJianpuText: (
    text: string,
    openImmediately?: boolean
  ) => Promise<Result<ScoreDocumentV2>>;
  saveScoreReference: (
    doc: ScoreDocument,
    meta: ScoreMetadata | undefined,
    file: { name: string; mimeType: string; data: Uint8Array }
  ) => Promise<Result<ReferenceAttachment>>;
  loadScoreReference: (id: string) => Promise<Result<StoredReferenceFile>>;
  removeScoreReference: (
    doc: ScoreDocument,
    meta?: ScoreMetadata
  ) => Promise<Result<void>>;
  clearError: () => void;
}

function defaultIdGenerator(prefix: string): string {
  return `${prefix}_${createRequestId().slice(0, 8)}`;
}

export type LibraryStoreApi = StoreApi<LibraryStoreState>;

export function createLibraryStore(deps?: LibraryStoreDeps): LibraryStoreApi {
  const repository = deps?.repository ?? createLibraryRepository();
  const legacyStorage = deps?.legacyStorage ?? createStorageAdapter();
  const targetScoreStore = deps?.scoreStore ?? scoreStore;
  const targetWorkspaceStore = deps?.workspaceStore ?? workspaceStore;
  const targetInputStore = deps?.inputStore ?? inputStore;
  const targetNotationStore = deps?.notationStore ?? notationStore;
  const now = deps?.now ?? (() => Date.now());
  const idGen = deps?.idGenerator ?? defaultIdGenerator;

  let initInFlight: Promise<Result<void>> | null = null;

  return createStore<LibraryStoreState>((set, get) => ({
    entries: [],
    searchQuery: '',
    isInitialized: false,
    isLoading: false,
    storageUsageBytes: 0,
    lastError: null,

    initialize: async () => {
      if (get().isInitialized) {
        return { ok: true, value: undefined };
      }
      if (initInFlight) {
        return initInFlight;
      }

      initInFlight = (async () => {
        set({ isLoading: true, lastError: null });
        const initRes = await repository.init();
        if (!initRes.ok) {
          set({ isLoading: false, lastError: initRes.error });
          initInFlight = null;
          return initRes;
        }

        const migrateRes = await migrateLegacyLocalStorageToLibrary(
          legacyStorage,
          repository,
          (doc) => buildThumbnailSvg(doc)
        );
        if (!migrateRes.ok) {
          set({ isLoading: false, lastError: migrateRes.error });
          initInFlight = null;
          return migrateRes;
        }

        const listRes = await repository.listScores();
        const usageBytes = await repository.estimateUsageBytes();
        if (!listRes.ok) {
          set({ isLoading: false, lastError: listRes.error });
          initInFlight = null;
          return listRes;
        }

        const currentDocId = targetScoreStore.getState().document.id;
        if (targetNotationStore.getState().boundScoreId === null) {
          const currentSaved = await repository.getScore(currentDocId);
          if (currentSaved.ok) {
            targetNotationStore.getState().loadFromV2Document(currentSaved.value);
            targetWorkspaceStore.getState().resetActiveMeta({
              subtitle: currentSaved.value.subtitle,
              composer: currentSaved.value.composer,
              lyricist: currentSaved.value.lyricist,
            });
          } else {
            targetNotationStore.getState().bindScoreId(currentDocId);
          }
        }

        set({
          entries: listRes.value,
          storageUsageBytes: usageBytes,
          isInitialized: true,
          isLoading: false,
          lastError: null,
        });
        initInFlight = null;
        return { ok: true, value: undefined };
      })();

      return initInFlight;
    },

    refreshList: async () => {
      const listRes = await repository.listScores();
      if (!listRes.ok) {
        set({ lastError: listRes.error });
        return listRes;
      }
      const usageBytes = await repository.estimateUsageBytes();
      set({
        entries: listRes.value,
        storageUsageBytes: usageBytes,
        lastError: null,
      });
      return listRes;
    },

    setSearchQuery: (searchQuery) => {
      set({ searchQuery });
    },

    syncScoreToLibrary: async (doc, meta) => {
      await get().initialize();
      targetNotationStore.getState().bindScoreId(doc.id);
      const v2Doc = targetNotationStore.getState().buildV2Document(doc, meta);
      const thumb = buildThumbnailSvg(doc);
      const saveRes = await repository.saveScore(v2Doc, thumb);
      if (!saveRes.ok) {
        set({ lastError: saveRes.error });
        return saveRes;
      }
      await get().refreshList();
      return saveRes;
    },

    openScore: async (id, targetMode) => {
      await get().initialize();
      const res = await repository.getScore(id);
      if (!res.ok) {
        set({ lastError: res.error });
        return res;
      }
      const v2Doc = res.value;
      const v1Doc = projectV2ToV1(v2Doc);
      targetScoreStore.getState().loadExternalDocument(v1Doc);
      targetNotationStore.getState().loadFromV2Document(v2Doc);
      targetWorkspaceStore.getState().resetActiveMeta({
        subtitle: v2Doc.subtitle,
        composer: v2Doc.composer,
        lyricist: v2Doc.lyricist,
      });
      targetWorkspaceStore.getState().setWorkMode(targetMode ?? 'studio');
      targetWorkspaceStore.getState().setActivePage('studio');
      targetInputStore.getState().setCursor({
        measureIndex: 0,
        noteIndex: 0,
        selectedNoteId: null,
      });
      set({ lastError: null });
      return res;
    },

    createAndOpenNewScore: async (title) => {
      await get().initialize();
      const createRes = targetScoreStore.getState().createNewScore({ title });
      if (!createRes.ok) {
        set({ lastError: createRes.error });
        return createRes;
      }
      targetWorkspaceStore.getState().resetActiveMeta({});
      targetScoreStore.getState().saveNow();
      const doc = targetScoreStore.getState().document;
      targetNotationStore.getState().resetForScore(doc.id);
      await get().syncScoreToLibrary(doc, {});
      targetWorkspaceStore.getState().setWorkMode('studio');
      targetWorkspaceStore.getState().setActivePage('studio');
      targetInputStore.getState().setCursor({
        measureIndex: 0,
        noteIndex: 0,
        selectedNoteId: null,
      });
      return { ok: true, value: doc };
    },

    duplicateScore: async (id) => {
      await get().initialize();
      const res = await repository.duplicateScore(
        id,
        idGen('score'),
        Math.trunc(now())
      );
      if (!res.ok) {
        set({ lastError: res.error });
        return res;
      }
      await get().refreshList();
      return res;
    },

    deleteScore: async (id) => {
      await get().initialize();
      const res = await repository.deleteScore(id);
      if (!res.ok) {
        set({ lastError: res.error });
        return res;
      }
      await get().refreshList();
      return res;
    },

    exportSingleScoreJson: (doc, meta) => {
      const v2Doc = targetNotationStore.getState().buildV2Document(doc, meta);
      return serializeScoreDocumentV2(v2Doc);
    },

    exportAllBackupJson: async () => {
      await get().initialize();
      const allRes = await repository.exportAllScores();
      if (!allRes.ok) {
        set({ lastError: allRes.error });
        return allRes;
      }
      const serRes = serializeLibraryBackup(allRes.value, Math.trunc(now()));
      if (!serRes.ok) {
        set({ lastError: serRes.error });
        return serRes;
      }
      return serRes;
    },

    importBackupJson: async (rawText) => {
      await get().initialize();
      const parsedRes = deserializeLibraryBackup(rawText);
      if (!parsedRes.ok) {
        set({ lastError: parsedRes.error });
        return parsedRes;
      }

      let importedCount = 0;
      for (const v2Doc of parsedRes.value) {
        const thumb = buildThumbnailSvg(projectV2ToV1(v2Doc));
        const saveRes = await repository.saveScore(v2Doc, thumb);
        if (!saveRes.ok) {
          set({ lastError: saveRes.error });
          return saveRes;
        }
        importedCount += 1;
      }

      await get().refreshList();
      return { ok: true, value: importedCount };
    },

    importExternalScore: async (v2Doc, openImmediately = true) => {
      await get().initialize();
      const normalizedDoc: ScoreDocumentV2 = {
        ...v2Doc,
        id: v2Doc.id || idGen('score'),
        updatedAtEpochMs: Math.trunc(now()),
      };
      const thumb = buildThumbnailSvg(projectV2ToV1(normalizedDoc));
      const saveRes = await repository.saveScore(normalizedDoc, thumb);
      if (!saveRes.ok) {
        set({ lastError: saveRes.error });
        return saveRes;
      }
      await get().refreshList();

      if (openImmediately) {
        const v1Doc = projectV2ToV1(normalizedDoc);
        targetScoreStore.getState().loadExternalDocument(v1Doc);
        targetNotationStore.getState().loadFromV2Document(normalizedDoc);
        targetWorkspaceStore.getState().resetActiveMeta({
          subtitle: normalizedDoc.subtitle,
          composer: normalizedDoc.composer,
          lyricist: normalizedDoc.lyricist,
        });
        targetWorkspaceStore.getState().setWorkMode('studio');
        targetWorkspaceStore.getState().setActivePage('studio');
        targetInputStore.getState().setCursor({
          measureIndex: 0,
          noteIndex: 0,
          selectedNoteId: null,
        });
      }

      set({ lastError: null });
      return { ok: true, value: normalizedDoc };
    },

    importExternalFile: async (filename, bytes, openImmediately = true) => {
      await get().initialize();
      const parsed = await importScoreFromFileData({
        filename,
        bytes,
        nowMs: Math.trunc(now()),
      });
      if (!parsed.ok) {
        set({ lastError: parsed.error });
        return parsed;
      }

      const imported: ScoreDocumentV2[] = [];
      for (let i = 0; i < parsed.value.length; i += 1) {
        const item = parsed.value[i]!;
        const shouldOpen = openImmediately && i === 0;
        const res = await get().importExternalScore(item, shouldOpen);
        if (!res.ok) {
          return res;
        }
        imported.push(res.value);
      }

      set({ lastError: null });
      return { ok: true, value: imported };
    },

    importJianpuText: async (text, openImmediately = true) => {
      await get().initialize();
      const parsed = parseJianpuTextToScoreV2(text, {
        nowMs: Math.trunc(now()),
        id: idGen('jianpu'),
      });
      if (!parsed.ok) {
        set({ lastError: parsed.error });
        return parsed;
      }
      return get().importExternalScore(parsed.value, openImmediately);
    },

    saveScoreReference: async (doc, meta, file) => {
      await get().initialize();
      const mime = file.mimeType.toLowerCase();
      const lowerName = file.name.toLowerCase();
      const isAllowedExt = /\.(png|jpe?g|webp|gif|svg|pdf)$/.test(lowerName);
      if (!ALLOWED_REFERENCE_MIMES.has(mime) && !isAllowedExt) {
        const err = createAppError(
          'STORAGE_SCHEMA_CORRUPTED',
          '原谱对照仅支持 PNG、JPG、WebP、SVG 图片或 PDF 文件'
        );
        set({ lastError: err });
        return { ok: false, error: err };
      }
      if (file.data.byteLength > MAX_REFERENCE_BYTES) {
        const err = createAppError(
          'STORAGE_QUOTA_EXCEEDED',
          '原谱文件大小超出 20MB 限制，请压缩后再试'
        );
        set({ lastError: err });
        return { ok: false, error: err };
      }

      if (!repository.saveReferenceAttachment) {
        const err = createAppError(
          'STORAGE_QUOTA_EXCEEDED',
          '当前存储适配器不支持原谱附件保存'
        );
        set({ lastError: err });
        return { ok: false, error: err };
      }

      const existingRefId = targetNotationStore.getState().referenceSource?.id;
      if (existingRefId && repository.deleteReferenceAttachment) {
        await repository.deleteReferenceAttachment(existingRefId);
      }

      const refId = idGen('ref');
      const resolvedMime =
        mime || (lowerName.endsWith('.pdf') ? 'application/pdf' : 'image/png');
      const attachmentMeta: ReferenceAttachment = {
        id: refId,
        name: file.name || '原谱附件',
        mimeType: resolvedMime,
        sizeBytes: file.data.byteLength,
      };
      const saveRefRes = await repository.saveReferenceAttachment({
        meta: attachmentMeta,
        data: file.data,
      });
      if (!saveRefRes.ok) {
        set({ lastError: saveRefRes.error });
        return saveRefRes;
      }

      targetNotationStore.getState().bindScoreId(doc.id);
      targetNotationStore.getState().setReferenceSource(saveRefRes.value);
      targetNotationStore.getState().toggleReferencePanel(true);

      const syncRes = await get().syncScoreToLibrary(doc, meta);
      if (!syncRes.ok) {
        return syncRes;
      }

      set({ lastError: null });
      return saveRefRes;
    },

    loadScoreReference: async (id) => {
      await get().initialize();
      if (!repository.getReferenceAttachment) {
        return {
          ok: false,
          error: createAppError('RESOURCE_NOT_FOUND', '当前存储不支持读取原谱附件'),
        };
      }
      const res = await repository.getReferenceAttachment(id);
      if (!res.ok) {
        set({ lastError: res.error });
      }
      return res;
    },

    removeScoreReference: async (doc, meta) => {
      await get().initialize();
      const existingRefId = targetNotationStore.getState().referenceSource?.id;
      if (existingRefId && repository.deleteReferenceAttachment) {
        await repository.deleteReferenceAttachment(existingRefId);
      }
      targetNotationStore.getState().setReferenceSource(null);
      const syncRes = await get().syncScoreToLibrary(doc, meta);
      if (!syncRes.ok) {
        return syncRes;
      }
      return { ok: true, value: undefined };
    },

    clearError: () => {
      set({ lastError: null });
    },
  }));
}

export const libraryStore: LibraryStoreApi = createLibraryStore();

export function useLibraryStore<T>(
  selector: (state: LibraryStoreState) => T,
  store: LibraryStoreApi = libraryStore
): T {
  return useStore(store, selector);
}
