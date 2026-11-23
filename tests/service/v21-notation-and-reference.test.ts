import { describe, expect, it } from 'vitest';
import { createInputStore } from '../../src/application/input-store.ts';
import { createLibraryStore } from '../../src/application/library-store.ts';
import { createNotationStore } from '../../src/application/notation-store.ts';
import { createPlaybackController } from '../../src/application/playback-controller.ts';
import { createScoreStore } from '../../src/application/score-store.ts';
import { createWorkspaceStore } from '../../src/application/workspace-store.ts';
import { MockAudioEngine } from '../../src/infrastructure/audio-engine.ts';
import { InMemoryLibraryRepository } from '../../src/infrastructure/indexeddb-adapter.ts';
import {
  StorageAdapter,
  type StorageLike,
} from '../../src/infrastructure/storage-adapter.ts';

class MemoryStorage implements StorageLike {
  private readonly map = new Map<string, string>();
  public getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  public setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  public removeItem(key: string): void {
    this.map.delete(key);
  }
}

describe('L2 V2.1 多声部制谱、原谱附件持久化与外部导入服务测试', () => {
  it('notationStore + libraryStore 完整保存并恢复大谱表、Voice 2、歌词、指法与反复记号', async () => {
    const legacy = new StorageAdapter({
      storage: new MemoryStorage(),
      namespace: 'nb_v21_service_test',
    });
    const repo = new InMemoryLibraryRepository();
    const sStore = createScoreStore({
      storage: legacy,
      config: { enableDemoMode: false, defaultBpm: 90 },
      autoSaveDelayMs: 0,
    });
    const wStore = createWorkspaceStore();
    const iStore = createInputStore();
    const nStore = createNotationStore();

    let seq = 1;
    const lib = createLibraryStore({
      repository: repo,
      legacyStorage: legacy,
      scoreStore: sStore,
      workspaceStore: wStore,
      inputStore: iStore,
      notationStore: nStore,
      idGenerator: (prefix) => `${prefix}_${seq++}`,
      now: () => 1732400100000 + seq,
    });

    await lib.getState().initialize();
    const created = await lib.getState().createAndOpenNewScore('钢琴大谱表练习');
    expect(created.ok).toBe(true);
    const docId = sStore.getState().document.id;

    // 录入 Voice 1 主旋律音符
    const ins1 = sStore.getState().insertNote({
      measureIndex: 0,
      isRest: false,
      degree: 1,
      octaveOffset: 0,
      accidental: null,
      baseDuration: 'quarter',
      dotted: false,
    });
    expect(ins1.ok).toBe(true);
    if (!ins1.ok) return;
    const noteId = ins1.value.note.id;

    // 设置钢琴大谱表、Voice 2 低音、歌词、指法与反复记号
    nStore.getState().setClef('grand', 1);
    const v2Beat = nStore.getState().insertVoice2Note({
      measureIndex: 0,
      isRest: false,
      degree: 1,
      octaveOffset: -2,
      accidental: null,
      baseDuration: 'half',
      dotted: false,
      keySignature: 'C',
    });
    expect(v2Beat.ok).toBe(true);

    nStore.getState().setNoteExtra(noteId, {
      lyric: '梦',
      fingering: '5',
      dynamic: 'mf',
      ornament: 'trill',
    });
    nStore.getState().setMeasureExtra(0, {
      repeatStart: true,
      ending: 1,
    });
    nStore.getState().addTrack('伴奏吉他', 'acoustic-guitar', 'treble', 1);

    await lib.getState().syncScoreToLibrary(sStore.getState().document, {
      composer: '音桥测试',
    });

    // 重置状态后从仓库重新打开，验证无损水合
    nStore.getState().resetForScore(null);
    const reopened = await lib.getState().openScore(docId, 'studio');
    expect(reopened.ok).toBe(true);
    expect(nStore.getState().clef).toBe('grand');
    expect(nStore.getState().tracks).toHaveLength(2);
    expect(
      nStore.getState().tracks[0]?.voices[1]?.measures[0]?.beats[0]?.notes[0]?.midiPitch
    ).toBe(36);
    expect(nStore.getState().noteExtrasById[noteId]?.lyric).toBe('梦');
    expect(nStore.getState().noteExtrasById[noteId]?.fingering).toBe('5');
    expect(nStore.getState().measureExtrasByIndex[0]?.repeatStart).toBe(true);

    // 验证 PlaybackController 能并行调度 Voice 1 与 Voice 2
    const audioEngine = new MockAudioEngine({ lookaheadMs: 100 });
    const playback = createPlaybackController({
      scoreStore: sStore,
      inputStore: iStore,
      notationStore: nStore,
      audioEngine,
    });
    const playRes = await playback.play();
    expect(playRes.ok).toBe(true);
    expect(audioEngine.scheduledNotes.length).toBeGreaterThanOrEqual(2);
    playback.stop();
    playback.dispose();
    sStore.getState().dispose();
  });

  it('saveScoreReference / loadScoreReference / removeScoreReference 完整存储并清理二进制原谱附件', async () => {
    const legacy = new StorageAdapter({
      storage: new MemoryStorage(),
      namespace: 'nb_v21_ref_test',
    });
    const repo = new InMemoryLibraryRepository();
    const sStore = createScoreStore({
      storage: legacy,
      config: { enableDemoMode: false, defaultBpm: 90 },
      autoSaveDelayMs: 0,
    });
    const wStore = createWorkspaceStore();
    const iStore = createInputStore();
    const nStore = createNotationStore();

    let seq = 1;
    const lib = createLibraryStore({
      repository: repo,
      legacyStorage: legacy,
      scoreStore: sStore,
      workspaceStore: wStore,
      inputStore: iStore,
      notationStore: nStore,
      idGenerator: (prefix) => `${prefix}_${seq++}`,
      now: () => 1732400200000 + seq,
    });

    await lib.getState().initialize();
    await lib.getState().createAndOpenNewScore('原谱对照测试曲');
    const doc = sStore.getState().document;

    const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const saveRefRes = await lib.getState().saveScoreReference(doc, {}, {
      name: 'score-ref.png',
      mimeType: 'image/png',
      data: fakePng,
    });
    expect(saveRefRes.ok).toBe(true);
    if (!saveRefRes.ok) return;

    expect(nStore.getState().showReferencePanel).toBe(true);
    expect(nStore.getState().referenceSource?.name).toBe('score-ref.png');
    expect(lib.getState().storageUsageBytes).toBeGreaterThanOrEqual(fakePng.byteLength);

    const loadedRef = await lib.getState().loadScoreReference(saveRefRes.value.id);
    expect(loadedRef.ok).toBe(true);
    if (loadedRef.ok) {
      expect(Array.from(loadedRef.value.data)).toEqual(Array.from(fakePng));
    }

    // 校验非法格式拒绝
    const badRef = await lib.getState().saveScoreReference(doc, {}, {
      name: 'malware.exe',
      mimeType: 'application/octet-stream',
      data: new Uint8Array([1, 2, 3]),
    });
    expect(badRef.ok).toBe(false);
    if (!badRef.ok) {
      expect(badRef.error.code).toBe('STORAGE_SCHEMA_CORRUPTED');
      expect(badRef.error.detail).toMatch(/[\u4e00-\u9fa5]/);
    }

    // 移除原谱附件
    const rmRes = await lib.getState().removeScoreReference(doc, {});
    expect(rmRes.ok).toBe(true);
    expect(nStore.getState().referenceSource).toBeNull();
    const afterRm = await lib.getState().loadScoreReference(saveRefRes.value.id);
    expect(afterRm.ok).toBe(false);

    sStore.getState().dispose();
  });

  it('importExternalFile 与 importJianpuText 导入后自动加载至工作台并保存入库', async () => {
    const legacy = new StorageAdapter({
      storage: new MemoryStorage(),
      namespace: 'nb_v21_import_test',
    });
    const repo = new InMemoryLibraryRepository();
    const sStore = createScoreStore({
      storage: legacy,
      config: { enableDemoMode: false, defaultBpm: 90 },
      autoSaveDelayMs: 0,
    });
    const wStore = createWorkspaceStore();
    const iStore = createInputStore();
    const nStore = createNotationStore();

    let seq = 1;
    const lib = createLibraryStore({
      repository: repo,
      legacyStorage: legacy,
      scoreStore: sStore,
      workspaceStore: wStore,
      inputStore: iStore,
      notationStore: nStore,
      idGenerator: (prefix) => `${prefix}_${seq++}`,
      now: () => 1732400300000 + seq,
    });

    const jianpuRes = await lib.getState().importJianpuText(
      '标题: 茉莉花片段\n1=F 4/4 BPM=88\n3 3 5 6 | 1\' 1\' 6 5 ||',
      true
    );
    expect(jianpuRes.ok).toBe(true);
    expect(sStore.getState().document.title).toBe('茉莉花片段');
    expect(sStore.getState().document.keySignature).toBe('F');
    expect(lib.getState().entries).toHaveLength(1);

    const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>小步舞曲 XML</work-title></work>
  <part-list><score-part id="P1"><part-name>钢琴</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>480</divisions>
        <key><fifths>1</fifths></key>
        <time><beats>3</beats><beat-type>4</beat-type></time>
      </attributes>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>480</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>480</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>480</duration><voice>1</voice><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

    const xmlImport = await lib
      .getState()
      .importExternalFile('minuet.musicxml', new TextEncoder().encode(sampleXml), true);
    expect(xmlImport.ok).toBe(true);
    expect(sStore.getState().document.title).toBe('小步舞曲 XML');
    expect(sStore.getState().document.keySignature).toBe('G');
    expect(sStore.getState().document.timeSignature).toBe('3/4');
    expect(lib.getState().entries).toHaveLength(2);

    sStore.getState().dispose();
  });
});
