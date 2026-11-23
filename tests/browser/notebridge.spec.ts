import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';

const SCREENSHOT_DIR =
  process.env.NB_SCREENSHOT_DIR ?? 'test-results/screenshots';
const DEMO_URL = 'http://127.0.0.1:5174';
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
  expect(guards.consoleErrors, '控制台不应出现 error 级别报错').toEqual([]);
  expect(guards.pageErrors, '页面不应出现未捕获 pageerror').toEqual([]);
  const bodyText = await page.locator('body').innerText();
  expect(
    bodyText,
    '页面文本不应暴露英文异常或堆栈信息'
  ).not.toMatch(STACK_OR_ENGLISH_ERROR_REGEX);
}

async function resetAppStorage(page: Page, url = '/'): Promise<void> {
  await page.goto(url);
  await page.evaluate(() => {
    window.localStorage.clear();
  });
  await page.reload();
  await expect(page.getByTestId('notebridge-app')).toBeVisible();
}

async function measureDualStaffAlignment(
  page: Page,
  maxNotesToCheck?: number
): Promise<Array<{ noteId: string; diffPx: number; anchorDiffPx: number }>> {
  const results = await page.evaluate((limit) => {
    const staffNodes = Array.from(
      document.querySelectorAll('[data-testid="staff-layer"] [data-note-id]')
    );
    const items = typeof limit === 'number' ? staffNodes.slice(0, limit) : staffNodes;

    return items.map((staffEl) => {
      const noteId = staffEl.getAttribute('data-note-id') ?? '';
      const jianpuEl = document.querySelector(
        `[data-testid="jianpu-layer"] [data-note-id="${noteId}"]`
      );
      if (!jianpuEl) {
        return {
          noteId,
          missingJianpu: true,
          diffPx: 9999,
          anchorDiffPx: 9999,
        };
      }

      const staffAnchor = Number(staffEl.getAttribute('data-anchor-x') ?? 'NaN');
      const jianpuAnchor = Number(
        jianpuEl.getAttribute('data-anchor-x') ?? 'NaN'
      );
      const anchorDiffPx = Math.abs(staffAnchor - jianpuAnchor);

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
        missingJianpu: false,
        diffPx: Math.round(Math.abs(staffCenterX - jianpuCenterX) * 100) / 100,
        anchorDiffPx: Math.round(anchorDiffPx * 100) / 100,
      };
    });
  }, maxNotesToCheck);

  expect(results.length).toBeGreaterThan(0);
  for (const item of results) {
    expect(item.missingJianpu).toBe(false);
    expect(item.anchorDiffPx).toBeLessThanOrEqual(0.01);
    expect(
      item.diffPx,
      `音符 ${item.noteId} 双谱真实中心 X 偏差 ${item.diffPx}px 应 <= 2px`
    ).toBeLessThanOrEqual(2);
  }
  return results;
}

function saveScreenshotPath(filename: string): string {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  return join(SCREENSHOT_DIR, filename);
}

