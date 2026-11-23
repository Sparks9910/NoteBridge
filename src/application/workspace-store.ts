import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ScoreMetadata, WorkMode } from '../domain/v2-types.ts';

export type WorkspacePage = 'studio' | 'library';

export interface WorkspaceStoreState {
  activePage: WorkspacePage;
  workMode: WorkMode;
  activeMeta: ScoreMetadata;
  setActivePage: (page: WorkspacePage) => void;
  setWorkMode: (mode: WorkMode) => void;
  setActiveMeta: (patch: Partial<ScoreMetadata>) => void;
  resetActiveMeta: (meta?: ScoreMetadata) => void;
}

export type WorkspaceStoreApi = StoreApi<WorkspaceStoreState>;

export function createWorkspaceStore(): WorkspaceStoreApi {
  return createStore<WorkspaceStoreState>((set) => ({
    activePage: 'studio',
    workMode: 'studio',
    activeMeta: {},

    setActivePage: (activePage) => {
      set({ activePage });
    },

    setWorkMode: (workMode) => {
      set({ workMode });
    },

    setActiveMeta: (patch) => {
      set((state) => ({
        activeMeta: {
          ...state.activeMeta,
          ...patch,
        },
      }));
    },

    resetActiveMeta: (meta) => {
      set({
        activeMeta: meta ? { ...meta } : {},
      });
    },
  }));
}

export const workspaceStore: WorkspaceStoreApi = createWorkspaceStore();

export function useWorkspaceStore<T>(
  selector: (state: WorkspaceStoreState) => T,
  store: WorkspaceStoreApi = workspaceStore
): T {
  return useStore(store, selector);
}
