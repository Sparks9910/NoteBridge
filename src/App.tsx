import { useEffect } from 'react';
import { inputStore } from './application/input-store.ts';
import { scoreStore } from './application/score-store.ts';
import { InputKeypad } from './ui/InputKeypad.tsx';
import { PlaybackBar } from './ui/PlaybackBar.tsx';
import { ScoreCanvas } from './ui/ScoreCanvas.tsx';
import { Toolbar } from './ui/Toolbar.tsx';

export default function App() {
  useEffect(() => {
    const res = scoreStore.getState().loadLastOpened();
    if (res.ok && res.value) {
      const measures = res.value.measures;
      const lastIndex = Math.max(0, measures.length - 1);
      const lastMeasure = measures[lastIndex];
      inputStore.getState().setCursor({
        measureIndex: lastIndex,
        noteIndex: lastMeasure ? lastMeasure.notes.length : 0,
        selectedNoteId: null,
      });
    }
  }, []);

  return (
    <div className="nb-app" data-testid="notebridge-app">
      <Toolbar />
      <main className="nb-main">
        <ScoreCanvas />
        <PlaybackBar />
        <InputKeypad />
      </main>
    </div>
  );
}
