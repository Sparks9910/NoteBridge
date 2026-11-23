import { readFileSync } from 'node:fs';
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

async function assertDualStaffAligned(page: Page): Promise<void> {
  const results = await page.evaluate(() => {
    const staffNodes = Array.from(
      document.querySelectorAll('[data-testid="staff-layer"] [data-note-id]')
    );
    return staffNodes.map((staffEl) => {
      const noteId = staffEl.getAttribute('data-note-id') ?? '';
      const jianpuEl = document.querySelector(
        `[data-testid="jianpu-layer"] [data-note-id="${noteId}"]`
      );
      if (!jianpuEl) {
        return { noteId, missing: true, diffPx: 9999 };
      }
      const noteHeadEl =
        staffEl.querySelector('.vf-notehead text') ??
        staffEl.querySelector('.vf-notehead') ??
        staffEl;
      const staffRect = noteHeadEl.getBoundingClientRect();
      const staffCenterX = staffRect.left + staffRect.width / 2;
      const jianpuDigitEl = jianpuEl.querySelector('text') ?? jianpuEl;
      const jianpuRect = jianpuDigitEl.getBoundingClientRect();
      const jianpuCenterX = jianpuRect.left + jianpuRect.width / 2;
      return {
        noteId,
        missing: false,
        diffPx: Math.round(Math.abs(staffCenterX - jianpuCenterX) * 100) / 100,
      };
    });
  });

  expect(results.length).toBeGreaterThan(0);
  for (const r of results) {
    expect(r.missing).toBe(false);
    expect(r.diffPx).toBeLessThanOrEqual(2);
  }
}

const SAMPLE_MUSICXML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>MusicXML双谱导入</work-title></work>
  <part-list><score-part id="P1"><part-name>主旋律</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>480</divisions>
        <key><fifths>1</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>480</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>480</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>480</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>D</step><octave>5</octave></pitch><duration>480</duration><voice>1</voice><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

// 1x1 valid PNG binary
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0XQAAAAASUVORK5CYII=';

