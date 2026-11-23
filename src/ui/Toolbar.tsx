import { type ChangeEvent, useState } from 'react';
import { inputStore } from '../application/input-store.ts';
import { libraryStore } from '../application/library-store.ts';
import { notationStore, useNotationStore } from '../application/notation-store.ts';
import {
  playbackController,
  usePlaybackStore,
} from '../application/playback-controller.ts';
import {
  KEY_SIGNATURE_OPTIONS,
  scoreStore,
  TIME_SIGNATURE_OPTIONS,
  useScoreStore,
} from '../application/score-store.ts';
import {
  useWorkspaceStore,
  workspaceStore,
} from '../application/workspace-store.ts';
import type {
  DocumentState,
  KeySignature,
  TimeSignature,
  ViewMode,
} from '../domain/types.ts';
import { ExportModal } from './ExportModal.tsx';
import { ImportModal } from './ImportModal.tsx';
import { TransposeModal } from './TransposeModal.tsx';

const SAVE_STATUS_LABELS: Record<DocumentState, string> = {
  CLEAN: '已保存',
  DIRTY: '未保存',
  SAVING: '保存中...',
  SAVE_FAILED: '保存失败',
};

const VIEW_MODE_ITEMS: ReadonlyArray<{
  mode: ViewMode;
  label: string;
  testId: string;
}> = [
  { mode: 'dual', label: '双谱对照', testId: 'btn-view-dual' },
  { mode: 'jianpu', label: '仅简谱', testId: 'btn-view-jianpu' },
  { mode: 'staff', label: '仅五线谱', testId: 'btn-view-staff' },
];

