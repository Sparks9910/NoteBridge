import { useEffect, useState } from 'react';
import { inputStore, useInputStore } from '../application/input-store.ts';
import {
  type KeypadTabId,
  notationStore,
  useNotationStore,
} from '../application/notation-store.ts';
import { playbackController } from '../application/playback-controller.ts';
import {
  KEY_SIGNATURE_OPTIONS,
  scoreStore,
  TIME_SIGNATURE_OPTIONS,
  useScoreStore,
} from '../application/score-store.ts';
import type { BaseDuration, KeySignature, TimeSignature } from '../domain/types.ts';
import type {
  DynamicMarking,
  InstrumentId,
  MeasureBarlineType,
  OrnamentType,
  Track,
} from '../domain/v2-types.ts';

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

const KEYPAD_TABS: ReadonlyArray<{ id: KeypadTabId; label: string }> = [
  { id: 'input', label: '录入' },
  { id: 'setup', label: '谱/调/拍/速' },
  { id: 'measure', label: '小节' },
  { id: 'markings', label: '线与记号' },
  { id: 'lyrics', label: '歌词' },
  { id: 'fingering', label: '指法' },
  { id: 'voices', label: '声部与轨道' },
];

const DYNAMICS_OPTIONS: ReadonlyArray<DynamicMarking> = [
  'pp',
  'p',
  'mp',
  'mf',
  'f',
  'ff',
  'fp',
];

const ORNAMENT_OPTIONS: ReadonlyArray<{ value: OrnamentType; label: string }> = [
  { value: 'trill', label: 'tr 颤音' },
  { value: 'staccato', label: '• 跳音' },
  { value: 'accent', label: '> 重音' },
  { value: 'fermata', label: '𝄐 延长' },
];

const FINGERING_PIANO = ['1', '2', '3', '4', '5'] as const;
const FINGERING_GUITAR = ['p', 'i', 'm', 'a'] as const;

