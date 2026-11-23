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

test.describe('L5 V2.2 练谱模式（电吉他 TAB/24品指板、钢琴88键、通用练琴引擎）', () => {
  test('1. 电吉他练谱模式：VexFlow 六线谱 TAB、24 品指板、调弦/Capo 重算与双谱对齐零污染', async ({
    page,
  }) => {
    const guards = attachRuntimeGuards(page);
    await resetAllStorage(page);

    await page.getByTestId('score-title-input').fill('电吉他练谱测试');
    await page.getByTestId('dur-quarter').click();
    for (const deg of [1, 2, 3, 5] as const) {
      await page.getByTestId(`key-degree-${deg}`).click();
    }
    await page.getByTestId('btn-save').click();
    await expect(page.getByTestId('save-status')).toHaveText('已保存');

    // 切换至练谱模式并选择电吉他
    await page.getByTestId('mode-switch-practice').click();
    await expect(page.getByTestId('practice-mode-bar')).toBeVisible();
    await page.getByTestId('practice-inst-electric-guitar').click();

    await expect(page.getByTestId('guitar-fretboard-dock')).toBeVisible();
    const tabNotes = page.locator('[data-testid="tab-layer"] [data-tab-note-id]');
    await expect(tabNotes).toHaveCount(4);
    await expect(
      page.locator('[data-testid="tab-layer"] [data-note-id]')
    ).toHaveCount(0);

    // 打开简谱图层以核对三谱并存时既有双谱对齐 <= 2px
    await page.getByTestId('practice-layer-jianpu').click();
    const alignment = await page.evaluate(() => {
      const staffNodes = Array.from(
        document.querySelectorAll('[data-testid="staff-layer"] [data-note-id]')
      );
      return staffNodes.map((staffEl) => {
        const noteId = staffEl.getAttribute('data-note-id') ?? '';
        const jianpuEl = document.querySelector(
          `[data-testid="jianpu-layer"] [data-note-id="${noteId}"]`
        );
        const tabEl = document.querySelector(
          `[data-testid="tab-layer"] [data-tab-note-id="${noteId}"]`
        );
        const noteHeadEl =
          staffEl.querySelector('.vf-notehead text') ??
          staffEl.querySelector('.vf-notehead') ??
          staffEl;
        const jianpuDigitEl = jianpuEl?.querySelector('text') ?? jianpuEl;
        const staffRect = noteHeadEl.getBoundingClientRect();
        const jianpuRect = jianpuDigitEl?.getBoundingClientRect();
        const diffPx = jianpuRect
          ? Math.abs(
              staffRect.left +
                staffRect.width / 2 -
                (jianpuRect.left + jianpuRect.width / 2)
            )
          : 999;
        return {
          noteId,
          diffPx,
          staffAnchor: Number(staffEl.getAttribute('data-anchor-x') ?? '0'),
          tabAnchor: Number(tabEl?.getAttribute('data-anchor-x') ?? '-1'),
        };
      });
    });

    expect(alignment).toHaveLength(4);
    for (const item of alignment) {
      expect(item.diffPx).toBeLessThanOrEqual(2);
      expect(Math.abs(item.staffAnchor - item.tabAnchor)).toBeLessThanOrEqual(
        0.01
      );
    }

    // 切换过载音色、Drop D 调弦与 Capo 2 品
    await page.getByTestId('guitar-tone-od').click();
    await expect(page.getByTestId('guitar-tone-od')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await page.getByTestId('select-tuning-preset').selectOption('drop-d-6');
    await page.getByTestId('select-capo').selectOption('2');
    await expect(page.getByTestId('fretboard-capo-bar')).toBeVisible();
    await expect(page.getByTestId('tab-capo-badge')).toContainText('Capo 2');

    // 点击 TAB 第 1 音选中后点击指板同音高格修改把位并重置
    await tabNotes.first().click();
    await expect(page.getByTestId('fretboard-active-dot')).toBeVisible();
    await expect(page.getByTestId('fret-candidate-list')).toBeVisible();
    const secondCand = page
      .locator('[data-testid="fret-candidate-list"] button')
      .nth(1);
    await secondCand.click();
    await expect(page.getByTestId('btn-reset-manual-frets')).toBeVisible();
    await page.getByTestId('btn-reset-manual-frets').click();
    await expect(page.getByTestId('btn-reset-manual-frets')).toHaveCount(0);

    // 练谱全程不标脏文档
    await expect(page.getByTestId('save-status')).toHaveText('已保存');
    await assertCleanRuntime(page, guards);
  });

  test('2. 钢琴 88 键面板与单手静音、电贝斯 4/5 弦切换及通用旋律字幕面板', async ({
    page,
  }) => {
    const guards = attachRuntimeGuards(page);
    await resetAllStorage(page);

    await page.getByTestId('dur-quarter').click();
    await page.getByTestId('key-degree-1').click();
    await page.getByTestId('btn-save').click();
    await expect(page.getByTestId('save-status')).toHaveText('已保存');

    await page.getByTestId('mode-switch-practice').click();

    // 1) 钢琴模式：88 键与左右手静音
    await page.getByTestId('practice-inst-piano').click();
    await expect(page.getByTestId('piano-keys-dock')).toBeVisible();
    await expect(
      page.locator('[data-testid="piano-88-keyboard"] [data-piano-midi]')
    ).toHaveCount(88);
    await page.getByTestId('toggle-mute-right-hand').check();
    await page.getByTestId('toggle-mute-left-hand').check();
    await expect(page.getByTestId('piano-keys-dock')).toContainText('已静音');
    await page.getByTestId('piano-key-60').click();

    // 2) 电贝斯模式：4 弦 -> 5 弦切换
    await page.getByTestId('practice-inst-bass').click();
    await expect(page.getByTestId('guitar-fretboard-dock')).toBeVisible();
    await expect(
      page.locator('[data-testid="guitar-fretboard-dock"] [data-fret="0"]')
    ).toHaveCount(4);
    await page
      .getByTestId('select-tuning-preset')
      .selectOption('bass-5-standard');
    await expect(
      page.locator('[data-testid="guitar-fretboard-dock"] [data-fret="0"]')
    ).toHaveCount(5);

    // 3) 通用旋律模式：歌词与音名提示面板
    await page.getByTestId('practice-inst-melody').click();
    await expect(page.getByTestId('melody-lyric-dock')).toBeVisible();

    await expect(page.getByTestId('save-status')).toHaveText('已保存');
    await assertCleanRuntime(page, guards);
  });

  test('3. A-B 区间循环、预备拍、渐进提速配置与键盘快捷控播（含输入框防误触）', async ({
    page,
  }) => {
    const guards = attachRuntimeGuards(page);
    await resetAllStorage(page);

    // 录入 2 小节（8 个四分音符）
    await page.getByTestId('dur-quarter').click();
    for (let i = 0; i < 8; i += 1) {
      await page.getByTestId(`key-degree-${(i % 7) + 1}`).click();
    }
    await page.getByTestId('btn-save').click();
    await expect(page.getByTestId('save-status')).toHaveText('已保存');

    await page.getByTestId('mode-switch-practice').click();

    // 配置 A-B 循环（第 2 小节）、预备拍、渐进提速
    await page.getByTestId('toggle-ab-loop').check();
    await page.getByTestId('select-loop-start').selectOption('1');
    await page.getByTestId('select-loop-end').selectOption('1');
    await page.getByTestId('toggle-count-in').check();
    await page.getByTestId('toggle-speed-trainer').check();
    await page.getByTestId('input-speed-start').fill('80');
    await page.getByTestId('input-speed-step').fill('10');
    await page.getByTestId('input-speed-target').fill('100');
    await expect(page.getByTestId('speed-trainer-status')).toContainText(
      '80% · 第1轮'
    );

    // 输入框聚焦时按 Space 不得触发播放
    await page.getByTestId('input-speed-start').focus();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('playback-status')).toContainText('空闲就绪');

    // 失焦后按 Space 触发播放（或停止），按 R 回到 A 点
    await page.getByTestId('input-speed-start').blur();
    await page.getByTestId('practice-mode-bar').click();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('playback-status')).toContainText(
      /正在加载音源|播放中/
    );
    await page.getByTestId('btn-stop').click();
    await expect(page.getByTestId('playback-status')).toContainText('空闲就绪');

    await expect(page.getByTestId('save-status')).toHaveText('已保存');
    await assertCleanRuntime(page, guards);
  });
});