export function Toolbar() {
  const title = useScoreStore((s) => s.document.title);
  const keySignature = useScoreStore((s) => s.document.keySignature);
  const timeSignature = useScoreStore((s) => s.document.timeSignature);
  const bpm = useScoreStore((s) => s.document.bpm);
  const viewMode = useScoreStore((s) => s.document.viewMode);
  const documentState = useScoreStore((s) => s.documentState);
  const canUndo = useScoreStore((s) => s.canUndo);
  const canRedo = useScoreStore((s) => s.canRedo);
  const isDemoModeEnabled = useScoreStore((s) => s.isDemoModeEnabled);
  const lastError = useScoreStore((s) => s.lastError);

  const playbackState = usePlaybackStore((s) => s.playbackState);
  const workMode = useWorkspaceStore((s) => s.workMode);
  const showReferencePanel = useNotationStore((s) => s.showReferencePanel);
  const referenceSource = useNotationStore((s) => s.referenceSource);
  const isLocked = playbackState !== 'IDLE' && playbackState !== 'ERROR';

  const [isTransposeOpen, setIsTransposeOpen] = useState(false);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);

  const handleOpenLibrary = () => {
    if (isLocked) {
      return;
    }
    const state = scoreStore.getState();
    const hasNotes = state.document.measures.some((m) => m.notes.length > 0);
    if (hasNotes || state.lastSavedAtEpochMs !== null) {
      void libraryStore
        .getState()
        .syncScoreToLibrary(
          state.document,
          workspaceStore.getState().activeMeta
        );
    }
    workspaceStore.getState().setActivePage('library');
  };

  const handleSaveNow = () => {
    const res = scoreStore.getState().saveNow();
    if (res.ok) {
      void libraryStore
        .getState()
        .syncScoreToLibrary(res.value, workspaceStore.getState().activeMeta);
    }
  };

  const handleTitleChange = (e: ChangeEvent<HTMLInputElement>) => {
    scoreStore.getState().setTitle(e.target.value);
  };

  const handleNewScore = () => {
    if (isLocked) {
      return;
    }
    const res = scoreStore.getState().createNewScore();
    if (res.ok) {
      notationStore.getState().resetForScore(res.value.id);
    }
    inputStore.getState().setCursor({
      measureIndex: 0,
      noteIndex: 0,
      selectedNoteId: null,
    });
  };

  const handleLoadDemo = () => {
    if (isLocked) {
      return;
    }
    const res = scoreStore.getState().loadDemoScore();
    if (res.ok) {
      notationStore.getState().resetForScore(res.value.id);
      inputStore.getState().setCursor({
        measureIndex: 0,
        noteIndex: 0,
        selectedNoteId: null,
      });
    }
  };

  const handleKeyChange = (e: ChangeEvent<HTMLSelectElement>) => {
    scoreStore.getState().setKeySignature(e.target.value as KeySignature);
  };

  const handleTimeChange = (e: ChangeEvent<HTMLSelectElement>) => {
    scoreStore.getState().setTimeSignature(e.target.value as TimeSignature);
  };

  const handleBpmChange = (raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return;
    }
    const clamped = Math.max(40, Math.min(200, Math.round(parsed)));
    playbackController.updateBpmLive(clamped);
  };

  return (
    <header className="nb-toolbar">
      {isDemoModeEnabled && (
        <div className="nb-demo-banner" data-testid="demo-mode-banner">
          <span className="nb-demo-badge">演示环境</span>
          <span className="nb-demo-text">
            当前处于受控演示模式，可一键载入内置《小星星》体验双谱对照与同步高亮
          </span>
          <button
            type="button"
            className="nb-btn nb-btn-demo"
            data-testid="btn-load-demo"
            disabled={isLocked}
            onClick={handleLoadDemo}
          >
            载入演示曲谱
          </button>
        </div>
      )}

      <div className="nb-toolbar-row">
        <div className="nb-brand">
          <span className="nb-brand-title">NoteBridge</span>
          <span className="nb-brand-sub">音桥</span>
        </div>

        <button
          type="button"
          className="nb-btn"
          data-testid="btn-open-library"
          disabled={isLocked}
          onClick={handleOpenLibrary}
        >
          乐谱库
        </button>

        <div className="nb-toolbar-group">
          <input
            type="text"
            className="nb-title-input"
            data-testid="score-title-input"
            aria-label="曲谱标题"
            value={title}
            onChange={handleTitleChange}
            placeholder="输入曲谱标题"
          />
          <button
            type="button"
            className="nb-btn"
            data-testid="btn-new-score"
            disabled={isLocked}
            onClick={handleNewScore}
          >
            新建曲谱
          </button>
        </div>

        <div className="nb-toolbar-group">
          <label className="nb-field">
            <span className="nb-field-label">调号</span>
            <select
              className="nb-select"
              data-testid="select-key-signature"
              aria-label="调号"
              value={keySignature}
              disabled={isLocked}
              onChange={handleKeyChange}
            >
              {KEY_SIGNATURE_OPTIONS.map((k) => (
                <option key={k} value={k}>
                  1 = {k}
                </option>
              ))}
            </select>
          </label>

          <label className="nb-field">
            <span className="nb-field-label">拍号</span>
            <select
              className="nb-select"
              data-testid="select-time-signature"
              aria-label="拍号"
              value={timeSignature}
              disabled={isLocked}
              onChange={handleTimeChange}
            >
              {TIME_SIGNATURE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>

          <label className="nb-field nb-bpm-field">
            <span className="nb-field-label">速度 BPM</span>
            <input
              type="range"
              min={40}
              max={200}
              step={1}
              data-testid="input-bpm-range"
              aria-label="速度滑块"
              value={bpm}
              onChange={(e) => handleBpmChange(e.target.value)}
            />
            <input
              type="number"
              min={40}
              max={200}
              step={1}
              className="nb-bpm-number"
              data-testid="input-bpm-number"
              aria-label="速度数值"
              value={bpm}
              onChange={(e) => handleBpmChange(e.target.value)}
            />
          </label>
        </div>

        <div className="nb-toolbar-group nb-view-switch" role="group" aria-label="视图模式">
          {VIEW_MODE_ITEMS.map((item) => (
            <button
              key={item.mode}
              type="button"
              className={`nb-btn ${viewMode === item.mode ? 'nb-btn-active' : ''}`}
              data-testid={item.testId}
              aria-pressed={viewMode === item.mode}
              onClick={() => scoreStore.getState().setViewMode(item.mode)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="nb-toolbar-group nb-mode-capsule" role="group" aria-label="工作模式">
          <button
            type="button"
            className={`nb-btn nb-capsule-btn ${workMode === 'studio' ? 'nb-btn-active' : ''}`}
            data-testid="mode-switch-studio"
            aria-pressed={workMode === 'studio'}
            onClick={() => workspaceStore.getState().setWorkMode('studio')}
          >
            制谱对照
          </button>
          <button
            type="button"
            className={`nb-btn nb-capsule-btn ${workMode === 'practice' ? 'nb-btn-active' : ''}`}
            data-testid="mode-switch-practice"
            aria-pressed={workMode === 'practice'}
            onClick={() => workspaceStore.getState().setWorkMode('practice')}
          >
            练谱模式
          </button>
        </div>

        <div className="nb-toolbar-group">
          <button
            type="button"
            className="nb-btn"
            data-testid="btn-open-import"
            disabled={isLocked}
            onClick={() => setIsImportOpen(true)}
          >
            导入
          </button>
          <button
            type="button"
            className={`nb-btn ${showReferencePanel ? 'nb-btn-active' : ''}`}
            data-testid="btn-toggle-reference"
            aria-pressed={showReferencePanel}
            disabled={workMode !== 'studio'}
            onClick={() => notationStore.getState().toggleReferencePanel()}
          >
            {referenceSource ? '原谱对照 •' : '原谱对照'}
          </button>
          <button
            type="button"
            className="nb-btn"
            data-testid="btn-open-transpose"
            disabled={isLocked}
            onClick={() => setIsTransposeOpen(true)}
          >
            一键移调
          </button>
          <button
            type="button"
            className="nb-btn"
            data-testid="btn-open-export"
            onClick={() => setIsExportOpen(true)}
          >
            导出
          </button>
          <button
            type="button"
            className="nb-btn"
            data-testid="btn-undo"
            disabled={isLocked || !canUndo}
            onClick={() => scoreStore.getState().undo()}
          >
            撤销
          </button>
          <button
            type="button"
            className="nb-btn"
            data-testid="btn-redo"
            disabled={isLocked || !canRedo}
            onClick={() => scoreStore.getState().redo()}
          >
            重做
          </button>
          <button
            type="button"
            className="nb-btn nb-btn-primary"
            data-testid="btn-save"
            onClick={handleSaveNow}
          >
            保存
          </button>
          <span
            className={`nb-save-status nb-save-${documentState.toLowerCase()}`}
            data-testid="save-status"
          >
            {SAVE_STATUS_LABELS[documentState]}
          </span>
        </div>
      </div>

      {lastError && (
        <div className="nb-error-banner" data-testid="score-error-banner" role="alert">
          <span>{lastError.detail}</span>
          <button
            type="button"
            className="nb-btn-close"
            onClick={() => scoreStore.getState().clearError()}
            aria-label="关闭提示"
          >
            关闭
          </button>
        </div>
      )}

      <TransposeModal
        isOpen={isTransposeOpen}
        onClose={() => setIsTransposeOpen(false)}
      />
      <ExportModal
        isOpen={isExportOpen}
        onClose={() => setIsExportOpen(false)}
      />
      <ImportModal
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
      />
    </header>
  );
}
