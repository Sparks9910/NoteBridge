import { useEffect } from 'react';
import { inputStore } from './application/input-store.ts';
import { libraryStore } from './application/library-store.ts';
import { useNotationStore } from './application/notation-store.ts';
import { usePracticeStore } from './application/practice-store.ts';
import { scoreStore } from './application/score-store.ts';
import { useWorkspaceStore } from './application/workspace-store.ts';
import { getInstrumentProfile } from './domain/v2-instruments.ts';
import { GuitarFretboardDock } from './ui/GuitarFretboardDock.tsx';
import { InputKeypad } from './ui/InputKeypad.tsx';
import { LibraryView } from './ui/LibraryView.tsx';
import { MelodyLyricDock } from './ui/MelodyLyricDock.tsx';
import { PianoKeysDock } from './ui/PianoKeysDock.tsx';
import { PlaybackBar } from './ui/PlaybackBar.tsx';
import { PracticeControlBar } from './ui/PracticeControlBar.tsx';
import { ReferencePane } from './ui/ReferencePane.tsx';
import { ScoreCanvas } from './ui/ScoreCanvas.tsx';
import { Toolbar } from './ui/Toolbar.tsx';
import { TunerPanel } from './ui/TunerPanel.tsx';

export default function App() {
  const activePage = useWorkspaceStore((s) => s.activePage);
  const workMode = useWorkspaceStore((s) => s.workMode);
  const showReferencePanel = useNotationStore((s) => s.showReferencePanel);
  const selectedInstrumentId = usePracticeStore((s) => s.selectedInstrumentId);
  const showTunerPanel = usePracticeStore((s) => s.showTunerPanel);
  const activeDockType = getInstrumentProfile(selectedInstrumentId).dockType;

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
    void libraryStore.getState().initialize();
  }, []);

  if (activePage === 'library') {
    return (
      <div className="nb-app" data-testid="notebridge-app">
        <LibraryView />
      </div>
    );
  }

  return (
    <div className="nb-app" data-testid="notebridge-app">
      <Toolbar />
      <main className="nb-main" data-work-mode={workMode}>
        {workMode === 'studio' && showReferencePanel ? (
          <div className="nb-studio-split" data-testid="studio-split-view">
            <ReferencePane />
            <ScoreCanvas />
          </div>
        ) : (
          <ScoreCanvas />
        )}
        <PlaybackBar />
        {workMode === 'studio' ? (
          <InputKeypad />
        ) : (
          <>
            <PracticeControlBar />
            {showTunerPanel && <TunerPanel />}
            {activeDockType === 'fretboard' && <GuitarFretboardDock />}
            {activeDockType === 'piano-keys' && <PianoKeysDock />}
            {activeDockType === 'melody-bar' && <MelodyLyricDock />}
          </>
        )}
      </main>
    </div>
  );
}
