import { useEffect } from 'react';
import { inputStore } from './application/input-store.ts';
import { libraryStore } from './application/library-store.ts';
import { useNotationStore } from './application/notation-store.ts';
import { scoreStore } from './application/score-store.ts';
import { useWorkspaceStore } from './application/workspace-store.ts';
import { InputKeypad } from './ui/InputKeypad.tsx';
import { LibraryView } from './ui/LibraryView.tsx';
import { PlaybackBar } from './ui/PlaybackBar.tsx';
import { PracticeSkeletonBar } from './ui/PracticeSkeletonBar.tsx';
import { ReferencePane } from './ui/ReferencePane.tsx';
import { ScoreCanvas } from './ui/ScoreCanvas.tsx';
import { Toolbar } from './ui/Toolbar.tsx';

export default function App() {
  const activePage = useWorkspaceStore((s) => s.activePage);
  const workMode = useWorkspaceStore((s) => s.workMode);
  const showReferencePanel = useNotationStore((s) => s.showReferencePanel);

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
        {workMode === 'studio' ? <InputKeypad /> : <PracticeSkeletonBar />}
      </main>
    </div>
  );
}
