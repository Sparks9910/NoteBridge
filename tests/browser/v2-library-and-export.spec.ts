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

test.describe('L5 V2.0 乐谱库、模式切换、一键移调与无水印导出浏览器验证', () => {
  test('1. IndexedDB 乐谱库保存、缩略图、搜索、复制、删除与刷新持久化', async ({
    page,
  }) => {
    const guards = attachRuntimeGuards(page);
    await resetAllStorage(page);

    await page.getByTestId('score-title-input').fill('小步舞曲练习');
    await page.getByTestId('dur-quarter').click();
    for (const deg of [1, 2, 3, 5] as const) {
      await page.getByTestId(`key-degree-${deg}`).click();
    }
    await page.getByTestId('btn-save').click();
    await expect(page.getByTestId('save-status')).toHaveText('已保存');

    // 打开乐谱库并等待卡片出现
    await page.getByTestId('btn-open-library').click();
    await expect(page.getByTestId('library-view')).toBeVisible();

    const cards = page.locator('[data-testid^="library-card-"]');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('小步舞曲练习');
    await expect(cards.first().locator('.nb-library-thumb-img')).toBeVisible();

    // 复制曲谱
    await cards.first().locator('[data-testid^="btn-duplicate-"]').click();
    await expect(cards).toHaveCount(2);

    // 搜索过滤
    await page.getByTestId('library-search-input').fill('副本');
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('副本');

    // 删除副本并清空搜索
    await cards.first().locator('[data-testid^="btn-delete-score-"]').click();
    await page.getByTestId('library-search-input').fill('');
    await expect(cards).toHaveCount(1);

    // 刷新页面后重新打开乐谱库，确认 IndexedDB 持久化生效
    await page.reload();
    await page.getByTestId('btn-open-library').click();
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('小步舞曲练习');

    await assertCleanRuntime(page, guards);
  });

  test('2. 顶部「制谱对照 | 练谱模式」胶囊切换不修改文档保存状态', async ({
    page,
  }) => {
    const guards = attachRuntimeGuards(page);
    await resetAllStorage(page);

    await page.getByTestId('dur-quarter').click();
    await page.getByTestId('key-degree-1').click();
    await page.getByTestId('btn-save').click();
    await expect(page.getByTestId('save-status')).toHaveText('已保存');

    // 切至练谱模式：隐藏输入键盘，显示练谱条，保存状态保持已保存
    await page.getByTestId('mode-switch-practice').click();
    await expect(page.getByTestId('practice-mode-bar')).toBeVisible();
    await expect(page.getByTestId('key-degree-1')).toHaveCount(0);
    await expect(page.getByTestId('save-status')).toHaveText('已保存');

    // 切回制谱对照：输入键盘恢复
    await page.getByTestId('btn-practice-to-studio').click();
    await expect(page.getByTestId('key-degree-1')).toBeVisible();
    await expect(page.getByTestId('save-status')).toHaveText('已保存');

    await assertCleanRuntime(page, guards);
  });

  test('3. 一键移调弹窗（首调换调 + 固定调半音偏移）与撤销恢复', async ({
    page,
  }) => {
    const guards = attachRuntimeGuards(page);
    await resetAllStorage(page);

    await page.getByTestId('dur-quarter').click();
    for (const deg of [1, 3, 5] as const) {
      await page.getByTestId(`key-degree-${deg}`).click();
    }
    await expect(page.getByTestId('select-key-signature')).toHaveValue('C');

    // 首调换调 1=C -> 1=G
    await page.getByTestId('btn-open-transpose').click();
    await expect(page.getByTestId('transpose-modal')).toBeVisible();
    await page.getByTestId('transpose-target-key').selectOption('G');
    await page.getByTestId('btn-apply-transpose').click();
    await expect(page.getByTestId('select-key-signature')).toHaveValue('G');

    // 撤销回 1=C
    await page.getByTestId('btn-undo').click();
    await expect(page.getByTestId('select-key-signature')).toHaveValue('C');

    // 固定调 +2 半音：1 -> 2
    await page.getByTestId('btn-open-transpose').click();
    await page.getByTestId('transpose-strategy-fixed').check();
    await page.getByTestId('transpose-semitone-inc').click();
    await page.getByTestId('transpose-semitone-inc').click();
    await expect(page.getByTestId('transpose-semitone-value')).toContainText('+2');
    await page.getByTestId('btn-apply-transpose').click();

    await expect(page.getByTestId('select-key-signature')).toHaveValue('C');
    const firstJianpuDigit = page
      .locator('[data-testid="jianpu-layer"] [data-note-id] text')
      .first();
    await expect(firstJianpuDigit).toHaveText('2');

    await assertCleanRuntime(page, guards);
  });

  test('4. 无水印高清 PNG、A4 分页 PDF 与 JSON 备份文件导出验证', async ({
    page,
  }) => {
    const guards = attachRuntimeGuards(page);
    await resetAllStorage(page);

    await page.getByTestId('score-title-input').fill('晴空练习曲');
    await page.getByTestId('dur-quarter').click();
    for (const deg of [1, 2, 3, 5, 6, 5, 3, 1] as const) {
      await page.getByTestId(`key-degree-${deg}`).click();
    }

    await page.getByTestId('btn-open-export').click();
    await expect(page.getByTestId('export-modal')).toBeVisible();
    await page.getByTestId('export-meta-subtitle').fill('V2 导出验证');
    await page.getByTestId('export-meta-composer').fill('音桥');

    // 1) PNG 导出
    const [pngDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('btn-export-png').click(),
    ]);
    expect(pngDownload.suggestedFilename()).toBe('晴空练习曲.png');
    const pngPath = await pngDownload.path();
    expect(pngPath).toBeTruthy();
    if (pngPath) {
      const pngBytes = readFileSync(pngPath);
      expect(pngBytes.byteLength).toBeGreaterThan(1000);
      expect(pngBytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }

    // 2) PDF 导出
    const [pdfDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('btn-export-pdf').click(),
    ]);
    expect(pdfDownload.suggestedFilename()).toBe('晴空练习曲.pdf');
    const pdfPath = await pdfDownload.path();
    expect(pdfPath).toBeTruthy();
    if (pdfPath) {
      const pdfBytes = readFileSync(pdfPath);
      expect(pdfBytes.byteLength).toBeGreaterThan(1000);
      expect(pdfBytes.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
    }

    // 3) JSON 单曲备份导出
    const [jsonDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('btn-export-json').click(),
    ]);
    expect(jsonDownload.suggestedFilename()).toBe('晴空练习曲.notebridge.json');
    const jsonPath = await jsonDownload.path();
    if (jsonPath) {
      const parsed = JSON.parse(readFileSync(jsonPath, 'utf8'));
      expect(parsed.schemaVersion).toBe(2);
      expect(parsed.title).toBe('晴空练习曲');
      expect(parsed.subtitle).toBe('V2 导出验证');
    }

    await assertCleanRuntime(page, guards);
  });
});
