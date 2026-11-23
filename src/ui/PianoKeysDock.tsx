import { useMemo } from 'react';
import { playbackController } from '../application/playback-controller.ts';
import { usePracticeStore } from '../application/practice-store.ts';
import { midiToNoteLabel } from '../domain/v2-instruments.ts';

interface PianoKeySpec {
  midi: number;
  isBlack: boolean;
  label: string;
  whiteIndexBefore: number;
}

const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);

function build88Keys(): { keys: PianoKeySpec[]; whiteCount: number } {
  const keys: PianoKeySpec[] = [];
  let whiteCount = 0;

  for (let midi = 21; midi <= 108; midi += 1) {
    const pc = midi % 12;
    const isBlack = BLACK_PITCH_CLASSES.has(pc);
    const label = pc === 0 ? midiToNoteLabel(midi) : '';
    if (!isBlack) {
      keys.push({
        midi,
        isBlack: false,
        label,
        whiteIndexBefore: whiteCount,
      });
      whiteCount += 1;
    } else {
      keys.push({
        midi,
        isBlack: true,
        label: '',
        whiteIndexBefore: whiteCount,
      });
    }
  }

  return { keys, whiteCount };
}

export function PianoKeysDock() {
  const activeMidiPitchesV1 = usePracticeStore((s) => s.activeMidiPitchesV1);
  const activeMidiPitchesV2 = usePracticeStore((s) => s.activeMidiPitchesV2);
  const nextMidiPitch = usePracticeStore((s) => s.nextMidiPitch);
  const muteRightHand = usePracticeStore((s) => s.muteRightHand);
  const muteLeftHand = usePracticeStore((s) => s.muteLeftHand);

  const { keys, whiteCount } = useMemo(() => build88Keys(), []);
  const v1Set = useMemo(
    () => new Set(muteRightHand ? [] : activeMidiPitchesV1),
    [activeMidiPitchesV1, muteRightHand]
  );
  const v2Set = useMemo(
    () => new Set(muteLeftHand ? [] : activeMidiPitchesV2),
    [activeMidiPitchesV2, muteLeftHand]
  );

  const whiteKeys = useMemo(() => keys.filter((k) => !k.isBlack), [keys]);
  const blackKeys = useMemo(() => keys.filter((k) => k.isBlack), [keys]);

  const v1Labels = activeMidiPitchesV1.map(midiToNoteLabel).join(' ');
  const v2Labels = activeMidiPitchesV2.map(midiToNoteLabel).join(' ');

  return (
    <section
      className="nb-dock nb-piano-dock"
      data-testid="piano-keys-dock"
      aria-label="88 键虚拟钢琴实时高亮"
    >
      <div className="nb-dock-header">
        <div className="nb-dock-title-row">
          <strong className="nb-dock-title">88 键实时钢琴键盘（A0–C8）</strong>
          <span className="nb-piano-legend nb-legend-right">
            右手 Voice 1 {muteRightHand ? '（已静音）' : ''}
            {v1Labels ? `：${v1Labels}` : ''}
          </span>
          <span className="nb-piano-legend nb-legend-left">
            左手 Voice 2 {muteLeftHand ? '（已静音）' : ''}
            {v2Labels ? `：${v2Labels}` : ''}
          </span>
          {nextMidiPitch !== null && (
            <span className="nb-piano-legend nb-legend-next">
              下一音：{midiToNoteLabel(nextMidiPitch)}
            </span>
          )}
        </div>
      </div>

      <div className="nb-piano-scroll">
        <div className="nb-piano-keyboard" data-testid="piano-88-keyboard">
          <div className="nb-piano-whites">
            {whiteKeys.map((key) => {
              const inV1 = v1Set.has(key.midi);
              const inV2 = v2Set.has(key.midi);
              const handAttr =
                inV1 && inV2
                  ? 'both'
                  : inV1
                    ? 'right'
                    : inV2
                      ? 'left'
                      : undefined;
              const isNext = !handAttr && nextMidiPitch === key.midi;
              return (
                <button
                  key={key.midi}
                  type="button"
                  className={`nb-piano-key nb-piano-white ${key.midi === 60 ? 'nb-piano-middle-c' : ''}`}
                  data-testid={`piano-key-${key.midi}`}
                  data-piano-midi={key.midi}
                  data-key-hand={handAttr}
                  data-key-next={isNext ? 'true' : undefined}
                  aria-label={midiToNoteLabel(key.midi)}
                  onClick={() => playbackController.previewMidi(key.midi, 320)}
                >
                  {key.label && (
                    <span className="nb-piano-c-label">{key.label}</span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="nb-piano-blacks">
            {blackKeys.map((key) => {
              const inV1 = v1Set.has(key.midi);
              const inV2 = v2Set.has(key.midi);
              const handAttr =
                inV1 && inV2
                  ? 'both'
                  : inV1
                    ? 'right'
                    : inV2
                      ? 'left'
                      : undefined;
              const isNext = !handAttr && nextMidiPitch === key.midi;
              const leftPct = (key.whiteIndexBefore / whiteCount) * 100;
              return (
                <button
                  key={key.midi}
                  type="button"
                  className="nb-piano-key nb-piano-black"
                  data-testid={`piano-key-${key.midi}`}
                  data-piano-midi={key.midi}
                  data-key-hand={handAttr}
                  data-key-next={isNext ? 'true' : undefined}
                  style={{ left: `${leftPct}%` }}
                  aria-label={midiToNoteLabel(key.midi)}
                  onClick={() => playbackController.previewMidi(key.midi, 320)}
                />
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