test.describe('L5 V2.1 制谱对照完全体与 MusicXML/MIDI 互通验证', () => {
  test('1. 导入 MusicXML 与简谱文本后自动渲染双谱且 X 坐标偏差 <= 2px', async ({
    page,
  }) => {
    const guards = attachRuntimeGuards(page);
    await resetAllStorage(page);

    // 1) 通过弹窗导入 MusicXML 文件
    await page.getByTestId('btn-open-import').click();
    await expect(page.getByTestId('import-modal')).toBeVisible();
    await page.getByTestId('input-import-external-file').setInputFiles({
      name: 'melody.musicxml',
      mimeType: 'application/xml',
      buffer: Buffer.from(SAMPLE_MUSICXML, 'utf8'),
    });

    await expect(page.getByTestId('import-modal')).toHaveCount(0);
    await expect(page.getByTestId('score-title-input')).toHaveValue('MusicXML双谱导入');
    await expect(page.getByTestId('select-key-signature')).toHaveValue('G');
    await expect(
      page.locator('[data-testid="jianpu-layer"] [data-note-id]')
    ).toHaveCount(4);
    await assertDualStaffAligned(page);

    // 2) 通过简谱文本快捷导入（内置示例）
    await page.getByTestId('btn-open-import').click();
    await page.getByTestId('btn-fill-jianpu-sample').click();
    await expect(page.getByTestId('jianpu-parse-preview')).toContainText('1=C');
    await expect(page.getByTestId('jianpu-parse-preview')).toContainText('4 小节');
    await page.getByTestId('btn-submit-jianpu-import').click();

    await expect(page.getByTestId('score-title-input')).toHaveValue('欢乐颂片段');
    await expect(
      page.locator('[data-testid="jianpu-layer"] [data-note-id]').first()
    ).toContainText('3');
    await assertDualStaffAligned(page);

    // 3) 通过简谱文本快捷导入多行紧凑写法 + 1=bB + 中文速度指令，验证预览与双谱对齐
    await page.getByTestId('btn-open-import').click();
    await page.getByTestId('textarea-jianpu-import').fill(
      ['标题: 多行简谱导入验证', '1=bB 4/4 速度: 108', '1155 | 665-', '4_4_33 | 221- ||'].join('\n')
    );
    await expect(page.getByTestId('jianpu-parse-preview')).toContainText('1=Bb');
    await expect(page.getByTestId('jianpu-parse-preview')).toContainText('BPM=108');
    await expect(page.getByTestId('jianpu-parse-preview')).toContainText('4 小节');
    await expect(page.getByTestId('jianpu-parse-preview')).toContainText('14 音符');
    await page.getByTestId('btn-submit-jianpu-import').click();

    await expect(page.getByTestId('import-modal')).toHaveCount(0);
    await expect(page.getByTestId('score-title-input')).toHaveValue('多行简谱导入验证');
    await expect(page.getByTestId('select-key-signature')).toHaveValue('Bb');
    await expect(page.getByTestId('input-bpm-number')).toHaveValue('108');
    await expect(
      page.locator('[data-testid="jianpu-layer"] [data-note-id]')
    ).toHaveCount(14);
    await assertDualStaffAligned(page);

    await assertCleanRuntime(page, guards);
  });

  test('2. 多标签制谱面板：大谱表、Voice 2、歌词、指法、强弱与反复记号保持双谱 <= 2px', async ({
    page,
  }) => {
    const guards = attachRuntimeGuards(page);
    await resetAllStorage(page);

    // 录入 Voice 1 旋律
    await page.getByTestId('dur-quarter').click();
    for (const deg of [1, 2, 3, 5] as const) {
      await page.getByTestId(`key-degree-${deg}`).click();
    }

    // 切至「谱/调/拍/速」设置钢琴大谱表
    await page.getByTestId('tab-keypad-setup').click();
    await page.getByTestId('btn-clef-grand').click();

    // 切至「声部与轨道」并选 Voice 2 录入低音音符
    await page.getByTestId('tab-keypad-voices').click();
    await page.getByTestId('btn-voice-2').click();
    await expect(page.getByTestId('active-voice-indicator')).toContainText('Voice 2');

    await page.getByTestId('tab-keypad-input').click();
    await page.getByTestId('dur-half').click();
    await page.getByTestId('key-degree-1').click();
    await expect(
      page.locator('[data-testid="staff-layer"] [data-v2-note-id]')
    ).toHaveCount(1);

    // 切回 Voice 1，绑定歌词、指法、强弱、颤音与反复记号
    await page.getByTestId('tab-keypad-voices').click();
    await page.getByTestId('btn-voice-1').click();

    await page.getByTestId('tab-keypad-lyrics').click();
    await page.getByTestId('input-note-lyric').fill('桥');
    await page.getByTestId('btn-apply-lyric').click();
    await expect(
      page.locator('[data-testid="jianpu-layer"] [data-jianpu-lyric]')
    ).toHaveCount(1);

    await page.getByTestId('tab-keypad-fingering').click();
    await page.getByTestId('btn-fingering-3').click();
    await expect(
      page.locator('[data-testid="staff-layer"] [data-staff-fingering]')
    ).toHaveCount(1);

    await page.getByTestId('tab-keypad-markings').click();
    await page.getByTestId('btn-dynamic-mf').click();
    await page.getByTestId('btn-ornament-trill').click();
    await expect(
      page.locator('[data-testid="staff-layer"] [data-staff-dynamic]')
    ).toHaveCount(1);

    await page.getByTestId('tab-keypad-measure').click();
    await page.getByTestId('btn-measure-repeat-start').click();
    await page.getByTestId('btn-ending-1').click();
    await expect(
      page.locator('[data-testid="staff-layer"] [data-ending-measure="0"]')
    ).toHaveCount(1);

    await assertDualStaffAligned(page);
    await assertCleanRuntime(page, guards);
  });

  test('3. MusicXML / MXL / MIDI 全格式导出与单声部分谱导出（Part Extraction）', async ({
    page,
  }) => {
    const guards = attachRuntimeGuards(page);
    await resetAllStorage(page);

    await page.getByTestId('score-title-input').fill('互通导出示范');
    await page.getByTestId('dur-quarter').click();
    for (const deg of [1, 3, 5, 1] as const) {
      await page.getByTestId(`key-degree-${deg}`).click();
    }

    await page.getByTestId('tab-keypad-setup').click();
    await page.getByTestId('btn-clef-grand').click();
    await page.getByTestId('tab-keypad-voices').click();
    await page.getByTestId('btn-voice-2').click();
    await page.getByTestId('tab-keypad-input').click();
    await page.getByTestId('key-degree-5').click();

    await page.getByTestId('btn-open-export').click();
    await expect(page.getByTestId('export-modal')).toBeVisible();

    // 1) MusicXML 导出
    const [xmlDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('btn-export-musicxml').click(),
    ]);
    expect(xmlDownload.suggestedFilename()).toBe('互通导出示范.musicxml');
    const xmlPath = await xmlDownload.path();
    if (xmlPath) {
      const xmlText = readFileSync(xmlPath, 'utf8');
      expect(xmlText).toContain('<score-partwise version="4.0">');
      expect(xmlText).toContain('<staves>2</staves>');
    }

    // 2) MXL 压缩包导出
    const [mxlDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('btn-export-mxl').click(),
    ]);
    expect(mxlDownload.suggestedFilename()).toBe('互通导出示范.mxl');
    const mxlPath = await mxlDownload.path();
    if (mxlPath) {
      const mxlBytes = readFileSync(mxlPath);
      expect(mxlBytes.subarray(0, 2)).toEqual(Buffer.from([0x50, 0x4b]));
    }

    // 3) MIDI 导出
    const [midiDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('btn-export-midi').click(),
    ]);
    expect(midiDownload.suggestedFilename()).toBe('互通导出示范.mid');
    const midiPath = await midiDownload.path();
    if (midiPath) {
      const midiBytes = readFileSync(midiPath);
      expect(midiBytes.subarray(0, 4).toString('latin1')).toBe('MThd');
    }

    // 4) 分谱导出（仅导出 Voice 2 左手低音）
    const [partDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('btn-export-part-voice-2').click(),
    ]);
    expect(partDownload.suggestedFilename()).toContain('.musicxml');
    const partPath = await partDownload.path();
    if (partPath) {
      const partXml = readFileSync(partPath, 'utf8');
      expect(partXml).toContain('<sign>F</sign>');
    }

    await assertCleanRuntime(page, guards);
  });

  test('4. 「原谱对照」分屏上传本地图片存入 IndexedDB 并在刷新后完整恢复', async ({
    page,
  }) => {
    const guards = attachRuntimeGuards(page);
    await resetAllStorage(page);

    await page.getByTestId('score-title-input').fill('原谱核对曲');
    await page.getByTestId('dur-quarter').click();
    await page.getByTestId('key-degree-1').click();
    await page.getByTestId('btn-save').click();
    await expect(page.getByTestId('save-status')).toHaveText('已保存');

    // 打开原谱对照分屏并上传本地 PNG 图片
    await page.getByTestId('btn-toggle-reference').click();
    await expect(page.getByTestId('studio-split-view')).toBeVisible();
    await expect(page.getByTestId('reference-empty')).toBeVisible();

    await page.getByTestId('input-reference-upload').setInputFiles({
      name: 'original-sheet.png',
      mimeType: 'image/png',
      buffer: Buffer.from(TINY_PNG_BASE64, 'base64'),
    });

    await expect(page.getByTestId('reference-image-viewer')).toBeVisible();
    await page.getByTestId('btn-ref-zoom-in').click();
    await expect(page.getByTestId('ref-zoom-value')).toHaveText('115%');

    // 刷新页面后再次打开原谱对照，确认附件从 IndexedDB 恢复
    await page.reload();
    await expect(page.getByTestId('notebridge-app')).toBeVisible();
    await page.getByTestId('btn-toggle-reference').click();
    await expect(page.getByTestId('reference-image-viewer')).toBeVisible();

    await assertCleanRuntime(page, guards);
  });
});
