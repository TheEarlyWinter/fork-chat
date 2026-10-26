# 画布体验升级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一空状态，收拢顶栏，整合控制岛，并阻断无目标会话的宿主导入。

**Architecture:** 生命周期继续由 fork-session-controller 管理。panel-session-ui 只派生展示状态。DOM 动作复用现有业务接口；新增视口工具模块仅管理帮助与全屏。

**Tech Stack:** 原生 JavaScript ES modules、HTML/CSS、node:test、Chrome headless、ESLint。

**Spec:** docs/superpowers/specs/2026-10-26-canvas-experience-design.md

## Global Constraints

- 保留新会话默认一张初始卡；不迁移历史数据，不改变快照格式。
- 不新增运行依赖。不修改 SDK、vendor、后端宿主协议或其他工作树。
- 保留现有核心按钮 ID、保存恢复能力、IME/草稿/layout-only/dispose 契约。
- 无活动会话的宿主导入明确拒绝。intent 释放凭条，不 ACK。
- 不批量删除，不回退他人改动。不合并、推送或发布。本轮不自动提交，保留可审查工作树差异。
- 修改源码用结构化文件工具。先失败测试，再最小实现。执行代理不得再委派子代理。

## Review Focus

- 已删空会话库重开：不闪默认卡、不自动重生会话。
- 保存冲突与长错误：本地内容继续可见，恢复按钮在窄窗口仍可达。
- 无 activeId 的宿主导入：不能显示成功、创建孤卡或消费 intent。
- 控制岛与发射台：mousedown、Space 和 wheel 不穿透到画布。
- 状态与全屏事件：不重建卡片，dispose 后不响应迟到事件。

---

### Task 1: 统一空状态与宿主导入安全边界

**Files:**
- Modify: ui/assets/panel-session-ui.js
- Modify: ui/assets/panel-renderer.js
- Modify: ui/assets/panel.js
- Modify: ui/assets/panel-canvas-actions.js
- Modify: ui/assets/panel-bridge.js（仅导入失败表现与凭条安全）
- Create: tests/panel-canvas-presentation.test.mjs
- Create: tests/panel-empty-bridge-safety.test.mjs
- Modify: tests/integration.test.mjs、相关现有 harness（只补真实状态，不放宽断言）

**Interfaces:**
- Produces: deriveCanvasPresentation(state, cardCount) -> 'restore-error'|'booting'|'transitioning'|'no-session'|'no-active'|'empty-session'|'content'，导出于 panel-session-ui.js。
- Produces: sessionUi.syncCanvasPresentation() -> void，dispose 后无副作用。
- Consumes: createPanelSessionUi 追加可选依赖 getCardCount、sessionEmptyState、canvasLaunchpad、canvasLoadingState、canvasSurface、sessionSaveIndicator；生产入口全部注入。不得在构造期调用晚绑定 getter。旧测试构造契约继续有效。
- DOM ID 固定为设计文档列出的名称。Task 1 不修改 HTML/CSS；缺失的新增展示节点允许为空，Task 2 补齐。
- createBridgeDocCard 保持同步 Card|null 契约。使用现有 getSessionController 确认 state.activeId，缺失时返回 null 并提示“请先新建画布会话，再导入本体内容。”。

- [x] Step 1: 添加派生状态与展示行为测试。逐一断言七种状态、错误正交、切换不闪空引导、cardCount 变化、零卡片 layout-only 调用后同步、dispose 和构造期 getter 不被调用。运行新测试并确认因缺失行为失败。
- [x] Step 2: 添加无 activeId 的 bridge 创建/手动导入/intent 用例。断言不新增卡、不标脏、不 ACK、释放已领取凭条、对话框保留并可见提示。活动会话路径仍应先 flush 后 ACK；保存失败、切换和 dispose 维持原守卫。运行确认真实失败。
- [x] Step 3: 实现派生函数及统一 DOM 同步。在 renderCards 包装末尾同步展示，在 session state 通知时同步。移除 renderer 对空状态的写入，保留其卡片和统计职责。session-save-indicator 用 data-state 标注 booting/busy/saving/dirty/saved/error；文本状态仍保留现有错误详情。
- [x] Step 4: 在入口绑定发射台三按钮到既有业务动作。新展示节点晚绑定且安全可缺省。修正 bridge 无 activeId 的失败返回及调用处展示，保持同步 API 和持久化协议。
- [x] Step 5: 运行 node --experimental-vm-modules --test tests/panel-canvas-presentation.test.mjs tests/panel-empty-bridge-safety.test.mjs tests/panel-session-ui-phase1.test.mjs tests/panel-session-quota-ui.test.mjs tests/panel-arrange-draft-regressions.test.mjs tests/panel-bridge-intents.test.mjs tests/integration.test.mjs，再运行全量。记录红绿证据、退出码、测试数与未验项。
- [x] Step 6: 自查差异。提交任务报告给主审，不创建 git commit，不改 Task 2 的文件。

