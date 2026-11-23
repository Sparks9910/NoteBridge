# NoteBridge（音桥）P0 MVP 测试用例矩阵与集成验收报告

> 核验日期：2026-11-23  
> 核验对象：NoteBridge P0 MVP 全量代码、L0–L6 自动化测试套件与 L7 真机未验收依赖清单  
> 权威依据：[01-范围与边界.md](01-范围与边界.md)、[02-架构与契约.md](02-架构与契约.md)

---

## 一、L0–L7 分层测试用例矩阵

### L0：构建、类型检查与配置门禁

| 用例编号 | 层级 | 覆盖模块 / 路径 | 测试文件 | 预期结果 | 本轮实测状态 |
|---|---|---|---|---|---|
| `TC-L0-01` | L0 | TypeScript 严格模式全工程编译检查 | [tsconfig.json](../tsconfig.json) | `tsc --noEmit` 退出码 `0`，零类型错误 | 已执行通过（退出码 `0`） |
| `TC-L0-02` | L0 | Vite 生产构建与产物生成 | [vite.config.ts](../vite.config.ts) | 生成 `dist/index.html` 与 JS/CSS 产物 | 已执行通过（1121 modules，退出码 `0`） |
| `TC-L0-03` | L0 | 默认环境变量、开发/测试开启演示开关、生产关闭演示开关 | [tests/config/config.test.ts](../tests/config/config.test.ts) | 按契约默认值与合法值正确解析 | 已执行通过（9 passed） |
| `TC-L0-04` | L0 | 生产环境（`VITE_APP_ENV=production`）同时开启 `VITE_ENABLE_DEMO_MODE=true` 强拦截 | [tests/config/config.test.ts](../tests/config/config.test.ts) | 立即抛出 `ConfigError`，`code === 'CONFIG_INVALID'` | 已执行通过 |
| `TC-L0-05` | L0 | `VITE_DEFAULT_BPM`（40..200）、`VITE_AUDIO_LOOKAHEAD_MS`（25..200）及命名空间边界校验 | [tests/config/config.test.ts](../tests/config/config.test.ts) | 非法值与越界值全部抛出 `CONFIG_INVALID` | 已执行通过 |
| `TC-L0-06` | L0 | 一键冒烟自检（基线文件、脚本入口、typecheck/build/test:config） | [scripts/smoke.mjs](../scripts/smoke.mjs) | 5 项冒烟检查全部 `[PASS]` | 已执行通过（5 passed / 0 failed） |

### L1：领域层乐理、时值、升降号与状态机单元测试

| 用例编号 | 层级 | 覆盖模块 / 路径 | 测试文件 | 预期结果 | 本轮实测状态 |
|---|---|---|---|---|---|
| `TC-L1-01` | L1 | 12 大调基准 MIDI 映射（A-05 假设）与首调↔固定调音名解析 | [tests/unit/theory.test.ts](../tests/unit/theory.test.ts) | 12 个调号音级 `1..7`、升降号、八度 `-2..+2` 与休止符映射精确 | 已执行通过（6 passed） |
| `TC-L1-02` | L1 | 高音谱号第三线 `B4` 符干朝向规则与跨小节累计 Tick | [tests/unit/theory.test.ts](../tests/unit/theory.test.ts) | 三线及以上朝下、三线以下朝上，Tick 累计准确 | 已执行通过 |
| `TC-L1-03` | L1 | `PPQ=480` 5 种基础时值与附点整数 Tick 换算、4 种拍号容量与状态判定 | [tests/unit/rhythm.test.ts](../tests/unit/rhythm.test.ts) | `EMPTY`/`UNDERFLOW`/`VALID`/`OVERFLOW` 与自动连杠分组准确 | 已执行通过（4 passed） |
| `TC-L1-04` | L1 | 同小节临时升降号去重、还原号作用域与跨小节重置 | [tests/unit/accidental.test.ts](../tests/unit/accidental.test.ts) | 调号自带升降不重复标注，临时还原后再升降显式标注 | 已执行通过（3 passed） |
| `TC-L1-05` | L1 | 4 个核心状态机（播放/输入面板/小节校验/文档持久化）合法与非法流转 | [tests/unit/state-machines.test.ts](../tests/unit/state-machines.test.ts) | 非法流转 100% 返回 `STATE_INVALID_TRANSITION` | 已执行通过（4 passed） |
| `TC-L1-06` | L1 | `LayoutSlot` 与简谱模型 0px 坐标对齐、`MockAudioEngine`、`StorageAdapter` | [tests/unit/layout-and-infra.test.ts](../tests/unit/layout-and-infra.test.ts) | 游标随 Tick 单调推进，存储配额/损坏异常正确转换 | 已执行通过（3 passed） |

