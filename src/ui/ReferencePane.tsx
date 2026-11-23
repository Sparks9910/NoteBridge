import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { libraryStore } from '../application/library-store.ts';
import { notationStore, useNotationStore } from '../application/notation-store.ts';
import { useScoreStore } from '../application/score-store.ts';
import { useWorkspaceStore } from '../application/workspace-store.ts';

export function ReferencePane() {
  const referenceSource = useNotationStore((s) => s.referenceSource);
  const referenceZoom = useNotationStore((s) => s.referenceZoom);
  const doc = useScoreStore((s) => s.document);
  const activeMeta = useWorkspaceStore((s) => s.activeMeta);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    let createdUrl: string | null = null;

    if (!referenceSource) {
      setObjectUrl(null);
      return;
    }

    void libraryStore
      .getState()
      .loadScoreReference(referenceSource.id)
      .then((res) => {
        if (!active) return;
        if (!res.ok) {
          setErrorMsg(res.error.detail);
          setObjectUrl(null);
          return;
        }
        const blob = new Blob([new Uint8Array(res.value.data)], {
          type: res.value.meta.mimeType || 'application/octet-stream',
        });
        createdUrl = URL.createObjectURL(blob);
        setObjectUrl(createdUrl);
        setErrorMsg(null);
      });

    return () => {
      active = false;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [referenceSource]);

  const handleUploadChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setBusy(true);
    setErrorMsg(null);
    const buffer = await file.arrayBuffer();
    const res = await libraryStore.getState().saveScoreReference(doc, activeMeta, {
      name: file.name,
      mimeType: file.type,
      data: new Uint8Array(buffer),
    });
    setBusy(false);
    if (!res.ok) {
      setErrorMsg(res.error.detail);
    }
  };

  const handleRemove = async () => {
    setBusy(true);
    setErrorMsg(null);
    const res = await libraryStore.getState().removeScoreReference(doc, activeMeta);
    setBusy(false);
    if (!res.ok) {
      setErrorMsg(res.error.detail);
    }
  };

  const isPdf =
    referenceSource?.mimeType === 'application/pdf' ||
    referenceSource?.name.toLowerCase().endsWith('.pdf');

  return (
    <aside
      className="nb-reference-pane"
      data-testid="reference-pane"
      aria-label="原谱对照分屏"
    >
      <div className="nb-reference-header">
        <div className="nb-reference-title-wrap">
          <strong className="nb-reference-title">原谱对照</strong>
          <span className="nb-reference-badge">纯本地存储</span>
        </div>

        <div className="nb-reference-actions">
          {referenceSource && !isPdf && (
            <div className="nb-reference-zoom">
              <button
                type="button"
                className="nb-btn nb-btn-sm"
                data-testid="btn-ref-zoom-out"
                onClick={() => notationStore.getState().setReferenceZoom(referenceZoom - 15)}
              >
                -
              </button>
              <span className="nb-ref-zoom-text" data-testid="ref-zoom-value">
                {referenceZoom}%
              </span>
              <button
                type="button"
                className="nb-btn nb-btn-sm"
                data-testid="btn-ref-zoom-in"
                onClick={() => notationStore.getState().setReferenceZoom(referenceZoom + 15)}
              >
                +
              </button>
            </div>
          )}

          <button
            type="button"
            className="nb-btn nb-btn-sm"
            data-testid="btn-upload-reference"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            {referenceSource ? '替换原谱' : '上传原谱'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf,.pdf"
            className="nb-hidden-input"
            data-testid="input-reference-upload"
            onChange={(e) => void handleUploadChange(e)}
          />

          {referenceSource && (
            <button
              type="button"
              className="nb-btn nb-btn-sm nb-btn-danger"
              data-testid="btn-remove-reference"
              disabled={busy}
              onClick={() => void handleRemove()}
            >
              移除
            </button>
          )}

          <button
            type="button"
            className="nb-btn nb-btn-sm"
            data-testid="btn-close-reference"
            onClick={() => notationStore.getState().toggleReferencePanel(false)}
          >
            收起
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="nb-error-banner" data-testid="reference-error" role="alert">
          <span>{errorMsg}</span>
        </div>
      )}

      <div className="nb-reference-body">
        {!referenceSource || !objectUrl ? (
          <div className="nb-reference-empty" data-testid="reference-empty">
            <p>支持本地选择乐谱图片（PNG / JPG / WebP）或 PDF 文件进行同屏核对。</p>
            <p className="nb-help-text">
              原谱文件仅存入浏览器本地 IndexedDB，绝不上传外网；自动识谱（OMR）将于 V2.3 接入。
            </p>
            <button
              type="button"
              className="nb-btn nb-btn-primary"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
            >
              选择本地图片或 PDF
            </button>
          </div>
        ) : isPdf ? (
          <iframe
            title={referenceSource.name}
            src={objectUrl}
            className="nb-ref-pdf"
            data-testid="reference-pdf-viewer"
          />
        ) : (
          <div className="nb-ref-img-scroll">
            <img
              src={objectUrl}
              alt={referenceSource.name}
              className="nb-ref-img"
              data-testid="reference-image-viewer"
              style={{ width: `${referenceZoom}%` }}
            />
          </div>
        )}
      </div>
    </aside>
  );
}
