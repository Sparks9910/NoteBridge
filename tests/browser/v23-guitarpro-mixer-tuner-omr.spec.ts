import { expect, type Page, test } from '@playwright/test';

const STACK_OR_ENGLISH_ERROR_REGEX =
  /\b(TypeError|ReferenceError|SyntaxError|RangeError|URIError|Uncaught|Cannot read propert|is not a function)\b|\bat\s+\S+\s*\(/;

interface RuntimeGuards {
  consoleErrors: string[];
  pageErrors: string[];
}

function attachRuntimeGuards(page: Page): RuntimeGuards {
  const guards: RuntimeGuards = {
    consoleErrors: [],
    pageErrors: [],
  };

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      guards.consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    guards.pageErrors.push(err.message || String(err));
  });
  return guards;
}

async function assertCleanRuntime(
  page: Page,
  guards: RuntimeGuards
): Promise<void> {
  expect(guards.consoleErrors).toEqual([]);
  expect(guards.pageErrors).toEqual([]);
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toMatch(STACK_OR_ENGLISH_ERROR_REGEX);
}

async function resetAllStorage(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(async () => {
    window.localStorage.clear();
    if (typeof window.indexedDB?.databases === 'function') {
      const dbs = await window.indexedDB.databases();
      await Promise.all(
        dbs
          .map((db) => db.name)
          .filter((name): name is string => Boolean(name))
          .map(
            (name) =>
              new Promise<void>((resolve) => {
                const req = window.indexedDB.deleteDatabase(name);
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
                req.onblocked = () => resolve();
              })
          )
      );
    }
  });
  await page.reload();
  await expect(page.getByTestId('notebridge-app')).toBeVisible();
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i]!;
    for (let k = 0; k < 8; k += 1) {
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(entries: Array<{ name: string; data: Uint8Array }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const dataBuf = Buffer.from(entry.data);
    const crc = crc32(dataBuf);

    const lfh = Buffer.alloc(30 + nameBuf.length);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6);
    lfh.writeUInt16LE(0, 8);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(dataBuf.length, 18);
    lfh.writeUInt32LE(dataBuf.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(lfh, 30);
    localParts.push(lfh, dataBuf);

    const cdh = Buffer.alloc(46 + nameBuf.length);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(0, 10);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(dataBuf.length, 20);
    cdh.writeUInt32LE(dataBuf.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);
    nameBuf.copy(cdh, 46);
    centralParts.push(cdh);

    offset += lfh.length + dataBuf.length;
  }

  const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

const SAMPLE_GPIF = `<?xml version="1.0" encoding="utf-8"?>
<GPIF>
  <Score>
    <Title>GP摇滚双轨演练</Title>
    <Music>NoteBridge</Music>
  </Score>
  <MasterTrack>
    <Automations>
      <Automation><Type>Tempo</Type><Value>120 2</Value></Automation>
    </Automations>
  </MasterTrack>
  <Tracks>
    <Track id="0">
      <Name>主音电吉他</Name>
      <ShortName>Lead</ShortName>
      <Properties>
        <Property name="Tuning"><Pitches>40 45 50 55 59 64</Pitches></Property>
      </Properties>
    </Track>
    <Track id="1">
      <Name>伴奏贝斯</Name>
      <ShortName>Bass</ShortName>
      <Properties>
        <Property name="Tuning"><Pitches>28 33 38 43</Pitches></Property>
      </Properties>
    </Track>
  </Tracks>
  <MasterBars>
    <MasterBar>
      <Key><AccidentalCount>0</AccidentalCount></Key>
      <Time>4/4</Time>
      <Bars>0 1</Bars>
    </MasterBar>
  </MasterBars>
  <Bars>
    <Bar id="0"><Voices>0 -1</Voices></Bar>
    <Bar id="1"><Voices>1 -1</Voices></Bar>
  </Bars>
  <Voices>
    <Voice id="0"><Beats>0 1 2 3</Beats></Voice>
    <Voice id="1"><Beats>4 5</Beats></Voice>
  </Voices>
  <Beats>
    <Beat id="0"><Rhythm ref="q" /><Notes>0</Notes></Beat>
    <Beat id="1"><Rhythm ref="q" /><Notes>1</Notes></Beat>
    <Beat id="2"><Rhythm ref="q" /><Notes>2</Notes><PalmMute /></Beat>
    <Beat id="3"><Rhythm ref="q" /><Notes>3</Notes></Beat>
    <Beat id="4"><Rhythm ref="h" /><Notes>4</Notes></Beat>
    <Beat id="5"><Rhythm ref="h" /><Notes>5</Notes></Beat>
  </Beats>
  <Notes>
    <Note id="0">
      <Properties>
        <Property name="String"><String>3</String></Property>
        <Property name="Fret"><Fret>5</Fret></Property>
        <Property name="Bended"><Enable>true</Enable></Property>
      </Properties>
    </Note>
    <Note id="1">
      <Properties>
        <Property name="String"><String>3</String></Property>
        <Property name="Fret"><Fret>7</Fret></Property>
        <Property name="Slide"><Flags>1</Flags></Property>
        <Property name="HopoOrigin" />
      </Properties>
    </Note>
    <Note id="2">
      <Properties>
        <Property name="String"><String>4</String></Property>
        <Property name="Fret"><Fret>5</Fret></Property>
        <Property name="HopoDestination" />
      </Properties>
    </Note>
    <Note id="3">
      <Properties>
        <Property name="String"><String>4</String></Property>
        <Property name="Fret"><Fret>8</Fret></Property>
      </Properties>
    </Note>
    <Note id="4">
      <Properties>
        <Property name="String"><String>0</String></Property>
        <Property name="Fret"><Fret>3</Fret></Property>
      </Properties>
    </Note>
    <Note id="5">
      <Properties>
        <Property name="String"><String>1</String></Property>
        <Property name="Fret"><Fret>3</Fret></Property>
      </Properties>
    </Note>
  </Notes>
  <Rhythms>
    <Rhythm id="q"><NoteValue>Quarter</NoteValue></Rhythm>
    <Rhythm id="h"><NoteValue>Half</NoteValue></Rhythm>
  </Rhythms>
</GPIF>`;

const SAMPLE_OMR_MUSICXML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>OMR识别成功测试曲</work-title></work>
  <part-list><score-part id="P1"><part-name>主旋律</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

// 最小合法 1x1 PNG
const TINY_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

test.describe('L5 V2.3 Guitar Pro 导入、多轨混音、吉他技巧、网页调音器与 OMR 扩展验证', () => {
  test('1. 导入 .gp 多轨曲谱、制谱面板吉他技巧、练谱 TAB 技巧渲染、双谱对齐 <= 2px 与多轨 Mute/Solo 不标脏', async ({
    page,
  }) => {
    const guards = attachRuntimeGuards(page);
    await resetAllStorage(page);

    const gpZip = createStoredZip([
      { name: 'Content/score.gpif', data: Buffer.from(SAMPLE_GPIF, 'utf8') },
    ]);

    await page.getByTestId('btn-open-import').click();
    await expect(page.getByTestId('import-modal')).toBeVisible();
    await page.getByTestId('input-import-external-file').setInputFiles({
      name: 'rock-duo.gp',
      mimeType: 'application/octet-stream',
      buffer: gpZip,
    });

    await expect(page.getByTestId('import-modal')).toHaveCount(0);
    await expect(page.getByTestId('score-title-input')).toHaveValue('GP摇滚双轨演练');
    await expect(
      page.locator('[data-testid="staff-layer"] [data-staff-technique]')
    ).toHaveCount(3);

    // 在制谱面板「线与技巧」标签为第 4 个音符追加震音技巧
    await page.locator('[data-testid="jianpu-layer"] [data-note-id]').last().click();
    await page.getByTestId('tab-keypad-markings').click();
    await expect(page.getByTestId('tab-keypad-markings')).toContainText('线与技巧');
    await page.getByTestId('btn-tech-vibrato').click();
    await expect(
      page.locator('[data-testid="staff-layer"] [data-staff-technique]')
    ).toHaveCount(4);

    await page.getByTestId('btn-save').click();
    await expect(page.getByTestId('save-status')).toHaveText('已保存');

    // 切入练谱模式并选电吉他：核对 TAB 技巧标注、双谱 <= 2px 对齐与多轨混音条
    await page.getByTestId('mode-switch-practice').click();
    await page.getByTestId('practice-inst-electric-guitar').click();
    await page.getByTestId('practice-layer-jianpu').click();

    await expect(
      page.locator('[data-testid="tab-layer"] [data-tab-note-id]')
    ).toHaveCount(4);
    await expect(
      page.locator('[data-testid="tab-layer"] [data-tab-tech-note-id]')
    ).toHaveCount(4);
    await expect(
      page.locator('[data-testid="tab-layer"] [data-note-id]')
    ).toHaveCount(0);

    const alignment = await page.evaluate(() => {
      const staffNodes = Array.from(
        document.querySelectorAll('[data-testid="staff-layer"] [data-note-id]')
      );
      return staffNodes.map((staffEl) => {
        const noteId = staffEl.getAttribute('data-note-id') ?? '';
        const jianpuEl = document.querySelector(
          `[data-testid="jianpu-layer"] [data-note-id="${noteId}"]`
        );
        const noteHeadEl =
          staffEl.querySelector('.vf-notehead text') ??
          staffEl.querySelector('.vf-notehead') ??
          staffEl;
        const jianpuDigitEl = jianpuEl?.querySelector('text') ?? jianpuEl;
        const sr = noteHeadEl.getBoundingClientRect();
        const jr = jianpuDigitEl?.getBoundingClientRect();
        return jr
          ? Math.abs(sr.left + sr.width / 2 - (jr.left + jr.width / 2))
          : 999;
      });
    });
    expect(alignment).toHaveLength(4);
    for (const diff of alignment) {
      expect(diff).toBeLessThanOrEqual(2);
    }

    // 多轨混音条：消主音跟弹与 Solo 伴奏轨，均不得标脏文档
    await expect(page.getByTestId('track-mixer-bar')).toBeVisible();
    await expect(page.getByTestId('mixer-track-gp_track_1')).toHaveAttribute(
      'data-audible',
      'true'
    );
    await page.getByTestId('btn-mute-lead-track').click();
    await expect(page.getByTestId('mixer-track-gp_track_1')).toHaveAttribute(
      'data-audible',
      'false'
    );
    await expect(page.getByTestId('mixer-track-gp_track_2')).toHaveAttribute(
      'data-audible',
      'true'
    );
    await page.getByTestId('mixer-solo-gp_track_2').click();
    await expect(page.getByTestId('mixer-track-gp_track_2')).toHaveAttribute(
      'data-audible',
      'true'
    );

    await expect(page.getByTestId('save-status')).toHaveText('已保存');
    await assertCleanRuntime(page, guards);
  });

  test('2. 练谱模式内置网页调音器：调弦联动、A4 校准切换、弦号锁定与状态隔离', async ({
    page,
  }) => {
    const guards = attachRuntimeGuards(page);
    await resetAllStorage(page);

    await page.getByTestId('btn-save').click();
    await expect(page.getByTestId('save-status')).toHaveText('已保存');

    await page.getByTestId('mode-switch-practice').click();
    await page.getByTestId('practice-inst-electric-guitar').click();
    await page.getByTestId('btn-toggle-tuner').click();

    await expect(page.getByTestId('tuner-panel')).toBeVisible();
    await expect(page.getByTestId('tuner-string-6')).toContainText('6弦 E');

    // 切换 Drop D 调弦后第 6 弦同步更新为 D
    await page.getByTestId('select-tuning-preset').selectOption('drop-d-6');
    await expect(page.getByTestId('tuner-string-6')).toContainText('6弦 D');

    // 切换 A4 标准音频率并锁定 6 弦
    await page.getByTestId('tuner-a4-select').selectOption('442');
    await page.getByTestId('tuner-string-6').click();
    await expect(page.getByTestId('tuner-string-6')).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    await page.getByTestId('btn-tuner-close').click();
    await expect(page.getByTestId('tuner-panel')).toHaveCount(0);
    await expect(page.getByTestId('save-status')).toHaveText('已保存');
    await assertCleanRuntime(page, guards);
  });

  test('3. 导入弹窗 OMR 智能转谱：未配置中文引导、仅载入原谱对照兜底与桥接服务成功转谱分屏', async ({
    page,
  }) => {
    const guards = attachRuntimeGuards(page);
    await resetAllStorage(page);

    // 1. 未配置地址检测 -> 给出中文引导提示且不产生控制台报错
    await page.getByTestId('btn-open-import').click();
    await page.getByTestId('import-tab-omr').click();
    await expect(page.getByTestId('import-panel-omr')).toBeVisible();
    await page.getByTestId('omr-endpoint-input').fill('');
    await page.getByTestId('btn-omr-check-health').click();
    await expect(page.getByTestId('omr-health-status')).toContainText(
      '请先配置本地 OMR 服务地址'
    );

    // 2. 选择 PNG 后点击「仅载入为原谱对照」一键降级开启分屏对照
    await page.getByTestId('input-omr-file').setInputFiles({
      name: 'reference-sheet.png',
      mimeType: 'image/png',
      buffer: TINY_PNG_BYTES,
    });
    await expect(page.getByTestId('omr-selected-file')).toContainText(
      'reference-sheet.png'
    );
    await page.getByTestId('btn-omr-reference-only').click();

    await expect(page.getByTestId('import-modal')).toHaveCount(0);
    await expect(page.getByTestId('studio-split-view')).toBeVisible();
    await expect(page.getByTestId('reference-pane')).toBeVisible();

    // 3. 拦截本地 OMR 桥接端口模拟 Audiveris/Homr 识谱成功 -> 自动生成乐谱并开启原谱对照
    await page.route('http://127.0.0.1:18765/**', async (route) => {
      const url = route.request().url();
      if (url.endsWith('/health')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ available: true, engineVersion: 'Audiveris-Mock-1.0' }),
        });
        return;
      }
      if (url.endsWith('/recognize')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/vnd.recordare.musicxml+xml',
          body: SAMPLE_OMR_MUSICXML,
        });
        return;
      }
      await route.continue();
    });

    await page.getByTestId('btn-open-import').click();
    await page.getByTestId('import-tab-omr').click();
    await page.getByTestId('omr-endpoint-input').fill('http://127.0.0.1:18765');
    await page.getByTestId('btn-omr-check-health').click();
    await expect(page.getByTestId('omr-health-status')).toContainText(
      'Audiveris-Mock-1.0'
    );

    await page.getByTestId('input-omr-file').setInputFiles({
      name: 'omr-input.png',
      mimeType: 'image/png',
      buffer: TINY_PNG_BYTES,
    });
    await page.getByTestId('btn-omr-recognize').click();

    await expect(page.getByTestId('import-modal')).toHaveCount(0);
    await expect(page.getByTestId('score-title-input')).toHaveValue(
      'OMR识别成功测试曲'
    );
    await expect(page.getByTestId('studio-split-view')).toBeVisible();
    await expect(page.getByTestId('reference-pane')).toBeVisible();
    await expect(
      page.locator('[data-testid="jianpu-layer"] [data-note-id]')
    ).toHaveCount(4);

    await assertCleanRuntime(page, guards);
  });
});
