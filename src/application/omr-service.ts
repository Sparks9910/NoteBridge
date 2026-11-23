import type { Result } from '../domain/types.ts';
import { projectV2ToV1 } from '../domain/v2-serializer.ts';
import type { ReferenceAttachment, ScoreDocumentV2 } from '../domain/v2-types.ts';
import {
  createOmrProvider,
  DEFAULT_LOCAL_OMR_ENDPOINT,
  type FetchLike,
  loadOmrConfigFromStorage,
  type OmrFileInput,
  type OmrHealthStatus,
  type OmrProviderConfig,
  type OmrProviderType,
  saveOmrConfigToStorage,
} from '../infrastructure/omr/index.ts';
import { libraryStore, type LibraryStoreApi } from './library-store.ts';
import { notationStore, type NotationStoreApi } from './notation-store.ts';
import { scoreStore, type ScoreStoreApi } from './score-store.ts';
import {
  workspaceStore,
  type WorkspaceStoreApi,
} from './workspace-store.ts';

export {
  DEFAULT_LOCAL_OMR_ENDPOINT,
  type OmrFileInput,
  type OmrHealthStatus,
  type OmrProviderConfig,
  type OmrProviderType,
};

export interface OmrServiceDeps {
  libraryStore?: LibraryStoreApi;
  scoreStore?: ScoreStoreApi;
  notationStore?: NotationStoreApi;
  workspaceStore?: WorkspaceStoreApi;
  fetchFn?: FetchLike;
}

export function loadSavedOmrConfig(): OmrProviderConfig {
  return loadOmrConfigFromStorage();
}

export function saveOmrConfig(config: OmrProviderConfig): void {
  saveOmrConfigToStorage(config);
}

export async function checkOmrProviderHealth(
  config: OmrProviderConfig,
  fetchFn?: FetchLike
): Promise<OmrHealthStatus> {
  const provider = createOmrProvider(config, fetchFn);
  return provider.checkHealth();
}

export interface OmrRecognitionResult {
  score: ScoreDocumentV2;
  reference: ReferenceAttachment;
}

/**
 * 调用可插拔 OmrProvider 将图片/PDF 转谱为可编辑 ScoreDocumentV2，
 * 并自动将原始图片/PDF 写入 IndexedDB 开启「原谱对照」分屏。
 */
export async function recognizeScoreWithOmrAndAttachReference(
  file: OmrFileInput,
  config: OmrProviderConfig,
  deps?: OmrServiceDeps
): Promise<Result<OmrRecognitionResult>> {
  const targetLibrary = deps?.libraryStore ?? libraryStore;
  const targetWorkspace = deps?.workspaceStore ?? workspaceStore;
  const provider = createOmrProvider(config, deps?.fetchFn);

  const recRes = await provider.recognizeScore(file, {
    title: file.name.replace(/\.[^.]+$/, '').trim() || '智能转谱曲谱',
  });
  if (!recRes.ok) {
    return recRes;
  }

  const importRes = await targetLibrary
    .getState()
    .importExternalScore(recRes.value, true);
  if (!importRes.ok) {
    return importRes;
  }

  const importedV2 = importRes.value;
  const v1Doc = projectV2ToV1(importedV2);
  const meta = {
    subtitle: importedV2.subtitle,
    composer: importedV2.composer,
    lyricist: importedV2.lyricist,
  };
  const refRes = await targetLibrary
    .getState()
    .saveScoreReference(v1Doc, meta, file);
  if (!refRes.ok) {
    return refRes;
  }

  targetWorkspace.getState().setWorkMode('studio');
  targetWorkspace.getState().setActivePage('studio');

  return {
    ok: true,
    value: {
      score: importedV2,
      reference: refRes.value,
    },
  };
}

/**
 * OMR 服务离线或未配置时的一键降级：将原谱图片/PDF 存入 IndexedDB 并自动开启「原谱对照」分屏。
 */
export async function loadFileAsReferenceOnly(
  file: OmrFileInput,
  deps?: OmrServiceDeps
): Promise<Result<ReferenceAttachment>> {
  const targetLibrary = deps?.libraryStore ?? libraryStore;
  const targetScore = deps?.scoreStore ?? scoreStore;
  const targetNotation = deps?.notationStore ?? notationStore;
  const targetWorkspace = deps?.workspaceStore ?? workspaceStore;

  const currentDoc = targetScore.getState().document;
  const activeMeta = targetWorkspace.getState().activeMeta;
  const refRes = await targetLibrary
    .getState()
    .saveScoreReference(currentDoc, activeMeta, file);
  if (!refRes.ok) {
    return refRes;
  }

  targetNotation.getState().toggleReferencePanel(true);
  targetWorkspace.getState().setWorkMode('studio');
  targetWorkspace.getState().setActivePage('studio');
  return refRes;
}
