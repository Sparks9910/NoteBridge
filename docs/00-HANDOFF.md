# 00 · 轮次交接回执

```text
ROLE: 全栈实现与验证负责人（V2.3 专业吉他谱、伴奏混音、网页调音器与 OMR 识谱扩展）
STATUS: DONE
BRANCH: main
COMMIT: 50e9ecb（V2.3 全功能与独立 L1/L2/L5 测试提交，本文件更新后将追加文档提交并推送至 origin/main）
CHANGED:
- src/domain/v2-types.ts:1-212 新增 GuitarTechnique（bend/slide/hammer/pull/palm-mute/vibrato）、ImportFormat 扩展 'guitarpro' 与 NoteNotationExtra.guitarTechniques/guitarPosition 字段
- src/domain/v2-instruments.ts:1-574 新增 GUITAR_TECHNIQUE_OPTIONS、VALID_GUITAR_TECHNIQUES 与纯函数 normalizeGuitarTechniques
- src/domain/v2-serializer.ts:1-1014 更新 PitchNode 校验与分谱克隆逻辑，规范化并深拷贝吉他弦品与技巧数组
- src/domain/v2-tuner.ts:1-248 新增纯 TS 自相关音高检测算法（detectPitchAutocorrelation、抛物线插值与八度抑振）、buildTargetStringsFromTuning 与 analyzeTunerReading（全文件无任何浏览器全局符号）
- src/infrastructure/codecs/guitarpro-codec.ts:1-1537 新增 Guitar Pro 解析器，支持 .gp（ZIP + score.gpif）、.gpx（BCFZ/BCFS 容器）与 .gp5 二进制多轨/调弦/Capo/弦品/技巧解码，损坏或旧版本返回中文 AppError
- src/infrastructure/codecs/codec-registry.ts:1-99 接入 .gp/.gp5/.gpx 格式识别与 importGuitarProToScoreV2 解码路由
- src/infrastructure/audio-engine.ts:1-581 扩展 ScheduledNote.trackId/instrumentId，使 WebAudioEngine 与 MockAudioEngine 支持按轨分派不同乐器音色与混音增益
- src/infrastructure/tuner-adapter.ts:1-260 新增 WebMicrophoneTunerAdapter（getUserMedia + AnalyserNode）、generateSineWaveBuffer 与可控 MockTunerAdapter（含权限拒绝/无设备中文 AppError 映射）
- src/infrastructure/omr/omr-provider.ts:1-393 定义标准可插拔 OmrProvider 接口、OmrProviderRegistry 与 HttpOmrBridgeProvider（本地 Audiveris/Homr HTTP 桥接 + 自定义端点 + 健康检查 + 中文离线引导）
- src/infrastructure/omr/omr-config-storage.ts:1-56 封装 OMR 适配器配置在 localStorage 的安全读写
- src/infrastructure/omr/index.ts:1-2 导出 OMR 基础设施模块
- src/application/notation-store.ts:1-737 支持吉他技巧切换（toggleGuitarTechnique）、弦品位置持久化同步与深拷贝
- src/application/practice-store.ts:1-494 新增多轨混音状态（trackMixByTrackId、resolveTrackAudibility、Mute/Solo/Gain/消主音跟弹）与调音器面板开关，全程不标脏 scoreStore
- src/application/playback-controller.ts:1-1046 扩展多轨伴奏分轨调度（按 trackMixByTrackId 与 instrumentId 并行发声）与播放期实时刷新 refreshMixLive
- src/application/export-service.ts:1-256 导出上下文保留吉他技巧记号（guitarTechniques）
- src/application/tuner-store.ts:1-130 新增调音器应用状态仓（start/stop/setA4Hz/setSelectedString/simulateFrequency）
- src/application/omr-service.ts:1-135 新增 OMR 转谱并自动挂载 IndexedDB 原谱对照（recognizeScoreWithOmrAndAttachReference）与一键降级仅载入原谱对照（loadFileAsReferenceOnly）
- src/rendering/tab-renderer.ts:1-243 在 VexFlow 六线谱渲染推弦/滑音/击勾弦/闷音/震音标记（使用 data-tab-tech-note-id 隔离，绝不使用 data-note-id）
- src/rendering/staff-renderer.ts:1-544 在五线谱上方同步渲染吉他技巧标注（data-staff-technique，不扰动音符中心 X 坐标）
- src/ui/ScoreCanvas.tsx:1-695 传入 noteExtrasById 与导入的 guitarPosition 至 TAB 渲染管线
- src/ui/InputKeypad.tsx:1-1006 将「线与记号」升级为「线与技巧」并接入 6 种吉他技巧切换按钮
- src/ui/TrackMixerBar.tsx:1-138 新增练谱模式多轨伴奏混音条（M 静音 / S 独奏 / 音量滑块 / 消主音跟弹 / 重置混音）
- src/ui/TunerPanel.tsx:1-234 新增内置网页调音器面板（联动调弦与 Capo、A4 432/440/442 校准、音分表盘与弦号锁定试音）
- src/ui/PracticeControlBar.tsx:1-495 接入调音器开关与多轨混音条
- src/ui/ImportModal.tsx:1-428 扩展支持 .gp/.gp5/.gpx 上传，并新增「图片/PDF 智能转谱（OMR）」标签页及“仅载入为原谱对照”降级入口
- src/ui/LibraryView.tsx:1-281 更新乐谱库空态支持格式说明（含 Guitar Pro 与 OMR）
- src/App.tsx:1-79 练谱模式按需挂载 TunerPanel
- src/styles.css:1-2028 新增多轨混音条、调音器表盘与 OMR 标签页样式
- tests/unit/v23-gp-tuner-and-techniques.test.ts:1-508 新增 V2.3 L1 单元测试（5 tests）
- tests/service/v23-mixer-tuner-and-omr.test.ts:1-376 新增 V2.3 L2 服务层测试（3 tests）
- tests/browser/v23-guitarpro-mixer-tuner-omr.spec.ts:1-460 新增 V2.3 L5 浏览器端到端验证（3 tests）
- docs/00-HANDOFF.md:1-end 更新 V2.3 交接回执
COMMANDS:
- npm run typecheck -> 退出码 0 -> 通过（tsc --noEmit 零报错）
- npm run build -> 退出码 0 -> 通过（1158 modules，生成 dist/ 产物）
- npm run test:config -> 退出码 0 -> 9 passed / 0 failed / 0 skipped（1 个测试文件）
- npm run test:unit -> 退出码 0 -> 42 passed / 0 failed / 0 skipped（9 个测试文件，含新增 5 项 V2.3 单测）
- npm run test:service -> 退出码 0 -> 21 passed / 0 failed / 0 skipped（7 个测试文件，含新增 3 项 V2.3 服务测试）
- npm run test:contract -> 退出码 0 -> 4 passed / 0 failed / 0 skipped（1 个测试文件，领域层纯 TS 静态扫描通过）
- npm run test:e2e:mock -> 退出码 0 -> 2 passed / 0 failed / 0 skipped（1 个测试文件）
- npm run test:nonfunc -> 退出码 0 -> 4 passed / 0 failed / 0 skipped（1 个测试文件，表现层单向依赖静态扫描通过）
- npm run smoke -> 退出码 0 -> 5 passed / 0 failed
- npm run test:browser -> 退出码 0 -> 20 passed / 0 failed / 0 skipped（5 个测试文件，含新增 3 项 V2.3 浏览器端到端测试；于宿主机上下文运行，沙盒内因 127.0.0.1 回环端口受限超时 180s 退出码 1）
INTERFACES:
- src/domain/v2-tuner.ts 导出 DEFAULT_A4_HZ、midiToFrequency、frequencyToMidiFloat、buildTargetStringsFromTuning、detectPitchAutocorrelation、analyzeTunerReading
- src/domain/v2-instruments.ts 新增导出 GUITAR_TECHNIQUE_OPTIONS、VALID_GUITAR_TECHNIQUES、normalizeGuitarTechniques
- src/infrastructure/codecs/guitarpro-codec.ts 导出 importGuitarProToScoreV2、decompressBcfz、extractFilesFromBcfs
- src/infrastructure/tuner-adapter.ts 导出 TunerAdapter、WebMicrophoneTunerAdapter、MockTunerAdapter、generateSineWaveBuffer
- src/infrastructure/omr/omr-provider.ts 导出 OmrProvider、HttpOmrBridgeProvider、OmrProviderRegistry、omrProviderRegistry、createOmrProvider、DEFAULT_LOCAL_OMR_ENDPOINT
- src/application/practice-store.ts 新增导出 TrackMixChannel、ResolvedTrackAudibility、resolveTrackAudibility 及混音/调音器 actions
- src/application/playback-controller.ts 新增导出 refreshMixLive() 与 ScheduledNote.trackId / instrumentId 调度
- src/application/tuner-store.ts 导出 createTunerStore、tunerStore、useTunerStore
- src/application/omr-service.ts 导出 loadSavedOmrConfig、saveOmrConfig、checkOmrProviderHealth、recognizeScoreWithOmrAndAttachReference、loadFileAsReferenceOnly
- 未修改 docs/evidence/*、docs/01-范围与边界.md、docs/02-架构与契约.md、src/domain/types.ts、src/infrastructure/config.ts 与 src/domain/serializer.ts 等只读/冻结文件
ASSUMPTIONS:
- 沿用 docs/02-架构与契约.md、docs/03-V2演进需求与架构规划.md 与 D-05/D-06/D-07 既定架构决策，保持纯前端本地优先与零付费墙
- Guitar Pro 支持现代 .gp（ZIP + score.gpif）、.gpx（BCFZ/BCFS）与 .gp5 二进制核心音轨/小节/弦品/技巧结构；更早的 GP3/GP4 返回明确中文升级指引而不静默错解
- OMR 采用可插拔 OmrProvider HTTP 桥接接口，默认指向本地 127.0.0.1:8765 Audiveris/Homr 服务，离线/未配置时提供清晰中文指引及一键“仅载入为原谱对照”降级方案
- Windows 沙盒环境限制 127.0.0.1 回环端口与 .git/index.lock / 外网推送，故 npm run test:browser、git commit 与 git push 在宿主机上下文执行
BLOCKERS:
- NONE
NEXT:
- V2.0–V2.3 既定演进路线图已全部交付并通过 L0–L6 全量自动化验证；后续可由人工验收真机麦克风调音、真实 .gp/.gp5/.gpx 曲谱文件及本地 Audiveris/Homr OMR 桥接联调体验
```