test.describe('L5 NoteBridge 无头浏览器全链路验证', () => {
  test('1. 默认非演示模式 + 1=G 复杂符号录入与双谱 X 坐标严格对齐 (<= 2px)', async ({
    page,
  }) => {
    const guards = attachRuntimeGuards(page);
    await resetAppStorage(page, '/');

    await expect(page.getByTestId('demo-mode-banner')).toHaveCount(0);

    // 切换调号为 1=G
    await page.getByTestId('select-key-signature').selectOption('G');

    // 录入 5 个音符凑满 4/4 拍（480*4 = 1920 ticks）：
    // 1) 四分音符 1 + # + 高八度 (+1) [480]
    await page.getByTestId('dur-quarter').click();
    await page.getByTestId('mod-sharp').click();
    await page.getByTestId('mod-octave-up').click();
    await page.getByTestId('key-degree-1').click();

    // 2) 附点四分音符 3 + 低八度 (-1) [720]
    await page.getByTestId('mod-dotted').click();
    await page.getByTestId('mod-octave-down').click();
    await page.getByTestId('key-degree-3').click();

    // 3) 八分音符 5 [240]
    await page.getByTestId('dur-eighth').click();
    await page.getByTestId('key-degree-5').click();

    // 4) 八分音符 6（与 5 自动连杠）[240]
    await page.getByTestId('key-degree-6').click();

    // 5) 八分休止符 0 [240] -> 累计 1920 ticks，自动开启第 2 小节
    await page.getByTestId('key-rest-0').click();

    await expect(page.getByTestId('measure-status-0')).toHaveAttribute(
      'data-validity',
      'VALID'
    );
    await expect(page.getByTestId('measure-status-1')).toHaveAttribute(
      'data-validity',
      'EMPTY'
    );

    const alignment = await measureDualStaffAlignment(page);
    console.log(
      '[L5-ALIGN-1G]',
      alignment.map((a) => `${a.noteId}:${a.diffPx}px`).join(', ')
    );

    await page.screenshot({
      path: saveScreenshotPath('step6-dual-view.png'),
      fullPage: true,
    });

    await assertCleanRuntime(page, guards);
  });

  test('2. 小节满拍自动增节、超拍红色告警与删除修正恢复', async ({ page }) => {
    const guards = attachRuntimeGuards(page);
    await resetAppStorage(page, '/');

    // 4/4 拍第 1 小节录满 4 个四分音符 -> 自动开启第 2 小节
    await page.getByTestId('dur-quarter').click();
    for (const deg of [1, 2, 3, 5] as const) {
      await page.getByTestId(`key-degree-${deg}`).click();
    }
    await expect(page.getByTestId('measure-status-0')).toHaveAttribute(
      'data-validity',
      'VALID'
    );
    await expect(page.getByTestId('measure-status-1')).toHaveAttribute(
      'data-validity',
      'EMPTY'
    );

    // 在第 2 小节录入全音符 1 -> 满拍自动跳至第 3 小节；定位回第 2 小节末尾再录四分音符 2 触发超拍
    await page.getByTestId('dur-whole').click();
    await page.getByTestId('key-degree-1').click();
    await expect(page.getByTestId('measure-status-1')).toHaveAttribute(
      'data-validity',
      'VALID'
    );

    await page.getByTestId('measure-select-1').click();
    await page.getByTestId('dur-quarter').click();
    await page.getByTestId('key-degree-2').click();

    const status1 = page.getByTestId('measure-status-1');
    await expect(status1).toHaveAttribute('data-validity', 'OVERFLOW');
    await expect(status1).toContainText('超拍');
    await expect(
      page.locator('[data-testid="staff-layer"] [data-overflow-measure="1"]')
    ).toHaveCount(1);
    await expect(
      page.locator('[data-testid="jianpu-layer"] [data-overflow-measure="1"]')
    ).toHaveCount(1);

    await page.screenshot({
      path: saveScreenshotPath('step6-overflow-alert.png'),
      fullPage: true,
    });

    // 删除超拍音符恢复 VALID
    await page.getByTestId('btn-delete-note').click();
    await expect(status1).toHaveAttribute('data-validity', 'VALID');
    await expect(status1).toContainText('满拍');
    await expect(
      page.locator('[data-overflow-measure="1"]')
    ).toHaveCount(0);

    await assertCleanRuntime(page, guards);
  });

  test('3. 视图模式三态（双谱对照 / 仅简谱 / 仅五线谱）无损切换', async ({
    page,
  }) => {
    const guards = attachRuntimeGuards(page);
    await resetAppStorage(page, '/');

    await page.getByTestId('dur-quarter').click();
    for (const deg of [1, 2, 3, 4] as const) {
      await page.getByTestId(`key-degree-${deg}`).click();
    }

    const staffNotes = page.locator(
      '[data-testid="staff-layer"] [data-note-id]'
    );
    const jianpuNotes = page.locator(
      '[data-testid="jianpu-layer"] [data-note-id]'
    );

    await expect(staffNotes).toHaveCount(4);
    await expect(jianpuNotes).toHaveCount(4);

    // 切换至仅简谱
    await page.getByTestId('btn-view-jianpu').click();
    await expect(page.getByTestId('score-canvas-stage')).toHaveAttribute(
      'data-view-mode',
      'jianpu'
    );
    await expect(staffNotes).toHaveCount(0);
    await expect(jianpuNotes).toHaveCount(4);

    // 切换至仅五线谱
    await page.getByTestId('btn-view-staff').click();
    await expect(page.getByTestId('score-canvas-stage')).toHaveAttribute(
      'data-view-mode',
      'staff'
    );
    await expect(staffNotes).toHaveCount(4);
    await expect(jianpuNotes).toHaveCount(0);

    // 切回双谱对照并校验音符完整保留
    await page.getByTestId('btn-view-dual').click();
    await expect(page.getByTestId('score-canvas-stage')).toHaveAttribute(
      'data-view-mode',
      'dual'
    );
    await expect(staffNotes).toHaveCount(4);
    await expect(jianpuNotes).toHaveCount(4);

    await assertCleanRuntime(page, guards);
  });

  test('4. 播放控制、输入面板锁定、游标推进与暂停/继续/停止恢复解锁', async ({
    page,
  }) => {
    const guards = attachRuntimeGuards(page);
    await resetAppStorage(page, '/');

    // 录入 8 个四分音符（90 BPM 下总长 > 5 秒，确保有充足窗口验证游标与暂停）
    await page.getByTestId('dur-quarter').click();
    for (const deg of [1, 2, 3, 4, 5, 6, 7, 1] as const) {
      await page.getByTestId(`key-degree-${deg}`).click();
    }

    await page.getByTestId('toggle-metronome').check();
    await page.getByTestId('btn-play').click();

    await expect(page.getByTestId('playback-status')).toContainText('播放中');
    await expect(page.getByTestId('keypad-locked-notice')).toBeVisible();

    // 确认录入区按钮全部 disabled
    for (const testId of [
      'key-degree-1',
      'key-degree-7',
      'key-rest-0',
      'dur-quarter',
      'mod-sharp',
      'btn-delete-note',
      'btn-insert-barline',
    ]) {
      await expect(page.getByTestId(testId)).toBeDisabled();
    }

    // 校验播放游标可见且横坐标随时间推进
    const cursor = page.locator('.nb-playback-cursor');
    await expect(cursor).toBeVisible();
    const x1 = Number((await cursor.getAttribute('data-cursor-x')) ?? '0');
    await page.waitForTimeout(400);
    const x2 = Number((await cursor.getAttribute('data-cursor-x')) ?? '0');
    expect(x2).toBeGreaterThan(x1);

    // 暂停 -> 继续 -> 停止
    await page.getByTestId('btn-pause').click();
    await expect(page.getByTestId('playback-status')).toContainText('已暂停');
    await expect(page.getByTestId('btn-resume')).toBeVisible();

    await page.getByTestId('btn-resume').click();
    await expect(page.getByTestId('playback-status')).toContainText('播放中');

    await page.getByTestId('btn-stop').click();
    await expect(page.getByTestId('playback-status')).toContainText('空闲就绪');
    await expect(page.getByTestId('keypad-locked-notice')).toHaveCount(0);
    await expect(page.getByTestId('key-degree-1')).toBeEnabled();

    await assertCleanRuntime(page, guards);
  });

  test('5. 本地保存与页面刷新重载后完整恢复曲谱数据与参数', async ({
    page,
  }) => {
    const guards = attachRuntimeGuards(page);
    await resetAppStorage(page, '/');

    await page.getByTestId('score-title-input').fill('音桥重载恢复测试曲');
    await page.getByTestId('select-key-signature').selectOption('D');
    await page.getByTestId('select-time-signature').selectOption('3/4');
    await page.getByTestId('input-bpm-number').fill('116');

    await page.getByTestId('dur-quarter').click();
    for (const deg of [1, 3, 5] as const) {
      await page.getByTestId(`key-degree-${deg}`).click();
    }

    await page.getByTestId('btn-save').click();
    await expect(page.getByTestId('save-status')).toHaveText('已保存');

    await page.reload();

    await expect(page.getByTestId('score-title-input')).toHaveValue(
      '音桥重载恢复测试曲'
    );
    await expect(page.getByTestId('select-key-signature')).toHaveValue('D');
    await expect(page.getByTestId('select-time-signature')).toHaveValue('3/4');
    await expect(page.getByTestId('input-bpm-number')).toHaveValue('116');
    await expect(
      page.locator('[data-testid="staff-layer"] [data-note-id]')
    ).toHaveCount(3);
    await expect(
      page.locator('[data-testid="jianpu-layer"] [data-note-id]')
    ).toHaveCount(3);

    await assertCleanRuntime(page, guards);
  });

  test('6. 受控演示模式（VITE_ENABLE_DEMO_MODE=true）展示徽标并一键载入《小星星》', async ({
    page,
  }) => {
    const guards = attachRuntimeGuards(page);
    await resetAppStorage(page, DEMO_URL);

    const banner = page.getByTestId('demo-mode-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('演示环境');

    await page.getByTestId('btn-load-demo').click();
    await expect(page.getByTestId('score-title-input')).toHaveValue(/小星星/);

    const staffCount = await page
      .locator('[data-testid="staff-layer"] [data-note-id]')
      .count();
    const jianpuCount = await page
      .locator('[data-testid="jianpu-layer"] [data-note-id]')
      .count();
    expect(staffCount).toBeGreaterThanOrEqual(28);
    expect(jianpuCount).toBe(staffCount);

    const demoAlignment = await measureDualStaffAlignment(page, 8);
    console.log(
      '[L5-ALIGN-DEMO]',
      demoAlignment.map((a) => `${a.noteId}:${a.diffPx}px`).join(', ')
    );

    await page.screenshot({
      path: saveScreenshotPath('step6-demo-mode.png'),
      fullPage: true,
    });

    await assertCleanRuntime(page, guards);
  });
});