### Task 2: 集成顶栏、发射台与控制岛

**Files:**
- Modify: ui/panel.html
- Modify: ui/assets/panel.css
- Modify: ui/assets/panel-viewport.js
- Modify: ui/assets/panel.js（只注入新工具、listen 与 dispose 接线，保留 Task 1）
- Create: ui/assets/panel-canvas-tools.js
- Create: tests/panel-canvas-tools.test.mjs
- Create: tests/panel-shell-layout.test.mjs
- Modify: tests/integration.test.mjs（新模块 VM 映射）与相关 viewport 测试

**Interfaces:**
- Consumes: Task 1 固定的 DOM 名称、deriveCanvasPresentation 和 syncCanvasPresentation。不要改变 Task 1 状态规则。
- Produces: createCanvasTools({ documentRef, fullscreenTarget, btnFullscreen, btnShortcuts, shortcutsDialog, btnShortcutsClose, listen, flashMessage, isDisposed }) -> { dispose() }，导出于 panel-canvas-tools.js。不反向导入 panel.js，不使用裸全局 DOM；listen 的返回清理函数由模块收拢，dispose 幂等。
- Fullscreen target 为现有 .canvas-app 容器。帮助使用原生 dialog。全屏失败用 flashMessage，不抛出未处理 Promise；按钮反映真实 fullscreenElement，支持外部退出。
- 顶栏与发射台所有 ID 见设计文档。btn-reset-view 直接移入控制岛，不另建 reset 动作。

- [x] Step 1: 阅读只读参考原型，以及 Task 1 实际实现。添加真实 HTML 的 ID 唯一、文本叶节点、浮层层级断言；为 viewport 添加 data-canvas-ui 的 mousedown/Space/wheel 隔离测试。运行确认失败。
- [x] Step 2: 添加 canvas-tools 测试：不支持全屏、进入/退出成功、请求拒绝、fullscreenchange、帮助打开/关闭/Escape 焦点返回、dispose 后迟到事件无副作用。运行确认失败。
- [x] Step 3: 重构 HTML/CSS，迁移所有核心控件。宽窗口紧凑顶栏，窄窗口允许换行；错误可展开，主动作和恢复入口不被挤出。保留卡片样式。替换固定视口高度为稳健 flex 剩余空间。新增所有节点与可访问名称。
- [x] Step 4: 实现视口浮层隔离和 canvas-tools；在入口接线并登记 VM 映射。保留既有居中函数、缩放范围、文件输入与桥接确认流程。
- [x] Step 5: 用真实 Chrome 执行完整顶栏几何测试。至少覆盖 640/1024/1440 宽、长标题与助手文本、正常/错误/保存恢复状态，检查按钮可见、无横向溢出、视口获得剩余高度。不依赖截图肉眼代替断言。
- [x] Step 6: 运行相关新增测试、tests/panel-header-layout.test.mjs、tests/panel-arrange-draft-regressions.test.mjs、tests/integration.test.mjs，再运行 node --experimental-vm-modules --test tests/*.test.mjs 与已有 ESLint。记录命令和退出码。不安装新依赖，不改 lint 配置。
- [x] Step 7: 自查差异。报告改动文件、红绿证据、全量测试统计、布局测试、未验宿主能力。不提交、不合并、不发布。

## 完成门禁

主审分别核查任务规格与代码质量。最终独立审查覆盖两项任务的组合差异；重要问题修复后重验。最终交付改动摘要、验证证据与明确未验项。生成报告和计划不等于实现完成。

## 执行结果

- 两项任务及最终独立复核已通过。改动按用户后续授权纳入 `2.5.1` 发布流程（功能提交 + release 提交）；推送、打 tag 与上传仍待单独指令。
- 主审最新全量：1343 pass，0 fail，0 skipped，退出码 0。包含本机反馈后的帮助弹窗居中与全屏禁用态修正。
- 全仓 ESLint：0 errors，116 warnings。基线为 118 warnings。最后单一测试文件再次定向检查为 0 errors、0 warnings。
- git diff --check 通过。Chrome 布局覆盖四边边界、祖先裁剪、五点命中、恢复按钮焦点、长错误全文 Range，以及一项正控和三项负控。
- 本机截图已确认当前宿主未开放所需全屏能力，现按能力禁用入口。仍未验：其他宿主的全屏授权、物理触控板手势、完整人工视觉验收。未发布。