### L2：应用层 Store 与持久化适配测试

| 用例编号 | 层级 | 覆盖模块 / 路径 | 测试文件 | 预期结果 | 本轮实测状态 |
|---|---|---|---|---|---|
| `TC-L2-01` | L2 | `scoreStore` 新建、参数校验、满拍自动增节（A-07）、超拍不阻断与删改修正 | [tests/service/score-store.test.ts](../tests/service/score-store.test.ts) | 状态计算精确，超拍后删改可恢复 `VALID` | 已执行通过（4 passed） |
| `TC-L2-02` | L2 | `scoreStore` Undo/Redo 历史栈、防抖自动保存、配额异常与演示模式开关 | [tests/service/score-store.test.ts](../tests/service/score-store.test.ts) | 历史回退重做一致，非演示模式拦截 `loadDemoScore` | 已执行通过 |
| `TC-L2-03` | L2 | `inputStore` 状态流转（`READY ↔ MODIFIER_ARMED`）、A-06 录入复位与锁定拦截 | [tests/service/input-store.test.ts](../tests/service/input-store.test.ts) | 录入后复位临时修饰并保留时值，锁定态拒绝录入 | 已执行通过（2 passed） |
| `TC-L2-04` | L2 | `PlaybackController` 播控生命周期、指定小节起播、循环、节拍器与故障恢复 | [tests/service/playback-controller.test.ts](../tests/service/playback-controller.test.ts) | 联动锁定/解锁 `inputStore`，音频失败回落 `ERROR` 并可重置 | 已执行通过（2 passed） |

### L3：数据结构、错误码与架构边界契约测试

| 用例编号 | 层级 | 覆盖模块 / 路径 | 测试文件 | 预期结果 | 本轮实测状态 |
|---|---|---|---|---|---|
| `TC-L3-01` | L3 | `ScoreDocument` 序列化往返与非法字段/损坏 JSON 中文错误码校验 | [tests/contract/contracts.test.ts](../tests/contract/contracts.test.ts) | 字段、单位、错误码 100% 符合契约 | 已执行通过（4 passed） |
| `TC-L3-02` | L3 | `PPQ=480` 时间单位换算与 `src/domain/*` 零浏览器/框架依赖静态扫描 | [tests/contract/contracts.test.ts](../tests/contract/contracts.test.ts) | `src/domain/*` 保持 100% 纯 TypeScript | 已执行通过 |

### L4：模拟音频与内存存储全链路端到端测试

| 用例编号 | 层级 | 覆盖模块 / 路径 | 测试文件 | 预期结果 | 本轮实测状态 |
|---|---|---|---|---|---|
| `TC-L4-01` | L4 | 业务闭环路径 1–9（新建→改调/拍号/BPM→录入预览→满拍/超拍→撤销/视图切换→播控/变速/起播→保存重载） | [tests/e2e/full-workflow.mock.test.ts](../tests/e2e/full-workflow.mock.test.ts) | 全链路无阻塞跑通，重载恢复数据与原文档深相等 | 已执行通过（2 passed） |
| `TC-L4-02` | L4 | 业务路径 10（非生产演示模式载入《小星星》循环播放与变速闭环） | [tests/e2e/full-workflow.mock.test.ts](../tests/e2e/full-workflow.mock.test.ts) | 成功载入《小星星》并完成循环播控与变速 | 已执行通过 |

### L5：Playwright 真实无头浏览器渲染与交互验证

| 用例编号 | 层级 | 覆盖模块 / 路径 | 测试文件 | 预期结果 | 本轮实测状态 |
|---|---|---|---|---|---|
| `TC-L5-01` | L5 | 默认非演示模式 + `1=G` 复杂符号录入与双谱真实渲染 X 坐标对齐（`<= 2px`） | [tests/browser/notebridge.spec.ts](../tests/browser/notebridge.spec.ts) | 实测偏差 `0px–0.1px`，`console.error` 与 `pageerror` 为 `0` | 已执行通过（[step6-dual-view.png](evidence/step6-dual-view.png)） |
| `TC-L5-02` | L5 | `4/4` 满拍自动增节、超拍红色告警（`OVERFLOW`）与删除修正恢复 `VALID` | [tests/browser/notebridge.spec.ts](../tests/browser/notebridge.spec.ts) | 满拍自动增节，超拍展示中文红色告警并可删改恢复 | 已执行通过（[step6-overflow-alert.png](evidence/step6-overflow-alert.png)） |
| `TC-L5-03` | L5 | 视图模式三态（双谱对照 / 仅简谱 / 仅五线谱）无损切换 | [tests/browser/notebridge.spec.ts](../tests/browser/notebridge.spec.ts) | 对应 SVG 图层显隐正确，音符数量与内容无丢失 | 已执行通过 |
| `TC-L5-04` | L5 | 播放控制、面板锁定（`disabled`）、游标推进与暂停/继续/停止解锁 | [tests/browser/notebridge.spec.ts](../tests/browser/notebridge.spec.ts) | 播放态锁定录入、`.nb-playback-cursor` 横坐标推进、停止后解锁 | 已执行通过 |
| `TC-L5-05` | L5 | 本地保存（`已保存`）与 `page.reload()` 刷新重载完整恢复 | [tests/browser/notebridge.spec.ts](../tests/browser/notebridge.spec.ts) | 标题、`1=D`、`3/4`、`116 BPM` 与 3 个音符完整恢复 | 已执行通过 |
| `TC-L5-06` | L5 | 受控演示模式（`VITE_ENABLE_DEMO_MODE=true`）展示徽标并载入《小星星》 | [tests/browser/notebridge.spec.ts](../tests/browser/notebridge.spec.ts) | 展示「演示环境」徽标，载入《小星星》且 X 偏差 `0.1px–0.21px` | 已执行通过（[step6-demo-mode.png](evidence/step6-demo-mode.png)） |

