import { inputStore, useInputStore } from '../application/input-store.ts';
import { playbackController } from '../application/playback-controller.ts';
import { scoreStore, useScoreStore } from '../application/score-store.ts';
import type { BaseDuration } from '../domain/types.ts';

const DURATION_OPTIONS: ReadonlyArray<{
  value: BaseDuration;
  label: string;
  sub: string;
  testId: string;
}> = [
  { value: 'whole', label: '全音符', sub: '4拍', testId: 'dur-whole' },
  { value: 'half', label: '二分', sub: '2拍', testId: 'dur-half' },
  { value: 'quarter', label: '四分', sub: '1拍', testId: 'dur-quarter' },
  { value: 'eighth', label: '八分', sub: '1/2拍', testId: 'dur-eighth' },
  { value: 'sixteenth', label: '十六分', sub: '1/4拍', testId: 'dur-sixteenth' },
];

const DEGREES: ReadonlyArray<{ degree: 1 | 2 | 3 | 4 | 5 | 6 | 7; solfege: string }> = [
  { degree: 1, solfege: 'do' },
  { degree: 2, solfege: 're' },
  { degree: 3, solfege: 'mi' },
  { degree: 4, solfege: 'fa' },
  { degree: 5, solfege: 'sol' },
  { degree: 6, solfege: 'la' },
  { degree: 7, solfege: 'si' },
];

