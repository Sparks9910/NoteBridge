# 00 · 轮次交接回执

```text
ROLE: 架构与环境基线负责人（第 3 步）
STATUS: DONE
BRANCH: main
COMMIT: NONE（基于基线提交 e2ceb5c，本轮未提交）
CHANGED:
- package.json:1-36 初始化工程依赖（react/react-dom/zustand/vexflow/tonal@6.0.0/tone/smplr 及 typescript/vite/vitest/@playwright/test）与 AGENTS.md 第六节约定的全部 npm 脚本入口
- package-lock.json:1-end 生成 npm 依赖锁文件
- tsconfig.json:1-22 配置 TypeScript 严格模式（strict / noUnusedLocals / noUnusedParameters / noUncheckedIndexedAccess）
- vite.config.ts:1-14 配置 Vite + React + Vitest（5173 端口与 node 测试环境）
- index.html:1-12 新建最小 HTML 入口
- src/main.tsx:1-13 新建 React 最小挂载入口
- src/App.tsx:1-8 新建最小占位组件（无业务逻辑）
- src/domain/types.ts:1-153 建立 GATE-0 共享数据结构（PPQ=480、ScoreDocument、Measure、NoteEvent、ResolvedNote、LayoutSlot、AppError、Result、ErrorCode 及 4 个状态机类型）
- src/infrastructure/config.ts:1-162 实现 5 个环境变量校验与生产环境开启演示开关强拦截（CONFIG_INVALID）
- tests/config/config.test.ts:1-103 编写 L0 配置默认值、边界值与生产门禁测试（9 个用例）
- scripts/smoke.mjs:1-118 编写一键冒烟自检脚本
- docs/evidence/00-baseline.txt:1-84 留存脱敏环境表与四条基准命令完整实测证据
- docs/00-HANDOFF.md:1-38 更新本轮交接回执与实测命令记录
COMMANDS:
- node -v; npm -v; git status -sb -> 退出码 0 -> Node v24.15.0 / npm 11.12.1 / main...origin/main
- npm run typecheck -> 退出码 0 -> 通过（tsc --noEmit 无报错）
- npm run build -> 退出码 0 -> 通过（15 modules，生成 dist/index.html 与 dist/assets/index-DetIz8OD.js）
- npm run test:config -> 退出码 0 -> 9 passed / 0 failed / 0 skipped（1 个测试文件）
- npm run smoke -> 退出码 0 -> 5 passed / 0 failed
- npm run test:unit / test:service / test:contract / test:e2e:mock / test:browser / test:nonfunc -> 未执行（对应测试目录待第 4-6 步创建）
INTERFACES:
- src/domain/types.ts 导出 GATE-0 共享契约：PPQ、ErrorCode、AppError、Result<T>、KeySignature、TimeSignature、ViewMode、BaseDuration、Accidental、NoteEvent、Measure、ScoreDocument、ResolvedNote、LayoutSlot、PlaybackState、InputPadState、MeasureValidityState、DocumentState
- src/infrastructure/config.ts 导出 AppEnv、AppConfig、ConfigError、loadConfig(env?)、appConfig；VITE_APP_ENV === 'production' 且 VITE_ENABLE_DEMO_MODE === 'true' 时启动即抛出 ConfigError（code: 'CONFIG_INVALID'）
- package.json 固定全部 L0-L6 与 smoke 脚本入口；注意当前 npmmirror 源下 tonal 固定为 6.0.0（6.9.0 依赖的 @tonaljs/voice-leading@5.1.8 在镜像源缺失）
ASSUMPTIONS:
- 沿用 docs/02-架构与契约.md 既定假设 A-01 至 A-10，未新增业务假设
BLOCKERS:
- NONE
NEXT:
- 第 3 步环境与基线完成，可进入第 4 步核心领域层与渲染/音频基础设施开发
```
