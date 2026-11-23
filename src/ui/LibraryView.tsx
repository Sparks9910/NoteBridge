import { type ChangeEvent, useMemo, useRef, useState } from 'react';
import { exportLibraryBackupFile } from '../application/export-service.ts';
import { libraryStore, useLibraryStore } from '../application/library-store.ts';
import { workspaceStore } from '../application/workspace-store.ts';
import { ImportModal } from './ImportModal.tsx';

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatUpdatedAt(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) {
    return '刚刚';
  }
  const d = new Date(epochMs);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

export function LibraryView() {
  const entries = useLibraryStore((s) => s.entries);
  const searchQuery = useLibraryStore((s) => s.searchQuery);
  const isLoading = useLibraryStore((s) => s.isLoading);
  const storageUsageBytes = useLibraryStore((s) => s.storageUsageBytes);
  const lastError = useLibraryStore((s) => s.lastError);

  const [notice, setNotice] = useState<string | null>(null);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const filteredEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      return entries;
    }
    return entries.filter((entry) => {
      const haystack = [
        entry.title,
        entry.subtitle ?? '',
        entry.composer ?? '',
        `1=${entry.keySignature}`,
        entry.timeSignature,
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [entries, searchQuery]);

  const handleExportAll = async () => {
    setNotice(null);
    const res = await exportLibraryBackupFile();
    if (res.ok) {
      setNotice(`已导出整库备份文件：${res.value}`);
    }
  };

  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) {
      return;
    }
    setNotice(null);
    const text = await file.text();
    const res = await libraryStore.getState().importBackupJson(text);
    if (res.ok) {
      setNotice(`成功导入 ${res.value} 首曲谱到本地乐谱库`);
    }
  };

  return (
    <div className="nb-library-page" data-testid="library-view">
      <header className="nb-toolbar">
        <div className="nb-toolbar-row nb-library-topbar">
          <div className="nb-brand">
            <span className="nb-brand-title">NoteBridge</span>
            <span className="nb-brand-sub">音桥 · 乐谱库</span>
          </div>

          <input
            type="search"
            className="nb-input nb-library-search"
            data-testid="library-search-input"
            aria-label="搜索乐谱库"
            placeholder="搜索曲名、作者或调号..."
            value={searchQuery}
            onChange={(e) => libraryStore.getState().setSearchQuery(e.target.value)}
          />

          <div className="nb-toolbar-group">
            <span className="nb-storage-pill" data-testid="library-storage-usage">
              本地存储：{formatBytes(storageUsageBytes)}
            </span>
            <button
              type="button"
              className="nb-btn nb-btn-primary"
              data-testid="btn-library-import"
              onClick={() => setIsImportOpen(true)}
            >
              导入曲谱
            </button>
            <button
              type="button"
              className="nb-btn"
              data-testid="btn-export-backup"
              onClick={() => void handleExportAll()}
            >
              导出备份
            </button>
            <button
              type="button"
              className="nb-btn"
              data-testid="btn-import-backup"
              onClick={() => fileInputRef.current?.click()}
            >
              导入备份
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="nb-hidden-input"
              data-testid="input-import-backup"
              onChange={(e) => void handleImportFile(e)}
            />
            <button
              type="button"
              className="nb-btn nb-btn-primary"
              data-testid="btn-back-to-studio"
              onClick={() => workspaceStore.getState().setActivePage('studio')}
            >
              返回当前曲谱
            </button>
          </div>
        </div>

        {lastError && (
          <div className="nb-error-banner" data-testid="library-error" role="alert">
            <span>{lastError.detail}</span>
            <button
              type="button"
              className="nb-btn-close"
              onClick={() => libraryStore.getState().clearError()}
            >
              关闭
            </button>
          </div>
        )}

        {notice && (
          <div className="nb-info-banner" data-testid="library-feedback" role="status">
            <span>{notice}</span>
            <button
              type="button"
              className="nb-btn-close"
              onClick={() => setNotice(null)}
            >
              关闭
            </button>
          </div>
        )}
      </header>

      <main className="nb-main">
        {isLoading ? (
          <div className="nb-library-empty">正在读取本地 IndexedDB 乐谱库...</div>
        ) : (
          <div className="nb-library-grid" data-testid="library-grid">
            <button
              type="button"
              className="nb-library-card nb-library-new-card"
              data-testid="card-new-score"
              onClick={() => void libraryStore.getState().createAndOpenNewScore()}
            >
              <span className="nb-new-plus">+</span>
              <span className="nb-new-label">新建曲谱</span>
              <span className="nb-new-hint">创建空白简谱/五线谱工程</span>
            </button>

            {filteredEntries.map((entry) => (
              <article
                key={entry.id}
                className="nb-library-card"
                data-testid={`library-card-${entry.id}`}
              >
                <div className="nb-library-thumb">
                  {entry.thumbnailSvg ? (
                    <img
                      className="nb-library-thumb-img"
                      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(entry.thumbnailSvg)}`}
                      alt={entry.title}
                    />
                  ) : (
                    <div className="nb-library-thumb-placeholder">暂无预览</div>
                  )}
                </div>

                <div className="nb-library-card-body">
                  <h3 className="nb-library-card-title" title={entry.title}>
                    {entry.title || '未命名曲谱'}
                  </h3>
                  <div className="nb-library-card-meta">
                    <span>1={entry.keySignature}</span>
                    <span>{entry.timeSignature}</span>
                    <span>{entry.bpm} BPM</span>
                    <span>{entry.measureCount} 小节</span>
                  </div>
                  <div className="nb-library-card-time">
                    更新于 {formatUpdatedAt(entry.updatedAtEpochMs)}
                  </div>
                </div>

                <div className="nb-library-card-actions">
                  <button
                    type="button"
                    className="nb-btn nb-btn-sm nb-btn-primary"
                    data-testid={`btn-open-studio-${entry.id}`}
                    onClick={() =>
                      void libraryStore.getState().openScore(entry.id, 'studio')
                    }
                  >
                    制谱对照
                  </button>
                  <button
                    type="button"
                    className="nb-btn nb-btn-sm"
                    data-testid={`btn-open-practice-${entry.id}`}
                    onClick={() =>
                      void libraryStore.getState().openScore(entry.id, 'practice')
                    }
                  >
                    练谱
                  </button>
                  <button
                    type="button"
                    className="nb-btn nb-btn-sm"
                    data-testid={`btn-duplicate-${entry.id}`}
                    onClick={() => void libraryStore.getState().duplicateScore(entry.id)}
                  >
                    复制
                  </button>
                  <button
                    type="button"
                    className="nb-btn nb-btn-sm nb-btn-danger"
                    data-testid={`btn-delete-score-${entry.id}`}
                    onClick={() => void libraryStore.getState().deleteScore(entry.id)}
                  >
                    删除
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}

        {!isLoading && filteredEntries.length === 0 && (
          <div className="nb-library-empty" data-testid="library-empty-hint">
            {searchQuery.trim()
              ? '未找到匹配搜索关键词的曲谱，请尝试更换关键词。'
              : '乐谱库暂无保存的曲谱，可点击“+ 新建曲谱”或导入 MusicXML / MIDI / Guitar Pro（.gp/.gp5/.gpx）/ 图片PDF转谱。'}
          </div>
        )}
      </main>
      <ImportModal
        isOpen={isImportOpen}
        onClose={() => setIsImportOpen(false)}
      />
    </div>
  );
}