export function InputKeypad() {
  const padState = useInputStore((s) => s.padState);
  const baseDuration = useInputStore((s) => s.baseDuration);
  const accidental = useInputStore((s) => s.accidental);
  const octaveOffset = useInputStore((s) => s.octaveOffset);
  const dotted = useInputStore((s) => s.dotted);
  const cursor = useInputStore((s) => s.cursor);
  const lastError = useInputStore((s) => s.lastError);

  const doc = useScoreStore((s) => s.document);
  const measures = doc.measures;
  const isLocked = padState === 'LOCKED_BY_PLAYBACK';

  const activeTab = useNotationStore((s) => s.activeKeypadTab);
  const isCollapsed = useNotationStore((s) => s.isKeypadCollapsed);
  const clef = useNotationStore((s) => s.clef);
  const activeVoiceIndex = useNotationStore((s) => s.activeVoiceIndex);
  const activeTrackIndex = useNotationStore((s) => s.activeTrackIndex);
  const tracks = useNotationStore((s) => s.tracks);
  const noteExtrasById = useNotationStore((s) => s.noteExtrasById);
  const measureExtrasByIndex = useNotationStore((s) => s.measureExtrasByIndex);

  const resolveTargetNoteId = (): string | null => {
    if (cursor.selectedNoteId) {
      return cursor.selectedNoteId;
    }
    const m = measures[cursor.measureIndex];
    if (m && m.notes.length > 0) {
      const idx = cursor.noteIndex > 0 ? cursor.noteIndex - 1 : 0;
      const hit = m.notes[Math.min(idx, m.notes.length - 1)]?.id;
      if (hit) return hit;
    }
    for (let mIdx = cursor.measureIndex - 1; mIdx >= 0; mIdx -= 1) {
      const prev = measures[mIdx];
      if (prev && prev.notes.length > 0) {
        return prev.notes[prev.notes.length - 1]?.id ?? null;
      }
    }
    for (let mIdx = cursor.measureIndex + 1; mIdx < measures.length; mIdx += 1) {
      const next = measures[mIdx];
      if (next && next.notes.length > 0) {
        return next.notes[0]?.id ?? null;
      }
    }
    return null;
  };

  const targetNoteId = resolveTargetNoteId();
  const targetExtra = targetNoteId ? noteExtrasById[targetNoteId] : undefined;
  const currentMeasureExtra = measureExtrasByIndex[cursor.measureIndex];

  const [lyricDraft, setLyricDraft] = useState('');
  const [newTrackName, setNewTrackName] = useState('');
  const [newTrackInstrument, setNewTrackInstrument] = useState<InstrumentId>('piano');

  useEffect(() => {
    setLyricDraft(targetExtra?.lyric ?? '');
  }, [targetNoteId, targetExtra?.lyric]);

  const handleStepSelection = (delta: -1 | 1) => {
    const flatIds: Array<{ mIdx: number; nIdx: number; id: string }> = [];
    measures.forEach((m, mIdx) => {
      m.notes.forEach((n, nIdx) => {
        flatIds.push({ mIdx, nIdx, id: n.id });
      });
    });
    if (flatIds.length === 0) return;

    const currIdx = targetNoteId
      ? flatIds.findIndex((item) => item.id === targetNoteId)
      : -1;
    const nextIdx =
      currIdx === -1
        ? 0
        : Math.max(0, Math.min(flatIds.length - 1, currIdx + delta));
    const target = flatIds[nextIdx];
    if (!target) return;
    inputStore.getState().setCursor({
      measureIndex: target.mIdx,
      noteIndex: target.nIdx + 1,
      selectedNoteId: target.id,
    });
  };

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

    if (activeVoiceIndex === 1) {
      notationStore.getState().bindScoreId(doc.id);
      const v2Res = notationStore.getState().insertVoice2Note({
        measureIndex: safeMeasureIdx,
        isRest,
        degree,
        octaveOffset: commitRes.value.octaveOffset,
        accidental: commitRes.value.accidental,
        baseDuration: commitRes.value.baseDuration,
        dotted: commitRes.value.dotted,
        keySignature: doc.keySignature,
      });
      if (v2Res.ok && !isRest) {
        playbackController.previewNote({
          id: v2Res.value.id,
          isRest: false,
          degree: degree as 1 | 2 | 3 | 4 | 5 | 6 | 7,
          octaveOffset: commitRes.value.octaveOffset,
          accidental: commitRes.value.accidental,
          baseDuration: commitRes.value.baseDuration,
          dotted: commitRes.value.dotted,
          durationTicks: v2Res.value.durationTicks,
        });
      }
      return;
    }

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

    if (activeVoiceIndex === 1) {
      if (currentCursor.selectedNoteId?.startsWith('v2_')) {
        void notationStore
          .getState()
          .deleteVoice2NoteById(currentCursor.selectedNoteId);
        inputStore.getState().setCursor({ selectedNoteId: null });
      } else {
        void notationStore.getState().deleteVoice2Note(currentCursor.measureIndex);
      }
      return;
    }

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

  const handleApplyLyric = () => {
    if (!targetNoteId) return;
    notationStore.getState().bindScoreId(doc.id);
    notationStore.getState().setNoteExtra(targetNoteId, {
      lyric: lyricDraft.trim() || undefined,
    });
    handleStepSelection(1);
  };

  const octaveDisplay =
    octaveOffset > 0 ? `+${octaveOffset}` : String(octaveOffset);

  return (
    <section className="nb-keypad" aria-label="专业制谱控制面板">
      <div className="nb-keypad-tabbar">
        <div className="nb-keypad-tabs" role="tablist" aria-label="制谱工具标签页">
          {KEYPAD_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`nb-tab-btn ${activeTab === tab.id ? 'nb-tab-active' : ''}`}
              data-testid={`tab-keypad-${tab.id}`}
              onClick={() => notationStore.getState().setActiveKeypadTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="nb-keypad-tabbar-right">
          <span
            className={`nb-voice-pill ${activeVoiceIndex === 1 ? 'nb-voice-pill-v2' : ''}`}
            data-testid="active-voice-indicator"
          >
            {activeVoiceIndex === 0 ? 'Voice 1 主旋律' : 'Voice 2 低音/左手'}
          </span>
          <button
            type="button"
            className="nb-btn nb-btn-sm"
            data-testid="btn-toggle-keypad-collapse"
            onClick={() => notationStore.getState().setKeypadCollapsed()}
          >
            {isCollapsed ? '展开面板' : '收起面板'}
          </button>
        </div>
      </div>

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

      {!isCollapsed && activeTab === 'input' && (
        <>
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
                className="nb-btn nb-btn-sm"
                data-testid="btn-nav-prev-note"
                disabled={isLocked}
                onClick={() => handleStepSelection(-1)}
              >
                ← 上一音
              </button>
              <button
                type="button"
                className="nb-btn nb-btn-sm"
                data-testid="btn-nav-next-note"
                disabled={isLocked}
                onClick={() => handleStepSelection(1)}
              >
                下一音 →
              </button>
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
        </>
      )}

      {!isCollapsed && activeTab === 'setup' && (
        <div className="nb-tab-panel" data-testid="panel-keypad-setup">
          <div className="nb-keypad-group">
            <span className="nb-group-label">谱表类型</span>
            {(
              [
                { value: 'treble', label: '高音谱表', testId: 'btn-clef-treble' },
                { value: 'bass', label: '低音谱表', testId: 'btn-clef-bass' },
                { value: 'grand', label: '钢琴大谱表（高+低）', testId: 'btn-clef-grand' },
              ] as ReadonlyArray<{ value: Track['clef']; label: string; testId: string }>
            ).map((c) => (
              <button
                key={c.value}
                type="button"
                className={`nb-btn ${clef === c.value ? 'nb-btn-active' : ''}`}
                data-testid={c.testId}
                disabled={isLocked}
                onClick={() => {
                  notationStore.getState().bindScoreId(doc.id);
                  notationStore.getState().setClef(c.value, measures.length);
                }}
              >
                {c.label}
              </button>
            ))}
          </div>

          <div className="nb-keypad-group">
            <span className="nb-group-label">调号与拍号</span>
            <select
              className="nb-select"
              aria-label="面板调号"
              value={doc.keySignature}
              disabled={isLocked}
              onChange={(e) =>
                scoreStore.getState().setKeySignature(e.target.value as KeySignature)
              }
            >
              {KEY_SIGNATURE_OPTIONS.map((k) => (
                <option key={k} value={k}>
                  1 = {k}
                </option>
              ))}
            </select>
            <select
              className="nb-select"
              aria-label="面板拍号"
              value={doc.timeSignature}
              disabled={isLocked}
              onChange={(e) =>
                scoreStore.getState().setTimeSignature(e.target.value as TimeSignature)
              }
            >
              {TIME_SIGNATURE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <span className="nb-help-text">当前速度：{doc.bpm} BPM</span>
          </div>
        </div>
      )}

      {!isCollapsed && activeTab === 'measure' && (
        <div className="nb-tab-panel" data-testid="panel-keypad-measure">
          <div className="nb-keypad-group">
            <span className="nb-group-label">当前第 {cursor.measureIndex + 1} 小节</span>
            <button
              type="button"
              className={`nb-btn ${currentMeasureExtra?.repeatStart ? 'nb-btn-active' : ''}`}
              data-testid="btn-measure-repeat-start"
              onClick={() => {
                notationStore.getState().bindScoreId(doc.id);
                notationStore.getState().setMeasureExtra(cursor.measureIndex, {
                  repeatStart: !currentMeasureExtra?.repeatStart,
                });
              }}
            >
              ||: 反复开始
            </button>
            <button
              type="button"
              className={`nb-btn ${currentMeasureExtra?.repeatEnd ? 'nb-btn-active' : ''}`}
              data-testid="btn-measure-repeat-end"
              onClick={() => {
                notationStore.getState().bindScoreId(doc.id);
                notationStore.getState().setMeasureExtra(cursor.measureIndex, {
                  repeatEnd: !currentMeasureExtra?.repeatEnd,
                });
              }}
            >
              :|| 反复结束
            </button>

            <button
              type="button"
              className={`nb-btn ${currentMeasureExtra?.barline === 'double' ? 'nb-btn-active' : ''}`}
              data-testid="btn-barline-double"
              onClick={() => {
                notationStore.getState().bindScoreId(doc.id);
                const nextBar: MeasureBarlineType =
                  currentMeasureExtra?.barline === 'double' ? 'single' : 'double';
                notationStore.getState().setMeasureExtra(cursor.measureIndex, {
                  barline: nextBar,
                });
              }}
            >
              || 双纵线
            </button>
            <button
              type="button"
              className={`nb-btn ${currentMeasureExtra?.barline === 'final' ? 'nb-btn-active' : ''}`}
              data-testid="btn-barline-final"
              onClick={() => {
                notationStore.getState().bindScoreId(doc.id);
                const nextBar: MeasureBarlineType =
                  currentMeasureExtra?.barline === 'final' ? 'single' : 'final';
                notationStore.getState().setMeasureExtra(cursor.measureIndex, {
                  barline: nextBar,
                });
              }}
            >
              终止线
            </button>

            <button
              type="button"
              className={`nb-btn ${currentMeasureExtra?.ending === 1 ? 'nb-btn-active' : ''}`}
              data-testid="btn-ending-1"
              onClick={() => {
                notationStore.getState().bindScoreId(doc.id);
                notationStore.getState().setMeasureExtra(cursor.measureIndex, {
                  ending: currentMeasureExtra?.ending === 1 ? undefined : 1,
                });
              }}
            >
              1. 跳房子
            </button>
            <button
              type="button"
              className={`nb-btn ${currentMeasureExtra?.ending === 2 ? 'nb-btn-active' : ''}`}
              data-testid="btn-ending-2"
              onClick={() => {
                notationStore.getState().bindScoreId(doc.id);
                notationStore.getState().setMeasureExtra(cursor.measureIndex, {
                  ending: currentMeasureExtra?.ending === 2 ? undefined : 2,
                });
              }}
            >
              2. 跳房子
            </button>
          </div>
        </div>
      )}

      {!isCollapsed && activeTab === 'markings' && (
        <div className="nb-tab-panel" data-testid="panel-keypad-markings">
          <div className="nb-keypad-group">
            <span className="nb-group-label">强弱</span>
            {DYNAMICS_OPTIONS.map((dyn) => (
              <button
                key={dyn}
                type="button"
                className={`nb-btn nb-btn-sm ${targetExtra?.dynamic === dyn ? 'nb-btn-active' : ''}`}
                data-testid={`btn-dynamic-${dyn}`}
                disabled={!targetNoteId}
                onClick={() => {
                  if (!targetNoteId) return;
                  notationStore.getState().bindScoreId(doc.id);
                  notationStore.getState().setNoteExtra(targetNoteId, {
                    dynamic: targetExtra?.dynamic === dyn ? undefined : dyn,
                  });
                }}
              >
                {dyn}
              </button>
            ))}
          </div>

          <div className="nb-keypad-group">
            <span className="nb-group-label">装饰与连线</span>
            {ORNAMENT_OPTIONS.map((orn) => (
              <button
                key={orn.value}
                type="button"
                className={`nb-btn nb-btn-sm ${targetExtra?.ornament === orn.value ? 'nb-btn-active' : ''}`}
                data-testid={`btn-ornament-${orn.value}`}
                disabled={!targetNoteId}
                onClick={() => {
                  if (!targetNoteId) return;
                  notationStore.getState().bindScoreId(doc.id);
                  notationStore.getState().setNoteExtra(targetNoteId, {
                    ornament:
                      targetExtra?.ornament === orn.value ? undefined : orn.value,
                  });
                }}
              >
                {orn.label}
              </button>
            ))}

            <button
              type="button"
              className={`nb-btn nb-btn-sm ${targetExtra?.tieStart ? 'nb-btn-active' : ''}`}
              data-testid="btn-tie-start"
              disabled={!targetNoteId}
              onClick={() => {
                if (!targetNoteId) return;
                notationStore.getState().bindScoreId(doc.id);
                notationStore.getState().setNoteExtra(targetNoteId, {
                  tieStart: !targetExtra?.tieStart,
                });
              }}
            >
              延音起点
            </button>
            <button
              type="button"
              className={`nb-btn nb-btn-sm ${targetExtra?.tieEnd ? 'nb-btn-active' : ''}`}
              data-testid="btn-tie-end"
              disabled={!targetNoteId}
              onClick={() => {
                if (!targetNoteId) return;
                notationStore.getState().bindScoreId(doc.id);
                notationStore.getState().setNoteExtra(targetNoteId, {
                  tieEnd: !targetExtra?.tieEnd,
                });
              }}
            >
              延音终点
            </button>
            <button
              type="button"
              className={`nb-btn nb-btn-sm ${targetExtra?.slurStart ? 'nb-btn-active' : ''}`}
              data-testid="btn-slur-start"
              disabled={!targetNoteId}
              onClick={() => {
                if (!targetNoteId) return;
                notationStore.getState().bindScoreId(doc.id);
                notationStore.getState().setNoteExtra(targetNoteId, {
                  slurStart: !targetExtra?.slurStart,
                });
              }}
            >
              连音起点
            </button>
            <button
              type="button"
              className={`nb-btn nb-btn-sm ${targetExtra?.slurEnd ? 'nb-btn-active' : ''}`}
              data-testid="btn-slur-end"
              disabled={!targetNoteId}
              onClick={() => {
                if (!targetNoteId) return;
                notationStore.getState().bindScoreId(doc.id);
                notationStore.getState().setNoteExtra(targetNoteId, {
                  slurEnd: !targetExtra?.slurEnd,
                });
              }}
            >
              连音终点
            </button>
          </div>
        </div>
      )}

      {!isCollapsed && activeTab === 'lyrics' && (
        <div className="nb-tab-panel" data-testid="panel-keypad-lyrics">
          <div className="nb-keypad-group">
            <span className="nb-group-label">
              {targetNoteId ? '当前音符歌词' : '请先录入或点选音符'}
            </span>
            <input
              type="text"
              className="nb-input"
              data-testid="input-note-lyric"
              placeholder="输入单字或词组，如：一 / 闪"
              value={lyricDraft}
              disabled={!targetNoteId}
              onChange={(e) => setLyricDraft(e.target.value)}
            />
            <button
              type="button"
              className="nb-btn nb-btn-primary"
              data-testid="btn-apply-lyric"
              disabled={!targetNoteId}
              onClick={handleApplyLyric}
            >
              绑定并跳至下一音
            </button>
            <button
              type="button"
              className="nb-btn nb-btn-sm"
              disabled={!targetNoteId}
              onClick={() => {
                if (!targetNoteId) return;
                setLyricDraft('');
                notationStore.getState().setNoteExtra(targetNoteId, { lyric: undefined });
              }}
            >
              清除歌词
            </button>
          </div>
        </div>
      )}

      {!isCollapsed && activeTab === 'fingering' && (
        <div className="nb-tab-panel" data-testid="panel-keypad-fingering">
          <div className="nb-keypad-group">
            <span className="nb-group-label">钢琴指法</span>
            {FINGERING_PIANO.map((fg) => (
              <button
                key={fg}
                type="button"
                className={`nb-btn ${targetExtra?.fingering === fg ? 'nb-btn-active' : ''}`}
                data-testid={`btn-fingering-${fg}`}
                disabled={!targetNoteId}
                onClick={() => {
                  if (!targetNoteId) return;
                  notationStore.getState().bindScoreId(doc.id);
                  notationStore.getState().setNoteExtra(targetNoteId, {
                    fingering: targetExtra?.fingering === fg ? undefined : fg,
                  });
                }}
              >
                {fg}
              </button>
            ))}

            <span className="nb-group-label">吉他右手指法</span>
            {FINGERING_GUITAR.map((fg) => (
              <button
                key={fg}
                type="button"
                className={`nb-btn nb-btn-sm ${targetExtra?.fingering === fg ? 'nb-btn-active' : ''}`}
                data-testid={`btn-fingering-${fg}`}
                disabled={!targetNoteId}
                onClick={() => {
                  if (!targetNoteId) return;
                  notationStore.getState().bindScoreId(doc.id);
                  notationStore.getState().setNoteExtra(targetNoteId, {
                    fingering: targetExtra?.fingering === fg ? undefined : fg,
                  });
                }}
              >
                {fg}
              </button>
            ))}
          </div>
        </div>
      )}

      {!isCollapsed && activeTab === 'voices' && (
        <div className="nb-tab-panel" data-testid="panel-keypad-voices">
          <div className="nb-keypad-group">
            <span className="nb-group-label">声部切换</span>
            <button
              type="button"
              className={`nb-btn ${activeVoiceIndex === 0 ? 'nb-btn-active' : ''}`}
              data-testid="btn-voice-1"
              onClick={() => {
                notationStore.getState().bindScoreId(doc.id);
                notationStore.getState().setActiveVoice(0, measures.length);
              }}
            >
              Voice 1（高音 / 主旋律）
            </button>
            <button
              type="button"
              className={`nb-btn ${activeVoiceIndex === 1 ? 'nb-btn-active' : ''}`}
              data-testid="btn-voice-2"
              onClick={() => {
                notationStore.getState().bindScoreId(doc.id);
                notationStore.getState().setActiveVoice(1, measures.length);
              }}
            >
              Voice 2（低音 / 左手）
            </button>
          </div>

          <div className="nb-keypad-group">
            <span className="nb-group-label">多轨分谱管理（{tracks.length} 轨）</span>
            {tracks.map((tr, idx) => (
              <button
                key={tr.id}
                type="button"
                className={`nb-btn nb-btn-sm ${activeTrackIndex === idx ? 'nb-btn-active' : ''}`}
                data-testid={`btn-select-track-${tr.id}`}
                onClick={() => notationStore.getState().switchActiveTrack(idx)}
              >
                {tr.name}
              </button>
            ))}
            <input
              type="text"
              className="nb-input nb-input-compact"
              data-testid="input-new-track-name"
              placeholder="新增轨道名，如：主音吉他"
              value={newTrackName}
              onChange={(e) => setNewTrackName(e.target.value)}
            />
            <select
              className="nb-select"
              data-testid="select-new-track-instrument"
              aria-label="新增轨道乐器"
              value={newTrackInstrument}
              onChange={(e) => setNewTrackInstrument(e.target.value as InstrumentId)}
            >
              <option value="piano">钢琴</option>
              <option value="electric-guitar-clean">电吉他（清音）</option>
              <option value="acoustic-guitar">木吉他</option>
              <option value="bass">电贝斯</option>
              <option value="melody">人声/旋律</option>
            </select>
            <button
              type="button"
              className="nb-btn nb-btn-sm nb-btn-primary"
              data-testid="btn-add-track"
              onClick={() => {
                const name = newTrackName.trim() || `分谱 ${tracks.length + 1}`;
                notationStore.getState().bindScoreId(doc.id);
                notationStore
                  .getState()
                  .addTrack(name, newTrackInstrument, 'treble', measures.length);
                setNewTrackName('');
              }}
            >
              + 添加轨道
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
