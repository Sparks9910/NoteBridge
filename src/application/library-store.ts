import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { createRequestId } from '../domain/state-machines.ts';
import type { Result, ScoreDocument } from '../domain/types.ts';
import {
  deserializeLibraryBackup,
  migrateV1ToV2,
  projectV2ToV1,
  serializeLibraryBackup,
  serializeScoreDocumentV2,
} from '../domain/v2-serializer.ts';
import type {
  AppError,
  LibraryScoreEntry,
  ScoreDocumentV2,
  ScoreMetadata,
  WorkMode,
} from '../domain/v2-types.ts';
import {
  createLibraryRepository,
  migrateLegacyLocalStorageToLibrary,
  type ScoreLibraryRepository,
} from '../infrastructure/indexeddb-adapter.ts';
import {
  createStorageAdapter,
  type StorageAdapter,
} from '../infrastructure/storage-adapter.ts';
import { buildThumbnailSvg } from '../rendering/export-renderer.ts';
import { inputStore, type InputStoreApi } from './input-store.ts';
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
  now?: () => number;
  idGenerator?: (prefix: string) => string;
}

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
      const v2Doc = migrateV1ToV2(doc, meta);
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
      const v2Doc = migrateV1ToV2(doc, meta);
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
