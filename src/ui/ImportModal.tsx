import { type ChangeEvent, useRef, useState } from 'react';
import { libraryStore } from '../application/library-store.ts';

export interface ImportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const JIANPU_SAMPLE = [
  '标题: 欢乐颂片段',
  '1=C 4/4 BPM=100',
  '3 3 4 5 | 5 4 3 2 | 1 1 2 3 | 3. 2_ 2 - ||',
].join('\n');

export function ImportModal({ isOpen, onClose }: ImportModalProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [jianpuText, setJianpuText] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) {
    return null;
  }

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setBusy(true);
    setErrorMsg(null);
    const buf = await file.arrayBuffer();
    const res = await libraryStore
      .getState()
      .importExternalFile(file.name, new Uint8Array(buf), true);
    setBusy(false);

    if (!res.ok) {
      setErrorMsg(res.error.detail);
      return;
    }
    onClose();
  };

  const handleJianpuImport = async () => {
    setBusy(true);
    setErrorMsg(null);
    const res = await libraryStore.getState().importJianpuText(jianpuText, true);
    setBusy(false);

    if (!res.ok) {
      setErrorMsg(res.error.detail);
      return;
    }
    onClose();
  };

  return (
    <div
      className="nb-modal-backdrop"
      data-testid="import-modal"
      role="dialog"
      aria-modal="true"
      aria-label="导入外部乐谱"
    >
      <div className="nb-modal-card nb-modal-wide">
        <div className="nb-modal-header">
          <h2 className="nb-modal-title">导入外部乐谱与简谱文本</h2>
          <button
            type="button"
            className="nb-btn nb-btn-sm"
            onClick={onClose}
            aria-label="关闭导入弹窗"
          >
            关闭
          </button>
        </div>

        <div className="nb-modal-body">
          <div className="nb-modal-section">
            <span className="nb-modal-label">
              1. 导入乐谱文件（支持 .musicxml / .xml / .mxl / .mid / .json / .txt）
            </span>
            <div className="nb-inline-actions">
              <button
                type="button"
                className="nb-btn nb-btn-primary"
                data-testid="btn-choose-import-file"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
              >
                {busy ? '正在解析导入...' : '选择本地乐谱文件'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".musicxml,.xml,.mxl,.mid,.midi,.json,.txt"
                className="nb-hidden-input"
                data-testid="input-import-external-file"
                onChange={(e) => void handleFileChange(e)}
              />
              <span className="nb-help-text">
                支持从 MuseScore / Finale / Sibelius / Dorico / 来音导出的标准格式
              </span>
            </div>
          </div>

          <div className="nb-modal-section">
            <div className="nb-label-row">
              <span className="nb-modal-label">2. 简谱文本快捷导入</span>
              <button
                type="button"
                className="nb-btn nb-btn-sm"
                data-testid="btn-fill-jianpu-sample"
                onClick={() => setJianpuText(JIANPU_SAMPLE)}
              >
                填入示例
              </button>
            </div>
            <textarea
              className="nb-textarea"
              rows={5}
              data-testid="textarea-jianpu-import"
              placeholder={'例如：\n标题: 小星星\n1=C 4/4 BPM=100\n1 1 5 5 | 6 6 5 - | 4_ 4_ 3_ 3_ 2_ 2_ 1 - ||'}
              value={jianpuText}
              onChange={(e) => setJianpuText(e.target.value)}
            />
            <span className="nb-help-text">
              语法：1–7 音级，0 休止，# / b 升降，&apos; / , 高低八度，_ / __ 减时线，- 增时线，. 附点，| 小节线，||: :|| 反复
            </span>
            <div>
              <button
                type="button"
                className="nb-btn nb-btn-primary"
                data-testid="btn-submit-jianpu-import"
                disabled={busy || jianpuText.trim().length === 0}
                onClick={() => void handleJianpuImport()}
              >
                解析简谱文本并打开
              </button>
            </div>
          </div>

          {errorMsg && (
            <div className="nb-error-banner" data-testid="import-error" role="alert">
              <span>{errorMsg}</span>
            </div>
          )}
        </div>

        <div className="nb-modal-footer">
          <button type="button" className="nb-btn" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
