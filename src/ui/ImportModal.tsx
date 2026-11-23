import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { libraryStore } from '../application/library-store.ts';
import {
  checkOmrProviderHealth,
  DEFAULT_LOCAL_OMR_ENDPOINT,
  loadFileAsReferenceOnly,
  loadSavedOmrConfig,
  type OmrFileInput,
  type OmrHealthStatus,
  type OmrProviderType,
  recognizeScoreWithOmrAndAttachReference,
  saveOmrConfig,
} from '../application/omr-service.ts';

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
  const omrFileInputRef = useRef<HTMLInputElement | null>(null);

  const [activeTab, setActiveTab] = useState<'standard' | 'omr'>('standard');
  const [jianpuText, setJianpuText] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [providerType, setProviderType] =
    useState<OmrProviderType>('local-bridge');
  const [endpointUrl, setEndpointUrl] = useState(DEFAULT_LOCAL_OMR_ENDPOINT);
  const [apiKey, setApiKey] = useState('');
  const [healthStatus, setHealthStatus] = useState<OmrHealthStatus | null>(null);
  const [omrFile, setOmrFile] = useState<OmrFileInput | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const saved = loadSavedOmrConfig();
    setProviderType(saved.providerType);
    setEndpointUrl(saved.endpointUrl);
    setApiKey(saved.apiKey ?? '');
    setErrorMsg(null);
    setHealthStatus(null);
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  const persistOmrConfig = (
    nextType: OmrProviderType,
    nextUrl: string,
    nextKey: string
  ) => {
    saveOmrConfig({
      providerType: nextType,
      endpointUrl: nextUrl,
      apiKey: nextKey,
    });
  };

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

  const handleOmrFileSelect = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const buf = await file.arrayBuffer();
    setOmrFile({
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      data: new Uint8Array(buf),
    });
    setErrorMsg(null);
  };

  const handleCheckHealth = async () => {
    setBusy(true);
    setErrorMsg(null);
    const cfg = { providerType, endpointUrl, apiKey };
    saveOmrConfig(cfg);
    const status = await checkOmrProviderHealth(cfg);
    setHealthStatus(status);
    setBusy(false);
  };

  const handleOmrRecognize = async () => {
    if (!omrFile) {
      setErrorMsg('请先选择需要智能识谱的 PNG/JPG/WebP 图片或 PDF 文件');
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    const cfg = { providerType, endpointUrl, apiKey };
    saveOmrConfig(cfg);
    const res = await recognizeScoreWithOmrAndAttachReference(omrFile, cfg);
    setBusy(false);

    if (!res.ok) {
      setErrorMsg(res.error.detail);
      return;
    }
    onClose();
  };

  const handleReferenceOnlyFallback = async () => {
    if (!omrFile) {
      setErrorMsg('请先选择图片或 PDF 原谱文件，再载入为原谱对照');
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    const res = await loadFileAsReferenceOnly(omrFile);
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
          <h2 className="nb-modal-title">导入外部乐谱与智能转谱</h2>
          <button
            type="button"
            className="nb-btn nb-btn-sm"
            onClick={onClose}
            aria-label="关闭导入弹窗"
          >
            关闭
          </button>
        </div>

        <div className="nb-modal-tabs" role="tablist" aria-label="导入方式">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'standard'}
            className={`nb-tab-btn ${activeTab === 'standard' ? 'nb-tab-active' : ''}`}
            data-testid="import-tab-standard"
            onClick={() => {
              setActiveTab('standard');
              setErrorMsg(null);
            }}
          >
            乐谱文件与简谱文本
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'omr'}
            className={`nb-tab-btn ${activeTab === 'omr' ? 'nb-tab-active' : ''}`}
            data-testid="import-tab-omr"
            onClick={() => {
              setActiveTab('omr');
              setErrorMsg(null);
            }}
          >
            图片/PDF 智能转谱（OMR）
          </button>
        </div>

        <div className="nb-modal-body">
          {activeTab === 'standard' && (
            <>
              <div className="nb-modal-section">
                <span className="nb-modal-label">
                  1. 导入乐谱文件（支持 .musicxml / .xml / .mxl / .mid / .gp / .gp5 / .gpx / .json / .txt）
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
                    accept=".musicxml,.xml,.mxl,.mid,.midi,.gp,.gp5,.gpx,.json,.txt"
                    className="nb-hidden-input"
                    data-testid="input-import-external-file"
                    onChange={(e) => void handleFileChange(e)}
                  />
                  <span className="nb-help-text">
                    支持 MuseScore / Guitar Pro（.gp/.gp5/.gpx）/ MIDI / MusicXML 标准格式，零限制免费导入
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
            </>
          )}

          {activeTab === 'omr' && (
            <div className="nb-omr-panel" data-testid="import-panel-omr">
              <div className="nb-omr-guide">
                <strong>可插拔本地开源 OMR 识谱（零付费墙 / 不限页数）：</strong>
                <span>
                  支持对接本机开源 Audiveris / Homr HTTP 桥接服务或自定义识谱端点。识谱成功后将自动生成可编辑乐谱，并把原始图片/PDF 存入本地 IndexedDB 自动开启「原谱对照」分屏。若暂未启动识谱引擎，可随时点击「仅载入为原谱对照」进行边看边录。
                </span>
              </div>

              <div className="nb-omr-config-grid">
                <label className="nb-field">
                  <span className="nb-field-label">识谱适配器</span>
                  <select
                    className="nb-select"
                    data-testid="omr-provider-type"
                    value={providerType}
                    onChange={(e) => {
                      const nextType = e.target.value as OmrProviderType;
                      const nextUrl =
                        nextType === 'local-bridge' && !endpointUrl.trim()
                          ? DEFAULT_LOCAL_OMR_ENDPOINT
                          : endpointUrl;
                      setProviderType(nextType);
                      setEndpointUrl(nextUrl);
                      persistOmrConfig(nextType, nextUrl, apiKey);
                    }}
                  >
                    <option value="local-bridge">本地开源 OMR 桥接（Audiveris / Homr）</option>
                    <option value="custom-endpoint">自定义远程 OMR 端点</option>
                  </select>
                </label>

                <label className="nb-field">
                  <span className="nb-field-label">服务地址</span>
                  <input
                    type="text"
                    className="nb-input"
                    data-testid="omr-endpoint-input"
                    placeholder="http://127.0.0.1:8765"
                    value={endpointUrl}
                    onChange={(e) => {
                      setEndpointUrl(e.target.value);
                      persistOmrConfig(providerType, e.target.value, apiKey);
                    }}
                  />
                </label>

                <label className="nb-field">
                  <span className="nb-field-label">访问密钥（可选）</span>
                  <input
                    type="password"
                    className="nb-input"
                    data-testid="omr-apikey-input"
                    placeholder="本地开源桥接无需填写"
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      persistOmrConfig(providerType, endpointUrl, e.target.value);
                    }}
                  />
                </label>

                <button
                  type="button"
                  className="nb-btn"
                  data-testid="btn-omr-check-health"
                  disabled={busy}
                  onClick={() => void handleCheckHealth()}
                >
                  检测服务连接
                </button>
              </div>

              {healthStatus && (
                <div
                  className={
                    healthStatus.available
                      ? 'nb-info-banner'
                      : 'nb-warning-banner'
                  }
                  data-testid="omr-health-status"
                  role="status"
                >
                  <span>{healthStatus.message}</span>
                </div>
              )}

              <div className="nb-modal-section">
                <span className="nb-modal-label">选择乐谱图片或 PDF 文件（PNG / JPG / WebP / PDF）</span>
                <div className="nb-inline-actions">
                  <button
                    type="button"
                    className="nb-btn"
                    data-testid="btn-choose-omr-file"
                    disabled={busy}
                    onClick={() => omrFileInputRef.current?.click()}
                  >
                    选择图片 / PDF 原谱
                  </button>
                  <input
                    ref={omrFileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,application/pdf,.png,.jpg,.jpeg,.webp,.pdf"
                    className="nb-hidden-input"
                    data-testid="input-omr-file"
                    onChange={(e) => void handleOmrFileSelect(e)}
                  />
                  <span className="nb-help-text" data-testid="omr-selected-file">
                    {omrFile
                      ? `已选择：${omrFile.name} (${Math.max(1, Math.round(omrFile.data.byteLength / 1024))} KB)`
                      : '尚未选择文件'}
                  </span>
                </div>
              </div>

              <div className="nb-inline-actions">
                <button
                  type="button"
                  className="nb-btn nb-btn-primary"
                  data-testid="btn-omr-recognize"
                  disabled={busy || !omrFile}
                  onClick={() => void handleOmrRecognize()}
                >
                  {busy ? '正在识谱处理...' : '智能识谱并开启原谱对照'}
                </button>
                <button
                  type="button"
                  className="nb-btn"
                  data-testid="btn-omr-reference-only"
                  disabled={busy || !omrFile}
                  onClick={() => void handleReferenceOnlyFallback()}
                >
                  仅载入为原谱对照
                </button>
              </div>
            </div>
          )}

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