export function InputKeypad() {
  const padState = useInputStore((s) => s.padState);
  const baseDuration = useInputStore((s) => s.baseDuration);
  const accidental = useInputStore((s) => s.accidental);
  const octaveOffset = useInputStore((s) => s.octaveOffset);
  const dotted = useInputStore((s) => s.dotted);
  const cursor = useInputStore((s) => s.cursor);
  const lastError = useInputStore((s) => s.lastError);

  const measures = useScoreStore((s) => s.document.measures);
  const isLocked = padState === 'LOCKED_BY_PLAYBACK';

  const handleCommitDegree = (
    isRest: boolean,
    degree: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
  ) => {
    const commitRes = inputStore.getState().commitNote();
    if (!commitRes.ok) {
      return;
    }

    const currentCursor = inputStore.getState().cursor;
    const safeMeasureIdx = Math.min(
      currentCursor.measureIndex,
      Math.max(0, measures.length - 1)
    );
    const insertRes = scoreStore.getState().insertNote({
      measureIndex: safeMeasureIdx,
      noteIndex: currentCursor.noteIndex,
      isRest,
      degree,
      octaveOffset: commitRes.value.octaveOffset,
      accidental: commitRes.value.accidental,
      baseDuration: commitRes.value.baseDuration,
      dotted: commitRes.value.dotted,
    });

    if (insertRes.ok) {
      inputStore.getState().setCursor({
        measureIndex: insertRes.value.nextCursor.measureIndex,
        noteIndex: insertRes.value.nextCursor.noteIndex,
        selectedNoteId: null,
      });
      if (!isRest) {
        playbackController.previewNote(insertRes.value.note);
      }
    }
  };

  const handleDelete = () => {
    if (isLocked) {
      return;
    }
    const currentCursor = inputStore.getState().cursor;
    if (currentCursor.selectedNoteId) {
      const res = scoreStore
        .getState()
        .deleteNoteById(currentCursor.selectedNoteId);
      if (res.ok) {
        inputStore.getState().setCursor({
          measureIndex: res.value.nextCursor.measureIndex,
          noteIndex: res.value.nextCursor.noteIndex,
          selectedNoteId: null,
        });
      }
      return;
    }

    if (currentCursor.noteIndex > 0) {
      const res = scoreStore
        .getState()
        .deleteNote(currentCursor.measureIndex, currentCursor.noteIndex - 1);
      if (res.ok) {
        inputStore.getState().setCursor({
          measureIndex: res.value.nextCursor.measureIndex,
          noteIndex: res.value.nextCursor.noteIndex,
          selectedNoteId: null,
        });
      }
      return;
    }

    if (currentCursor.measureIndex > 0) {
      const prevMeasure = measures[currentCursor.measureIndex - 1];
      if (prevMeasure && prevMeasure.notes.length > 0) {
        const res = scoreStore
          .getState()
          .deleteNote(
            currentCursor.measureIndex - 1,
            prevMeasure.notes.length - 1
          );
        if (res.ok) {
          inputStore.getState().setCursor({
            measureIndex: res.value.nextCursor.measureIndex,
            noteIndex: res.value.nextCursor.noteIndex,
            selectedNoteId: null,
          });
        }
      }
    }
  };

  const handleInsertBarline = () => {
    if (isLocked) {
      return;
    }
    const currentCursor = inputStore.getState().cursor;
    const res = scoreStore
      .getState()
      .insertMeasureBar(currentCursor.measureIndex, currentCursor.noteIndex);
    if (res.ok) {
      inputStore.getState().setCursor({
        measureIndex: currentCursor.measureIndex + 1,
        noteIndex: 0,
        selectedNoteId: null,
      });
    }
  };

  const octaveDisplay =
    octaveOffset > 0 ? `+${octaveOffset}` : String(octaveOffset);

  return (
    <section className="nb-keypad" aria-label="虚拟简谱录入面板">
      {isLocked && (
        <div
          className="nb-keypad-locked"
          data-testid="keypad-locked-notice"
          role="status"
        >
          播放期间虚拟输入面板已锁定，停止播放后即可继续录入与编辑
        </div>
      )}

      {lastError && (
        <div
          className="nb-error-banner"
          data-testid="input-error-banner"
          role="alert"
        >
          <span>{lastError.detail}</span>
          <button
            type="button"
            className="nb-btn-close"
            onClick={() => inputStore.getState().clearError()}
            aria-label="关闭输入提示"
          >
            关闭
          </button>
        </div>
      )}

      <div className="nb-keypad-row">
        <div className="nb-keypad-group" role="group" aria-label="音符时值">
          <span className="nb-group-label">时值</span>
          {DURATION_OPTIONS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={`nb-btn nb-dur-btn ${baseDuration === item.value ? 'nb-btn-active' : ''}`}
              data-testid={item.testId}
              aria-pressed={baseDuration === item.value}
              disabled={isLocked}
              onClick={() => inputStore.getState().setBaseDuration(item.value)}
            >
              <span>{item.label}</span>
              <small>{item.sub}</small>
            </button>
          ))}
        </div>

        <div className="nb-keypad-group" role="group" aria-label="临时修饰">
          <span className="nb-group-label">修饰</span>
          <button
            type="button"
            className={`nb-btn ${accidental === 'sharp' ? 'nb-btn-active' : ''}`}
            data-testid="mod-sharp"
            aria-pressed={accidental === 'sharp'}
            disabled={isLocked}
            onClick={() => inputStore.getState().toggleAccidental('sharp')}
          >
            # 升
          </button>
          <button
            type="button"
            className={`nb-btn ${accidental === 'flat' ? 'nb-btn-active' : ''}`}
            data-testid="mod-flat"
            aria-pressed={accidental === 'flat'}
            disabled={isLocked}
            onClick={() => inputStore.getState().toggleAccidental('flat')}
          >
            b 降
          </button>
          <button
            type="button"
            className={`nb-btn ${accidental === 'natural' ? 'nb-btn-active' : ''}`}
            data-testid="mod-natural"
            aria-pressed={accidental === 'natural'}
            disabled={isLocked}
            onClick={() => inputStore.getState().toggleAccidental('natural')}
          >
            ♮ 还原
          </button>

          <button
            type="button"
            className="nb-btn"
            data-testid="mod-octave-down"
            disabled={isLocked || octaveOffset <= -2}
            onClick={() => inputStore.getState().stepOctave(-1)}
          >
            低八度 -
          </button>
          <span className="nb-octave-badge" data-testid="mod-octave-value">
            八度 {octaveDisplay}
          </span>
          <button
            type="button"
            className="nb-btn"
            data-testid="mod-octave-up"
            disabled={isLocked || octaveOffset >= 2}
            onClick={() => inputStore.getState().stepOctave(1)}
          >
            高八度 +
          </button>

          <button
            type="button"
            className={`nb-btn ${dotted ? 'nb-btn-active' : ''}`}
            data-testid="mod-dotted"
            aria-pressed={dotted}
            disabled={isLocked}
            onClick={() => inputStore.getState().toggleDotted()}
          >
            附点 ·
          </button>
          <button
            type="button"
            className="nb-btn"
            data-testid="mod-clear"
            disabled={isLocked || padState !== 'MODIFIER_ARMED'}
            onClick={() => inputStore.getState().clearModifiers()}
          >
            清除修饰
          </button>
        </div>
      </div>

      <div className="nb-keypad-row nb-keypad-digits">
        <div className="nb-digit-grid" role="group" aria-label="音级数字键盘">
          {DEGREES.map((item) => (
            <button
              key={item.degree}
              type="button"
              className="nb-digit-btn"
              data-testid={`key-degree-${item.degree}`}
              disabled={isLocked}
              onClick={() => handleCommitDegree(false, item.degree)}
            >
              <span className="nb-digit-num">{item.degree}</span>
              <span className="nb-digit-solfege">{item.solfege}</span>
            </button>
          ))}
          <button
            type="button"
            className="nb-digit-btn nb-rest-btn"
            data-testid="key-rest-0"
            disabled={isLocked}
            onClick={() => handleCommitDegree(true, 0)}
          >
            <span className="nb-digit-num">0</span>
            <span className="nb-digit-solfege">休止</span>
          </button>
        </div>

        <div className="nb-edit-actions">
          <div className="nb-cursor-info" data-testid="cursor-position-info">
            光标：第 {cursor.measureIndex + 1} 小节 · 第 {cursor.noteIndex + 1} 位
          </div>
          <button
            type="button"
            className="nb-btn nb-btn-danger"
            data-testid="btn-delete-note"
            disabled={isLocked}
            onClick={handleDelete}
          >
            删除音符
          </button>
          <button
            type="button"
            className="nb-btn"
            data-testid="btn-insert-barline"
            disabled={isLocked}
            onClick={handleInsertBarline}
          >
            插入小节线
          </button>
        </div>
      </div>
    </section>
  );
}
