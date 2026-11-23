import { useEffect, useMemo, useState } from 'react';
import {
  exportCurrentScoreAsJson,
  exportCurrentScoreAsPdf,
  exportCurrentScoreAsPng,
  exportPartAsFormat,
  exportScoreAsMidi,
  exportScoreAsMusicXml,
  exportScoreAsMxl,
  type PartExportFormat,
} from '../application/export-service.ts';
import { notationStore, useNotationStore } from '../application/notation-store.ts';
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
  const tracks = useNotationStore((s) => s.tracks);
  const clef = useNotationStore((s) => s.clef);
  const noteExtrasById = useNotationStore((s) => s.noteExtrasById);
  const measureExtrasByIndex = useNotationStore((s) => s.measureExtrasByIndex);

  const [busyFormat, setBusyFormat] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    kind: 'ok' | 'error';
    text: string;
  } | null>(null);
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);
  const [partFormat, setPartFormat] = useState<PartExportFormat>('musicxml');

  const currentV2 = useMemo(() => {
    if (!isOpen) {
      return null;
    }
    return notationStore.getState().buildV2Document(doc, activeMeta);
  }, [isOpen, doc, activeMeta, tracks, clef, noteExtrasById, measureExtrasByIndex]);

  useEffect(() => {
    if (isOpen && currentV2) {
      setSelectedTrackIds(currentV2.tracks.map((t) => t.id));
    }
  }, [isOpen, currentV2]);

  if (!isOpen || !currentV2) {
    return null;
  }

  const handleExportPng = async () => {
    setBusyFormat('png');
    setFeedback(null);
    const res = await exportCurrentScoreAsPng(doc, activeMeta, currentV2);
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
    const res = await exportCurrentScoreAsPdf(doc, activeMeta, currentV2);
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

  const handleExportMusicXml = () => {
    setFeedback(null);
    const res = exportScoreAsMusicXml(currentV2);
    if (res.ok) {
      setFeedback({ kind: 'ok', text: `已导出标准 MusicXML：${res.value}` });
    } else {
      setFeedback({ kind: 'error', text: res.error.detail });
    }
  };

  const handleExportMxl = async () => {
    setBusyFormat('mxl');
    setFeedback(null);
    const res = await exportScoreAsMxl(currentV2);
    setBusyFormat(null);
    if (res.ok) {
      setFeedback({ kind: 'ok', text: `已导出压缩 MXL：${res.value}` });
    } else {
      setFeedback({ kind: 'error', text: res.error.detail });
    }
  };

  const handleExportMidi = () => {
    setFeedback(null);
    const res = exportScoreAsMidi(currentV2);
    if (res.ok) {
      setFeedback({ kind: 'ok', text: `已导出标准 MIDI：${res.value}` });
    } else {
      setFeedback({ kind: 'error', text: res.error.detail });
    }
  };

  const handleTogglePartTrack = (trackId: string) => {
    setSelectedTrackIds((prev) =>
      prev.includes(trackId)
        ? prev.filter((id) => id !== trackId)
        : [...prev, trackId]
    );
  };

  const handleExportTracksPart = async () => {
    setBusyFormat('part');
    setFeedback(null);
    const res = await exportPartAsFormat(
      currentV2,
      { mode: 'tracks', trackIds: selectedTrackIds },
      partFormat,
      activeMeta
    );
    setBusyFormat(null);
    if (res.ok) {
      setFeedback({ kind: 'ok', text: `已导出分谱文件：${res.value}` });
    } else {
      setFeedback({ kind: 'error', text: res.error.detail });
    }
  };

  const handleExportVoicePart = async (voiceIndex: 0 | 1) => {
    const mainTrack = currentV2.tracks[0];
    if (!mainTrack) return;
    setBusyFormat(`voice-${voiceIndex}`);
    setFeedback(null);
    const res = await exportPartAsFormat(
      currentV2,
      { mode: 'voice', trackId: mainTrack.id, voiceIndex },
      partFormat,
      activeMeta
    );
    setBusyFormat(null);
    if (res.ok) {
      setFeedback({ kind: 'ok', text: `已导出声部分谱：${res.value}` });
    } else {
      setFeedback({ kind: 'error', text: res.error.detail });
    }
  };

  const hasTwoVoices = (currentV2.tracks[0]?.voices.length ?? 1) >= 2;

  return (
    <div
      className="nb-modal-backdrop"
      data-testid="export-modal"
      role="dialog"
      aria-modal="true"
      aria-label="导出中心"
    >
      <div className="nb-modal-card nb-modal-wide">
        <div className="nb-modal-header">
          <h2 className="nb-modal-title">导出中心（原生无水印 · 全格式互通）</h2>
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
            <div className="nb-export-interop-grid">
              <button
                type="button"
                className="nb-btn"
                data-testid="btn-export-musicxml"
                disabled={busyFormat !== null}
                onClick={handleExportMusicXml}
              >
                导出 MusicXML (.musicxml)
              </button>
              <button
                type="button"
                className="nb-btn"
                data-testid="btn-export-mxl"
                disabled={busyFormat !== null}
                onClick={() => void handleExportMxl()}
              >
                {busyFormat === 'mxl' ? '正在打包 MXL...' : '导出压缩 MXL (.mxl)'}
              </button>
              <button
                type="button"
                className="nb-btn"
                data-testid="btn-export-midi"
                disabled={busyFormat !== null}
                onClick={handleExportMidi}
              >
                导出标准 MIDI (.mid)
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
          </div>

          <div className="nb-modal-section nb-part-extract-box" data-testid="part-extraction-section">
            <div className="nb-label-row">
              <span className="nb-modal-label">分谱导出（Part Extraction）</span>
              <select
                className="nb-select"
                data-testid="select-part-format"
                aria-label="分谱导出格式"
                value={partFormat}
                onChange={(e) => setPartFormat(e.target.value as PartExportFormat)}
              >
                <option value="musicxml">MusicXML (.musicxml)</option>
                <option value="mxl">压缩 MXL (.mxl)</option>
                <option value="midi">MIDI (.mid)</option>
                <option value="pdf">A4 PDF (.pdf)</option>
                <option value="png">高清 PNG (.png)</option>
              </select>
            </div>

            <div className="nb-part-track-list">
              {currentV2.tracks.map((tr) => (
                <label key={tr.id} className="nb-part-check">
                  <input
                    type="checkbox"
                    data-testid={`part-track-checkbox-${tr.id}`}
                    checked={selectedTrackIds.includes(tr.id)}
                    onChange={() => handleTogglePartTrack(tr.id)}
                  />
                  <span>
                    {tr.name}（{tr.clef === 'grand' ? '大谱表' : tr.clef === 'bass' ? '低音' : '高音'}）
                  </span>
                </label>
              ))}
            </div>

            <div className="nb-inline-actions">
              <button
                type="button"
                className="nb-btn nb-btn-sm nb-btn-primary"
                data-testid="btn-export-part-selected"
                disabled={busyFormat !== null || selectedTrackIds.length === 0}
                onClick={() => void handleExportTracksPart()}
              >
                导出勾选分谱
              </button>
              {hasTwoVoices && (
                <>
                  <button
                    type="button"
                    className="nb-btn nb-btn-sm"
                    data-testid="btn-export-part-voice-1"
                    disabled={busyFormat !== null}
                    onClick={() => void handleExportVoicePart(0)}
                  >
                    仅导出 Voice 1（右手）
                  </button>
                  <button
                    type="button"
                    className="nb-btn nb-btn-sm"
                    data-testid="btn-export-part-voice-2"
                    disabled={busyFormat !== null}
                    onClick={() => void handleExportVoicePart(1)}
                  >
                    仅导出 Voice 2（左手）
                  </button>
                </>
              )}
            </div>
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
