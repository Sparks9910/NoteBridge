# 00 · 轮次交接回执

```text
ROLE: 全栈实现与验证负责人（V2.1 制谱对照完全体 & MusicXML/MIDI 互通）
STATUS: DONE
BRANCH: main
COMMIT: afaf88e（V2.1 全功能与独立 L1/L2/L5 测试提交，本文件更新后将追加文档提交并推送至 origin/main）
CHANGED:
- src/domain/v2-types.ts:27-155 扩展 V2.1 领域类型（DynamicMarking、OrnamentType、MeasureBarlineType、ImportFormat、NoteNotationExtra、MeasureNotationExtra 及 Beat/V2Measure 记号字段）
- src/domain/v2-serializer.ts:1-620 扩展 Beat/V2Measure 记号校验，新增 quantizeTicksToDuration、mapMidiToPitchNode、projectTrackVoiceToV1、extractPartsFromScoreV2 与 extractVoiceAsPartV2（分谱提取）
- src/domain/v2-jianpu-text.ts:1-462 新增纯 TS 简谱文本快捷语法解析与格式化（支持头指令、升降号、高低八度、减/增时线、附点、小节线、反复记号与逐音歌词绑定）
- src/infrastructure/codecs/xml-parser.ts:1-254 新增零依赖纯 TS XML 解析器与构建辅助函数
- src/infrastructure/codecs/zip-codec.ts:1-225 新增零依赖纯 TS ZIP 打包/解包（CRC32 + Store/Deflate，用于 .mxl 压缩包）
- src/infrastructure/codecs/musicxml-codec.ts:1-764 实现 MusicXML 4.0（.musicxml）与压缩 .mxl 双向导入导出（支持大谱表、多声部、歌词、指法、强弱、连音线、装饰音与反复/跳房子）
- src/infrastructure/codecs/midi-codec.ts:1-512 实现标准 SMF Format 1 MIDI（.mid）双向导入导出与节奏量化切分小节
- src/infrastructure/codecs/codec-registry.ts:1-78 新增统一外部文件格式探测与导入路由（.musicxml/.xml/.mxl/.mid/.json/.txt）
- src/infrastructure/indexeddb-adapter.ts:1-664 升级 IndexedDB 数据库至 v2，新增 references ObjectStore 与附件存取/清理/容量统计
- src/application/notation-store.ts:1-525 新增 V2.1 制谱状态管理（大谱表、Voice 2、歌词/指法/演奏记号、多轨管理、原谱对照面板状态与 7 标签制谱面板）
- src/application/library-store.ts:1-505 集成 notationStore 水合与同步，新增外部文件/简谱文本导入与本地原谱附件存取删除 API
- src/application/export-service.ts:1-244 新增 MusicXML/MXL/MIDI 导出与分谱导出（exportPartAsFormat），PNG/PDF 导出透传 V2.1 大谱表与记号上下文
- src/application/playback-controller.ts:1-664 扩展 scheduleFromTick 并行调度 Voice 2 低音声部发声
- src/rendering/layout-engine.ts:10-108 支持大谱表与歌词/记号自适应行高配置（默认高度保持不变）
- src/rendering/staff-renderer.ts:1-510 支持高音/低音/钢琴大谱表花括号、Voice 2（data-v2-note-id 隔离）、反复/双纵线/终止线、跳房子、指法、强弱、装饰音与连音线弧线
- src/rendering/jianpu-renderer.ts:1-585 简谱层同步渲染歌词、指法、强弱、装饰音、连音线弧线与反复/跳房子记号
- src/rendering/export-renderer.ts:1-460 离屏打印 SVG、PNG 与 A4 PDF 支持 V2.1 大谱表、多声部与记号排版
- src/ui/InputKeypad.tsx:1-990 升级为可折叠 7 标签专业制谱面板（录入/谱调拍速/小节/线与记号/歌词/指法/声部与轨道），保留全部既有 data-testid
- src/ui/ReferencePane.tsx:1-203 新增「原谱对照」分屏面板（本地上传图片/PDF 存 IndexedDB、缩放、替换/移除，纯本地不上传外网）
- src/ui/ImportModal.tsx:1-162 新增外部文件（MusicXML/MXL/MIDI/JSON）与简谱文本快捷导入弹窗
- src/ui/ExportModal.tsx:1-405 升级导出中心：新增 MusicXML/MXL/MIDI 导出与「分谱导出（Part Extraction）」多轨/单声部导出
- src/ui/Toolbar.tsx:1-395 新增「导入」与「原谱对照」开关并与 notationStore 联动
- src/ui/ScoreCanvas.tsx:1-365 接入大谱表、Voice 2 与 V2.1 排版记号渲染及 Voice 2 点击选中
- src/ui/LibraryView.tsx:1-279 新增乐谱库顶部「导入曲谱」入口
- src/App.tsx:1-58 Studio 模式下支持单屏与「原谱对照」左右分屏切换
- src/styles.css:973-1222 新增多标签面板、原谱分屏、大谱表记号与导入/分谱弹窗响应式样式
- tests/unit/v21-codecs-and-notation.test.ts:1-385 新增 V2.1 L1 单元测试（6 tests）
- tests/service/v21-notation-and-reference.test.ts:1-275 新增 V2.1 L2 服务测试（3 tests）
- tests/browser/v21-authoring-and-interop.spec.ts:1-335 新增 V2.1 L5 无头浏览器验证（4 tests）
- docs/00-HANDOFF.md:1-end 更新 V2.1 交接回执
COMMANDS:
- npm run typecheck -> 退出码 0 -> 通过（tsc --noEmit 零报错）
- npm run build -> 退出码 0 -> 通过（1142 modules，生成 dist/ 产物）
- npm run test:config -> 退出码 0 -> 9 passed / 0 failed / 0 skipped（1 个测试文件）
- npm run test:unit -> 退出码 0 -> 33 passed / 0 failed / 0 skipped（7 个测试文件，含新增 6 项 V2.1 单测）
- npm run test:service -> 退出码 0 -> 14 passed / 0 failed / 0 skipped（5 个测试文件，含新增 3 项 V2.1 服务测试）
- npm run test:contract -> 退出码 0 -> 4 passed / 0 failed / 0 skipped（1 个测试文件，领域层纯 TS 静态扫描通过）
- npm run test:e2e:mock -> 退出码 0 -> 2 passed / 0 failed / 0 skipped（1 个测试文件）
- npm run test:nonfunc -> 退出码 0 -> 4 passed / 0 failed / 0 skipped（1 个测试文件，表现层单向依赖静态扫描通过）
- npm run smoke -> 退出码 0 -> 5 passed / 0 failed
- npm run test:browser -> 退出码 0 -> 14 passed / 0 failed / 0 skipped（3 个测试文件，含新增 4 项 V2.1 浏览器端到端测试；于宿主机网络上下文运行，沙盒内因回环端口受限超时 180s 退出码 1）
INTERFACES:
- src/domain/v2-jianpu-text.ts 导出 parseJianpuTextToScoreV2、formatScoreV2ToJianpuText
- src/domain/v2-serializer.ts 新增导出 quantizeTicksToDuration、mapMidiToPitchNode、projectTrackVoiceToV1、extractPartsFromScoreV2、extractVoiceAsPartV2
- src/infrastructure/codecs/ 导出 parseXml/escapeXml、packZip/unpackZip、exportScoreV2ToMusicXml/exportScoreV2ToMxl/importMusicXmlToScoreV2/importMxlToScoreV2、exportScoreV2ToMidi/importMidiToScoreV2、importScoreFromFileData
- src/infrastructure/indexeddb-adapter.ts 扩展 ScoreLibraryRepository 可选原谱附件方法（saveReferenceAttachment / getReferenceAttachment / deleteReferenceAttachment）
- src/application/notation-store.ts、library-store.ts、export-service.ts 分别导出 V2.1 制谱状态、外部导入/原谱附件管理与全格式/分谱导出 API
- 未修改 docs/evidence/*、docs/01-范围与边界.md、docs/02-架构与契约.md、src/domain/types.ts 与 src/infrastructure/config.ts 等只读/冻结文件
ASSUMPTIONS:
- 沿用 docs/02-架构与契约.md 及 D-05/D-06/D-07 既定架构决策；OMR 自动识谱仍按规划留至 V2.3
- Voice 2 与低音谱表音符使用 data-v2-note-id 与 data-voice-index="1" 隔离，保障既有双谱 X 对齐 <= 2px 契约零回归
- 原谱对照图片/PDF 附件纯本地存储于 IndexedDB references 对象仓库，单文件限制 20MB，不上传外网
- Windows 沙盒环境限制 127.0.0.1 回环端口与 .git/index.lock / 外网推送，故 npm run test:browser、git commit 与 git push 在宿主机上下文执行
BLOCKERS:
- NONE
NEXT:
- V2.1（制谱对照完全体 & MusicXML/MIDI 互通）已全部交付并通过 L0–L6 自动化验证；下一步可按 docs/03-V2演进需求与架构规划.md 启动 V2.2（练谱模式：电吉他 6 线谱 TAB / 24 品指板 / 钢琴 88 键高亮 / A-B 循环 / 预备拍 / 渐进提速）开发
```
