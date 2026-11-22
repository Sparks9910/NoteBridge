# NOW.md

> 权威来源：当前目标、进展、阻塞、下一步与证据入口。状态发生实质变化时直接修订本文件。

- **最后核验**：2026-11-22（核验对象：仓库根目录文件与 Git 状态；范围：仅项目基础文档与仓库初始化状态）

## 当前目标

完成项目基础上下文文档体系搭建，并明确下一步技术栈选型与 MVP 工程初始化方案。

## 当前进展

- **已完成**：
  - 确定项目名称为 `NoteBridge`（音桥）。
  - 在 [README.md](../../README.md) 中沉淀产品需求大纲（MVP 闭环、P0–P2 功能规划、乐理映射规则及架构避坑指南）。
  - 初始化本地 Git 仓库并关联 GitHub 公共远程仓库（`origin/main`），初始文档提交 `3865fd5` 已推送。
  - 建立项目协作规则与上下文文档体系（[AGENTS.md](../../AGENTS.md)、[PROJECT_INDEX.md](../../PROJECT_INDEX.md) 及 `docs/context/` 专题文档）。
- **进行中 / 待完成**：
  - 尚未选定具体技术栈与工程框架（源码、构建脚本、测试均未建立）。

## 当前阻塞

- **技术栈待拍板**：需求大纲提及 Web 端（VexFlow / OSMD + Web Audio API / Tone.js）与移动端原生（SoundFont `.sf2`）方向，但具体实现语言、前端框架、是否包含后端或桌面壳（如 Java / Electron / Tauri / 纯 Web）尚未由项目负责人最终确认。

## 下一步（计划）

1. 将本次新建与更新的基础文档提交并推送至 `origin/main`（需确认是否立即推送）。
2. 与用户确认首期 MVP 的目标平台与技术栈选型，记录到 [DECISIONS.md](DECISIONS.md) 与 [MAP.md](MAP.md)。
3. 初始化项目工程骨架与自动化测试基线，更新 [RUNBOOK.md](RUNBOOK.md) 与 [README.md](../../README.md) 中的运行方式。

## 证据入口

- 产品需求大纲与文档入口：[README.md](../../README.md)
- 协作规则：[AGENTS.md](../../AGENTS.md)
- 已知技术栈与验证缺口：[RISKS.md](RISKS.md)