### L6：非功能性能压测、高频稳定性与安全扫描

| 用例编号 | 层级 | 覆盖模块 / 路径 | 测试文件 | 预期结果 | 本轮实测状态 |
|---|---|---|---|---|---|
| `TC-L6-01` | L6 | 100 小节（500 音符）长谱解析、共享布局、简谱模型、序列化与批量持久化 | [tests/nonfunc/performance-and-safety.test.ts](../tests/nonfunc/performance-and-safety.test.ts) | 各项耗时 `< 500ms`（批量入库 `< 1500ms`），实测 `1.33ms–16.39ms` | 已执行通过（4 passed） |
| `TC-L6-02` | L6 | 高频连续录入 120 音符、50 次 Undo/Redo 与播放期 40 次调速/节拍器切换 | [tests/nonfunc/performance-and-safety.test.ts](../tests/nonfunc/performance-and-safety.test.ts) | 历史栈上限 `<= 100` 生效，小节索引连续，状态机无异常残留 | 已执行通过 |
| `TC-L6-03` | L6 | 10 类业务/配置/存储错误路径中文提示校验 + `src/ui/*` 单向依赖静态扫描 | [tests/nonfunc/performance-and-safety.test.ts](../tests/nonfunc/performance-and-safety.test.ts) | 所有 `AppError.detail` 为中文且零英文堆栈，UI 零越界导入 | 已执行通过 |
| `TC-L6-04` | L6 | 音频解锁失败与音源加载失败中文错误校验 | [tests/nonfunc/performance-and-safety.test.ts](../tests/nonfunc/performance-and-safety.test.ts) | 返回 `AUDIO_CONTEXT_BLOCKED`/`AUDIO_SOUNDFONT_LOAD_FAILED` 中文提示 | 已执行通过 |

### L7：真机人工联调（未验收项）

| 用例编号 | 层级 | 验收目标 | 当前状态 | 缺失条件 |
|---|---|---|---|---|
| `TC-L7-01` | L7 | 真实声卡钢琴采样听觉质量、节拍器音色与主观延迟 | 未验收 | 缺带物理音频输出设备的真机人工听测环境 |
| `TC-L7-02` | L7 | 移动端（iOS / Android）触控手感与 iOS Safari 首次手势音频解锁 | 未验收 | 缺 iOS / Android 真实移动测试设备 |
| `TC-L7-03` | L7 | 移动端原生 `.sf2` SoundFont 音源集成 | 未验收 | 缺移动端原生壳工程与授权合规的 `.sf2` 音源文件 |

---

## 二、P0 MVP 完成定义核对清单（对应 `docs/01-范围与边界.md` 第四节）

