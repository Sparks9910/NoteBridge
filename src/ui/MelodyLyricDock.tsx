import { useMemo } from 'react';
import { useInputStore } from '../application/input-store.ts';
import { useNotationStore } from '../application/notation-store.ts';
import { usePlaybackStore } from '../application/playback-controller.ts';
import { usePracticeStore } from '../application/practice-store.ts';
import {
  resolveScoreForView,
  useScoreStore,
} from '../application/score-store.ts';
import type { NoteEvent, ResolvedNote } from '../domain/types.ts';
import { midiToNoteLabel } from '../domain/v2-instruments.ts';

function formatDegree(
  degree: number,
  octaveOffset: number,
  isRest: boolean
): string {
  if (isRest || degree === 0) {
    return '0 (休止)';
  }
  const octStr =
    octaveOffset > 0
      ? ` +${octaveOffset}八度`
      : octaveOffset < 0
        ? ` ${octaveOffset}八度`
        : '';
  return `${degree}${octStr}`;
}

export function MelodyLyricDock() {
  const doc = useScoreStore((s) => s.document);
  const selectedNoteId = useInputStore((s) => s.cursor.selectedNoteId);
  const playbackState = usePlaybackStore((s) => s.playbackState);
  const boundScoreId = useNotationStore((s) => s.boundScoreId);
  const noteExtrasById = useNotationStore((s) => s.noteExtrasById);

  const activeNoteId = usePracticeStore((s) => s.activeNoteId);
  const nextNoteId = usePracticeStore((s) => s.nextNoteId);

  const resolvedNotes = useMemo(() => resolveScoreForView(doc), [doc]);
  const noteMap = useMemo(() => {
    const map = new Map<string, ResolvedNote>();
    for (const rn of resolvedNotes) {
      map.set(rn.noteId, rn);
    }
    return map;
  }, [resolvedNotes]);

  const rawNoteMap = useMemo(() => {
    const map = new Map<string, NoteEvent>();
    for (const m of doc.measures) {
      for (const n of m.notes) {
        map.set(n.id, n);
      }
    }
    return map;
  }, [doc.measures]);

  const extras =
    boundScoreId === null || boundScoreId === doc.id ? noteExtrasById : {};
  const focusId =
    playbackState === 'PLAYING' || playbackState === 'PAUSED'
      ? activeNoteId
      : activeNoteId ?? selectedNoteId;

  const currentNote = focusId ? noteMap.get(focusId) ?? null : null;
  const currentRaw = focusId ? rawNoteMap.get(focusId) ?? null : null;
  const nextNote = nextNoteId ? noteMap.get(nextNoteId) ?? null : null;
  const nextRaw = nextNoteId ? rawNoteMap.get(nextNoteId) ?? null : null;

  return (
    <section
      className="nb-dock nb-melody-dock"
      data-testid="melody-lyric-dock"
      aria-label="通用旋律与歌词提示条"
    >
      <div className="nb-dock-header">
        <div className="nb-dock-title-row">
          <strong className="nb-dock-title">
            旋律与歌词字幕提示（1 = {doc.keySignature}）
          </strong>
        </div>
        <div className="nb-melody-cards">
          <div className="nb-melody-card nb-melody-current">
            <span className="nb-melody-card-label">当前音符</span>
            <strong className="nb-melody-card-main">
              {currentNote && currentRaw
                ? `${formatDegree(currentRaw.degree, currentRaw.octaveOffset, currentRaw.isRest)} · ${currentNote.midiPitch !== null ? midiToNoteLabel(currentNote.midiPitch) : '休止'}`
                : '等待起播或点击音符'}
            </strong>
            {currentNote && extras[currentNote.noteId]?.lyric && (
              <span className="nb-melody-lyric">
                词：{extras[currentNote.noteId]?.lyric}
              </span>
            )}
          </div>

          <div className="nb-melody-card nb-melody-next">
            <span className="nb-melody-card-label">下一音符</span>
            <strong className="nb-melody-card-main">
              {nextNote && nextRaw
                ? `${formatDegree(nextRaw.degree, nextRaw.octaveOffset, nextRaw.isRest)} · ${nextNote.midiPitch !== null ? midiToNoteLabel(nextNote.midiPitch) : '休止'}`
                : '—'}
            </strong>
            {nextNote && extras[nextNote.noteId]?.lyric && (
              <span className="nb-melody-lyric">
                词：{extras[nextNote.noteId]?.lyric}
              </span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
