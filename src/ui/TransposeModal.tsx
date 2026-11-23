import { useEffect, useState } from 'react';
import {
  practiceStore,
  usePracticeStore,
} from '../application/practice-store.ts';
import {
  KEY_SIGNATURE_OPTIONS,
  scoreStore,
  useScoreStore,
} from '../application/score-store.ts';
import {
  computeSemitoneDelta,
  type TransposeStrategy,
} from '../domain/transpose.ts';
import type { KeySignature } from '../domain/types.ts';

export interface TransposeModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function TransposeModal({ isOpen, onClose }: TransposeModalProps) {
  const currentKey = useScoreStore((s) => s.document.keySignature);
  const capo = usePracticeStore((s) => s.capo);
  const [strategy, setStrategy] = useState<TransposeStrategy>('movable-do');
  const [targetKey, setTargetKey] = useState<KeySignature>(currentKey);
  const [semitones, setSemitones] = useState<number>(0);

  useEffect(() => {
    if (isOpen) {
      setTargetKey(currentKey);
      setSemitones(0);
    }
  }, [isOpen, currentKey]);

  if (!isOpen) {
    return null;
  }

  const movableDelta = computeSemitoneDelta(currentKey, targetKey);

  const handleApply = () => {
    const res =
      strategy === 'movable-do'
        ? scoreStore.getState().transposeScore({
            strategy: 'movable-do',
            targetKey,
          })
        : scoreStore.getState().transposeScore({
            strategy: 'fixed-pitch',
            semitones,
          });
    if (res.ok) {
      onClose();
    }
  };

  return (
    <div
      className="nb-modal-backdrop"
      data-testid="transpose-modal"
      role="dialog"
      aria-modal="true"
      aria-label="一键移调"
    >
      <div className="nb-modal-card">
        <div className="nb-modal-header">
          <h2 className="nb-modal-title">一键移调</h2>
          <button
            type="button"
            className="nb-btn nb-btn-sm"
            onClick={onClose}
            aria-label="关闭移调弹窗"
          >
            关闭
          </button>
        </div>

        <div className="nb-modal-body">
          <div className="nb-modal-section">
            <span className="nb-modal-label">移调策略</span>
            <div className="nb-radio-group">
              <label className="nb-radio-option">
                <input
                  type="radio"
                  name="transpose-strategy"
                  data-testid="transpose-strategy-movable"
                  checked={strategy === 'movable-do'}
                  onChange={() => setStrategy('movable-do')}
                />
                <div>
                  <strong>首调换调（唱名不变）</strong>
                  <p className="nb-help-text">
                    保持简谱 1–7 唱名不变，仅更换调号（1={currentKey} → 1=
                    {targetKey}），五线谱与试听音高同步移调。
                  </p>
                </div>
              </label>

              <label className="nb-radio-option">
                <input
                  type="radio"
                  name="transpose-strategy"
                  data-testid="transpose-strategy-fixed"
                  checked={strategy === 'fixed-pitch'}
                  onChange={() => setStrategy('fixed-pitch')}
                />
                <div>
                  <strong>固定调按半音移高（调号不变）</strong>
                  <p className="nb-help-text">
                    保持当前调号 1={currentKey} 不变，所有音符绝对音高整体升降并重算简谱音级与升降号。
                  </p>
                </div>
              </label>
            </div>
          </div>

          {strategy === 'movable-do' ? (
            <div className="nb-modal-section">
              <label className="nb-field">
                <span className="nb-modal-label">目标调号</span>
                <select
                  className="nb-select"
                  data-testid="transpose-target-key"
                  value={targetKey}
                  onChange={(e) => setTargetKey(e.target.value as KeySignature)}
                >
                  {KEY_SIGNATURE_OPTIONS.map((k) => (
                    <option key={k} value={k}>
                      1 = {k}
                    </option>
                  ))}
                </select>
              </label>
              <div className="nb-modal-summary" data-testid="transpose-summary">
                当前 1={currentKey} → 目标 1={targetKey}（最短半音差：
                {movableDelta > 0 ? `+${movableDelta}` : movableDelta} 半音）
              </div>
            </div>
          ) : (
            <div className="nb-modal-section">
              <span className="nb-modal-label">半音偏移量（-12 到 +12）</span>
              <div className="nb-stepper">
                <button
                  type="button"
                  className="nb-btn"
                  data-testid="transpose-semitone-dec"
                  disabled={semitones <= -12}
                  onClick={() => setSemitones((v) => Math.max(-12, v - 1))}
                >
                  -1 半音
                </button>
                <span
                  className="nb-stepper-value"
                  data-testid="transpose-semitone-value"
                >
                  {semitones > 0 ? `+${semitones}` : semitones} 半音
                </span>
                <button
                  type="button"
                  className="nb-btn"
                  data-testid="transpose-semitone-inc"
                  disabled={semitones >= 12}
                  onClick={() => setSemitones((v) => Math.min(12, v + 1))}
                >
                  +1 半音
                </button>
              </div>
              <div className="nb-modal-summary" data-testid="transpose-summary">
                保持 1={currentKey}，全谱非休止音符音高整体偏移{' '}
                {semitones > 0 ? `+${semitones}` : semitones} 半音（支持撤销恢复）。
              </div>
            </div>
          )}

          <div className="nb-modal-section">
            <label className="nb-field">
              <span className="nb-modal-label">吉他变调夹快捷联动（不改原谱，不标脏）</span>
              <select
                className="nb-select"
                data-testid="transpose-capo-select"
                value={capo}
                onChange={(e) =>
                  practiceStore.getState().setCapo(Number(e.target.value))
                }
              >
                {Array.from({ length: 13 }, (_, i) => (
                  <option key={i} value={i}>
                    {i === 0 ? '无变调夹 (0品)' : `Capo ${i} 品`}
                  </option>
                ))}
              </select>
            </label>
            <p className="nb-help-text">
              提示：应用一键移调后，练谱模式下的吉他六线谱与指板把位将自动按最小把位移动重新计算。
            </p>
          </div>
        </div>

        <div className="nb-modal-footer">
          <button type="button" className="nb-btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="nb-btn nb-btn-primary"
            data-testid="btn-apply-transpose"
            onClick={handleApply}
          >
            应用移调
          </button>
        </div>
      </div>
    </div>
  );
}