- [x] 新建曲谱后默认以 `1=C`、`4/4`、`90 BPM` 初始化，支持 `1=C` 至 `1=B` 全部 12 个调号首调→固定调实时转译与自动升降号渲染。（证据：`TC-L1-01`、`TC-L2-01`、`TC-L5-01`）
- [x] 支持 `2/4`、`3/4`、`4/4`、`6/8` 四种拍号及 `40–200 BPM` 速度调节，切换参数后已有曲谱实时重译且无错乱。（证据：`TC-L1-03`、`TC-L4-01`、`TC-L5-05`）
- [x] 状态切换式虚拟简谱面板支持数字 `1–7`、休止符 `0`、高低音点（`-2..+2` 八度）、升降号（`#` / `b`）、增减时线（全/二分/四分/八分/十六分）、附点与小节线录入。（证据：`TC-L2-03`、`TC-L5-01`）
- [x] 严格按 `480 Ticks = 1 拍` 校验小节时值，满拍自动开启下一小节，不足拍显示 `UNDERFLOW` 提示，超拍显示 `OVERFLOW` 红色告警。（证据：`TC-L1-03`、`TC-L2-01`、`TC-L5-02`）
- [x] 五线谱自动处理符干朝向、按拍自动连杠（Beam）及同小节临时升降/还原号规则，并与简谱保持逐拍垂直 X 坐标对齐。（证据：`TC-L1-02`、`TC-L1-04`、`TC-L5-01` 实测偏差 `<= 0.21px`）
- [x] 支持「双谱对照」「单简谱」「单五线谱」三种视图模式无损切换。（证据：`TC-L2-01`、`TC-L5-03`）
- [x] 录入音符即时播放对应音高预览音；全曲播放支持播放、暂停、停止、指定小节起播、循环播放、节拍器开关及 `40–200 BPM` 实时变速。（证据：`TC-L2-04`、`TC-L4-01`、`TC-L5-04`）
- [x] 播放期间由 Web Audio 时钟预调度驱动，双谱同步逐音高亮与平滑游标推进无明显肉眼错位，且虚拟录入面板自动锁定。（证据：`TC-L4-01`、`TC-L5-04`）
- [x] 支持工程自动/手动保存至 `localStorage` 并通过刷新浏览器完整恢复。（证据：`TC-L2-02`、`TC-L5-05`）
- [x] `VITE_ENABLE_DEMO_MODE` 默认为 `false`；生产环境开启该开关时启动阶段立即失败；演示环境下页面明确展示「演示环境」标识。（证据：`TC-L0-04`、`TC-L5-01`、`TC-L5-06`）
- [x] L0–L6 自动化测试全部通过，无 S1 / S2 级别未闭环缺陷，页面全程无英文原始异常或堆栈信息暴露。（证据：`TC-L5-01..06`、`TC-L6-03..04`、[06-acceptance-report.txt](evidence/06-acceptance-report.txt)）

---

## 三、本轮验收发现与闭环缺陷表

| 缺陷编号 | 复现步骤 | 根因分析 | 修复位置 | 回归验证结论 |
|---|---|---|---|---|
| `BUG-STEP6-01` | 运行 L5 用例 1 与用例 6，校验五线谱与简谱真实渲染中心 X 坐标对齐 | `staff-renderer.ts` 原先将 VexFlow 符头左边缘（`getAbsoluteX()`）对齐到 `slot.x`，且未在 `preFormat()` 前绑定 SVG 上下文，导致符头中心较简谱数字居中点向右偏移 `6px–8.9px` | [src/rendering/staff-renderer.ts](../src/rendering/staff-renderer.ts#L139-L157) | 修复后复测用例 1 与用例 6，全部音符偏差收敛至 `0px–0.21px`（远低于 `<= 2px` 准出线） |
| `BUG-STEP6-02` | 运行 L5 全量用例，页面加载与刷新时监听 `console.error` | `index.html` 未声明 `<link rel="icon">`，无头 Chrome 自动请求 `/favicon.ico` 触发 Vite 返回 404，产生 2 条控制台 `Failed to load resource (404)` 报错 | [index.html](../index.html#L6) | 补充内联 SVG data URI 图标后，全部 6 个 L5 用例 `console.error` 与 `pageerror` 均为 `0` |

---

## 四、L7 未验收依赖清单（对应 `docs/01-范围与边界.md` 第五节）

| 依赖项 | 当前状态与缺失条件 | 说明 |
|---|---|---|
| 真实声卡听觉质量与延迟验收 | 未验收 + 缺带物理音频输出设备的真机人工听测环境 | 自动化测试仅验证音频引擎状态流转与调度逻辑，音色听感需真机复测 |
| 移动端（iOS / Android）触控与音频解锁 | 未验收 + 缺 iOS/Android 真实移动测试设备 | 特别是 iOS Safari 手势触发 `AudioContext.resume()` 兼容性需真机实测 |
| 移动端原生 `.sf2` SoundFont 音源集成 | 未验收 + 缺移动端原生壳工程与授权合规的 `.sf2` 音源文件 | P0 聚焦 Web 端 `smplr` 采样方案 |
| 真实生产域名 HTTPS 静态托管 | 未验收 + 缺生产域名、TLS 证书与托管平台凭据 | 本轮不做网络部署 |
| P2 拍照识谱（OMR）外部服务 | 未验收 + 缺商业 OMR SDK 凭据或 GPU 推理服务环境 | 属于 P2 远期规划，不在 P0 交付范围内 |
