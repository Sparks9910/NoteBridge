import { workspaceStore } from '../application/workspace-store.ts';

export function PracticeSkeletonBar() {
  return (
    <section
      className="nb-practice-bar"
      data-testid="practice-mode-bar"
      aria-label="练谱模式视图"
    >
      <div className="nb-practice-info">
        <span className="nb-practice-badge">练谱模式</span>
        <span className="nb-practice-desc">
          已隐藏制谱键盘与小节校验告警，当前可专注看谱、点击任意小节起播或实时调整速度 BPM（不修改曲谱保存状态）。
        </span>
      </div>
      <button
        type="button"
        className="nb-btn nb-btn-primary"
        data-testid="btn-practice-to-studio"
        onClick={() => workspaceStore.getState().setWorkMode('studio')}
      >
        返回制谱对照
      </button>
    </section>
  );
}
