import { useState } from 'react';
import {
  exportCurrentScoreAsJson,
  exportCurrentScoreAsPdf,
  exportCurrentScoreAsPng,
} from '../application/export-service.ts';
import { useScoreStore } from '../application/score-store.ts';
import {
  useWorkspaceStore,
  workspaceStore,
} from '../application/workspace-store.ts';

export interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ExportModal({ isOpen, onClose }: ExportModalProps) {
  const doc = useScoreStore((s) => s.document);
  const activeMeta = useWorkspaceStore((s) => s.activeMeta);
  const [busyFormat, setBusyFormat] = useState<'png' | 'pdf' | null>(null);
  const [feedback, setFeedback] = useState<{
    kind: 'ok' | 'error';
    text: string;
  } | null>(null);

  if (!isOpen) {
    return null;
  }

  const handleExportPng = async () => {
    setBusyFormat('png');
    setFeedback(null);
    const res = await exportCurrentScoreAsPng(doc, activeMeta);
    setBusyFormat(null);
    if (res.ok) {
      setFeedback({
        kind: 'ok',
        text: `已导出无水印高清长图：${res.value}`,
      });
    } else {
      setFeedback({ kind: 'error', text: res.error.detail });
    }
  };

  const handleExportPdf = async () => {
    setBusyFormat('pdf');
    setFeedback(null);
    const res = await exportCurrentScoreAsPdf(doc, activeMeta);
    setBusyFormat(null);
    if (res.ok) {
      setFeedback({
        kind: 'ok',
        text: `已导出无水印 A4 分页 PDF：${res.value}`,
      });
    } else {
      setFeedback({ kind: 'error', text: res.error.detail });
    }
  };

  const handleExportJson = () => {
    const res = exportCurrentScoreAsJson(doc, activeMeta);
    if (res.ok) {
      setFeedback({
        kind: 'ok',
        text: `已导出曲谱工程备份：${res.value}`,
      });
    } else {
      setFeedback({ kind: 'error', text: res.error.detail });
    }
  };

  return (
    <div
      className="nb-modal-backdrop"
      data-testid="export-modal"
      role="dialog"
      aria-modal="true"
      aria-label="导出中心"
    >
      <div className="nb-modal-card">
        <div className="nb-modal-header">
          <h2 className="nb-modal-title">导出中心（原生无水印）</h2>
          <button
            type="button"
            className="nb-btn nb-btn-sm"
            onClick={onClose}
            aria-label="关闭导出弹窗"
          >
            关闭
          </button>
        </div>

        <div className="nb-modal-body">
          <div className="nb-modal-section">
            <span className="nb-modal-label">打印排版署名（可选）</span>
            <div className="nb-meta-grid">
              <label className="nb-meta-field">
                <span>副标题</span>
                <input
                  type="text"
                  className="nb-input"
                  data-testid="export-meta-subtitle"
                  placeholder="例如：第一乐章 / 练习版"
                  value={activeMeta.subtitle ?? ''}
                  onChange={(e) =>
                    workspaceStore.getState().setActiveMeta({
                      subtitle: e.target.value,
                    })
                  }
                />
              </label>
              <label className="nb-meta-field">
                <span>作曲</span>
                <input
                  type="text"
                  className="nb-input"
                  data-testid="export-meta-composer"
                  placeholder="例如：莫扎特"
                  value={activeMeta.composer ?? ''}
                  onChange={(e) =>
                    workspaceStore.getState().setActiveMeta({
                      composer: e.target.value,
                    })
                  }
                />
              </label>
              <label className="nb-meta-field">
                <span>作词</span>
                <input
                  type="text"
                  className="nb-input"
                  data-testid="export-meta-lyricist"
                  placeholder="选填"
                  value={activeMeta.lyricist ?? ''}
                  onChange={(e) =>
                    workspaceStore.getState().setActiveMeta({
                      lyricist: e.target.value,
                    })
                  }
                />
              </label>
            </div>
          </div>

          <div className="nb-export-actions">
            <button
              type="button"
              className="nb-btn nb-btn-primary"
              data-testid="btn-export-png"
              disabled={busyFormat !== null}
              onClick={() => void handleExportPng()}
            >
              {busyFormat === 'png' ? '正在渲染 PNG...' : '导出高清 PNG（无水印）'}
            </button>
            <button
              type="button"
              className="nb-btn nb-btn-primary"
              data-testid="btn-export-pdf"
              disabled={busyFormat !== null}
              onClick={() => void handleExportPdf()}
            >
              {busyFormat === 'pdf' ? '正在生成 PDF...' : '导出 A4 分页 PDF（无水印）'}
            </button>
            <button
              type="button"
              className="nb-btn"
              data-testid="btn-export-json"
              disabled={busyFormat !== null}
              onClick={handleExportJson}
            >
              导出曲谱备份（JSON）
            </button>
          </div>

          {feedback && (
            <div
              className={
                feedback.kind === 'ok' ? 'nb-info-banner' : 'nb-error-banner'
              }
              data-testid="export-feedback"
              role="status"
            >
              <span>{feedback.text}</span>
            </div>
          )}
        </div>

        <div className="nb-modal-footer">
          <button type="button" className="nb-btn" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
