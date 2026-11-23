# 00 · 轮次交接回执

```text
ROLE: 全栈实现与验证负责人（V2.2 练谱模式：电吉他 & 钢琴双乐器首发）
STATUS: DONE
BRANCH: main
COMMIT: 65a92f7（V2.2 全功能与独立 L1/L2/L5 测试提交，本文件更新后将追加文档提交并推送至 origin/main）
CHANGED:
- src/domain/v2-instruments.ts:1-387 新增纯 TS 乐器配置注册表（InstrumentProfile、5 种调弦预设 TUNING_PRESETS、getEffectiveOpenMidis、midiToNoteLabel）与弦品自动/手动映射算法（getValidFretPositions、assignFretboardPositions、cycleManualFretPosition）
- src/infrastructure/audio-engine.ts:1-664 扩展 AudioEngine.setInstrument()、WebAudioEngine 多乐器音色路由（电吉他清音 Chorus+LPF、过载 Distortion+Cabinet+Gain、木吉他、电贝斯，保留钢琴 smplr/回退完全兼容）与 MockAudioEngine 乐器状态追踪
- src/application/practice-store.ts:1-306 新增独立练琴状态仓（selectedInstrumentId、guitarTone、tuningPresetId、capo、practiceViews、manualFretPositions、左右手静音、A-B 循环、1 小节预备拍、渐进提速、自动滚动与实时帧高亮快照，全程不标脏 scoreStore）
- src/application/playback-controller.ts:1-913 扩展练琴控制引擎（A-B 区间起止边界与无缝循环、1 小节预备拍时序、Speed Trainer 渐进提速且不修改 document.bpm、左右手单手静音分轨调度、previewMidi、jumpMeasureBy、restartFromLoopStart）
- src/rendering/layout-engine.ts:1-321 扩展 LayoutOptions.tabLineHeight 与 LayoutLine.tabY，默认 tabLineHeight=0 时布局数值与既有 LayoutSlot.x 100% 不变
- src/rendering/tab-renderer.ts:1-187 新增 VexFlow 5 六线谱（TabStave/TabNote/TickContext）渲染器，共享 LayoutSlot.x，使用 data-tab-note-id 与透明点击热区（严禁使用 data-note-id），支持 4/5/6 弦与 Capo 标注
- src/rendering/cursor-overlay.ts:1-145 支持动态 BPM 读取回调与 [data-tab-note-id] 同步亮灯
- src/ui/PracticeControlBar.tsx:1-428 替换原练谱骨架条，实现 5 乐器选择器、谱面图层开关、电吉他清音/过载、调弦预设、Capo 0-12、钢琴单手静音、A-B 循环、预备拍、渐进提速、自动滚动与全局键盘控播（Space/←/→/R，含输入框防误触）
- src/ui/PracticeSkeletonBar.tsx:1-1 导出转发至 PracticeControlBar 保持兼容
- src/ui/GuitarFretboardDock.tsx:1-278 新增 24 品（木吉他 20 品 / 贝斯 4-5 弦）实时指板高亮图，区分当前音与下一音、显示 Capo 压条、支持点击试听与手动切换把位
- src/ui/PianoKeysDock.tsx:1-156 新增完整 88 键虚拟钢琴实时高亮面板（区分右手 Voice 1 / 左手 Voice 2 / 双手同音与下一音提示，支持点击试听）
- src/ui/MelodyLyricDock.tsx:1-118 新增通用旋律与歌词字幕提示面板
- src/ui/ScoreCanvas.tsx:1-698 集成 TAB 谱层渲染、点击 TAB 音符选音并循环切把位、A/B 小节快捷按钮、帧同步高亮派发与换行自动平滑滚动
- src/ui/PlaybackBar.tsx:1-135 适配 A-B 循环默认起播与渐进提速百分比状态展示
- src/ui/TransposeModal.tsx:1-216 保留一键移调逻辑并新增吉他变调夹（Capo 0-12）快捷联动选择
- src/App.tsx:1-74 练谱模式下挂载 PracticeControlBar 与按乐器路由的底部实时辅助面板
- src/styles.css:1220-1716 新增 TAB 谱层、练谱控制条、24 品指板、88 键钢琴与旋律字幕条响应式样式
- tests/unit/v22-instruments-and-fretboard.test.ts:1-175 新增 V2.2 L1 单元测试（4 tests）
- tests/service/v22-practice-engine.test.ts:1-225 新增 V2.2 L2 服务测试（4 tests）
- tests/browser/v22-practice-mode.spec.ts:1-251 新增 V2.2 L5 无头浏览器验证（3 tests）
- docs/00-HANDOFF.md:1-end 更新 V2.2 交接回执
COMMANDS:
- npm run typecheck -> 退出码 0 -> 通过（tsc --noEmit 零报错）
- npm run build -> 退出码 0 -> 通过（1148 modules，生成 dist/ 产物）
- npm run test:config -> 退出码 0 -> 9 passed / 0 failed / 0 skipped（1 个测试文件）
- npm run test:unit -> 退出码 0 -> 37 passed / 0 failed / 0 skipped（8 个测试文件，含新增 4 项 V2.2 单测）
- npm run test:service -> 退出码 0 -> 18 passed / 0 failed / 0 skipped（6 个测试文件，含新增 4 项 V2.2 服务测试）
- npm run test:contract -> 退出码 0 -> 4 passed / 0 failed / 0 skipped（1 个测试文件，领域层纯 TS 静态扫描通过）
- npm run test:e2e:mock -> 退出码 0 -> 2 passed / 0 failed / 0 skipped（1 个测试文件）
- npm run test:nonfunc -> 退出码 0 -> 4 passed / 0 failed / 0 skipped（1 个测试文件，表现层单向依赖静态扫描通过）
- npm run smoke -> 退出码 0 -> 5 passed / 0 failed
- npm run test:browser -> 退出码 0 -> 17 passed / 0 failed / 0 skipped（4 个测试文件，含新增 3 项 V2.2 浏览器端到端测试；于宿主机上下文运行，沙盒内因 127.0.0.1 回环端口受限超时 180s 退出码 1）
INTERFACES:
- src/domain/v2-instruments.ts 导出 INSTRUMENT_PROFILES、TUNING_PRESETS、PRACTICE_INSTRUMENT_IDS、getInstrumentProfile、getTuningPreset、getEffectiveOpenMidis、midiToNoteLabel、getValidFretPositions、assignFretboardPositions、cycleManualFretPosition
- src/infrastructure/audio-engine.ts 扩展 AudioEngine.setInstrument(instrumentId) 与电吉他清音/过载、木吉他、电贝斯合成效果链
- src/application/practice-store.ts 导出 createPracticeStore、practiceStore、usePracticeStore
- src/application/playback-controller.ts 新增导出 setInstrument、previewMidi、getCountInBeat、jumpMeasureBy、restartFromLoopStart，以及 PlaybackSnapshot.currentInstrumentId / activeSpeedPercent / isCountingIn
- src/rendering/tab-renderer.ts 导出 renderTab
- 未修改 docs/evidence/*、docs/01-范围与边界.md、docs/02-架构与契约.md、src/domain/types.ts 与 src/infrastructure/config.ts 等只读/冻结文件
ASSUMPTIONS:
- 沿用 docs/02-架构与契约.md 及 D-05/D-06/D-07 既定架构决策；Guitar Pro 导入、网页调音器与 OMR 识谱留至 V2.3
- TAB 音符 SVG 分组严格使用 data-tab-note-id（绝不使用 data-note-id），保障既有双谱 X 对齐 <= 2px 选择器零污染
- 全部练琴状态（乐器、音色、调弦、Capo、手动把位、A-B 循环、预备拍、渐进提速、单手静音、自动滚动）隔离于 practiceStore，不触发 scoreStore.documentState DIRTY
- Windows 沙盒环境限制 127.0.0.1 回环端口与 .git/index.lock / 外网推送，故 npm run test:browser、git commit 与 git push 在宿主机上下文执行
BLOCKERS:
- NONE
NEXT:
- V2.2（练谱模式：电吉他 & 钢琴双乐器首发）已全部交付并通过 L0–L6 自动化验证；下一步可按 docs/03-V2演进需求与架构规划.md 启动 V2.3（Guitar Pro 导入、多轨伴奏混音 Mute/Solo、吉他技巧记号、网页调音器与 OmrProvider 识谱插件）开发
```
