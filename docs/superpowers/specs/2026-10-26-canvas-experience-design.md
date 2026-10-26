# 画布体验升级设计

## 目标与授权

用户在架构评审后授权实施。目标是统一空状态语义、收拢顶栏、整合视口工具，并防止宿主导入只留在内存。

本设计落实本会话的评审结论。保留现有原生 JavaScript、HTML、CSS 架构。无新增依赖。

## 方案与取舍

- 选择渐进重构。保留现有控制器、按钮 ID、快照格式和新会话默认初始卡。成本低，兼容风险小。
- 不选择重写画布状态机。生命周期已经由 fork-session-controller 管理，重写会增加保存和并发风险。
- 不选择新会话默认零卡片。这是另一项产品行为变化。发射台本轮只覆盖活动会话零卡片。
- 无活动会话时，宿主导入明确拒绝并要求先新建画布会话。自动导入 intent 释放凭条，不 ACK。不在本轮加入自动创建会话和重定向导入协议。

以上是执行端的保守默认，不表示用户另行确认过每一个细节。

## 范围与非目标

本轮包含：派生展示状态、集成顶栏、活动会话空画布发射台、控制岛、帮助对话框、能力检测后的全屏、必要回归测试。

不包含：历史数据迁移、默认初始卡变化、模型设置重构、卡片盖戳重绘、宿主会话写入协议变化、发布、部署、合并或推送。

原型参考：同仓库另一工作树 1026-solf 的 docs/fork-chat-ui-prototype.html。只读参考，不修改该工作树，也不搬用原型的模拟状态和事件。

## 模块边界

- fork-session-controller：继续独占会话身份、保存、冲突、代际和切换状态。
- panel-session-state：继续拍取和应用快照，不存储展示状态。
- panel-session-ui：导出纯函数 deriveCanvasPresentation(state, cardCount)，并负责统一同步画布引导区域和保存指示。
- panel-renderer：只渲染卡片与统计。不再根据 cards.length 判断有没有会话。
- panel.js：只注入依赖和连接回调。每次 renderCards 之后调用 sessionUi.syncCanvasPresentation()；会话状态通知也执行同步。
- panel-canvas-actions：同步的 createBridgeDocCard 在无有效活动会话时拒绝创建，不改变其同步返回契约。
- panel-bridge：导入失败保持对话框并给出原因；intent 创建失败释放凭条，不 ACK。
- panel-viewport：维护平移、缩放和浮层事件边界。
- 新 panel-canvas-tools：只管理帮助对话框和全屏，使用依赖注入，具备 dispose。全屏不进入持久化快照。

## 派生展示契约

函数 deriveCanvasPresentation(state, cardCount) 返回下列字符串之一：

1. restore-error：!ready 且存在 error。
2. booting：!ready 且没有 error。
3. transitioning：ready 且 busy。
4. no-session：ready、非 busy、无 activeId，且 sessions 为空。
5. no-active：ready、非 busy、无 activeId，但仍有 sessions。
6. empty-session：ready、非 busy、有 activeId，且 cardCount === 0。
7. content：ready、非 busy、有 activeId，且 cardCount > 0。

状态缺省按未就绪处理。不使用 visibleCards 或 DOM 数量判断空画布。

只有 empty-session 显示 canvas-launchpad。no-session/no-active 显示 session-empty-state，后者不得声称所有会话已清空。booting/restore-error 使用独立 canvas-loading-state。transitioning 不显示空引导，可继续显示已有卡片。首次恢复未完成时隐藏临时卡片，避免默认卡闪现。

保存错误与 conflict 是正交状态。ready 为 true 时，已经恢复的本地内容继续可见，重试与保存副本入口继续可达。ready 为 false 时，booting 和 restore-error 均隐藏 surface，不能把临时默认卡当作已恢复内容。不得因状态灯变化重建卡片。

## DOM 与动作契约

- 保留现有核心按钮 ID，包含 session-status、btn-retry-save、btn-save-copy、btn-empty-new-session。
- 删除 session-strip 包装，将状态与恢复控件移至顶栏。普通状态紧凑显示，错误允许换行展开。
- session-status 和 active-agent-display 保持文本叶节点，图标和指示灯放在兄弟节点，不会被 textContent 清掉。
- 新增 session-save-indicator、session-empty-state、canvas-launchpad、canvas-loading-state。文字与动作具有明确的无障碍名称。
- 发射台按钮 ID：btn-launchpad-new-root、btn-launchpad-import-doc、btn-launchpad-bridge。
- 新建调用既有 createRootCard；资料入口复用既有文件选择器；宿主入口打开既有 bridge 对话框。不使用重复 ID 或模拟点击绕过业务校验。
- 将 btn-reset-view 移至控制岛，继续调用 canvasViewController.resetView。保留 zoom 按钮和 zoom-text。
- 控制岛新增 btn-fullscreen、btn-shortcuts、shortcuts-dialog、btn-shortcuts-close。
- 所有视口内交互浮层使用 data-canvas-ui 标记；平移和滚轮不接管这些浮层内的交互。按住 Space 时也不抢占按钮按下。
- 发射台、加载区域和控制岛位于 viewport 内、surface 外。它们不会随画布缩放，也不会被 cards-layer 重建删除。

## 布局与可访问性

参考原型的纯白、深色主按钮、浅灰边框、紧凑功能分组。保留既有卡片视觉，不扩大调色范围。

宽窗口顶栏尽量单层。窄窗口允许合理换行，不强制所有控件挤进一行。主动作和恢复入口始终可达。视口由 flex 分配剩余空间，不依赖固定 header 高度。

帮助使用原生 dialog，明确设置自动边距以居中，不依赖被全局 reset 覆盖的浏览器默认样式。短窗口限制最大高度，并允许对话框内部滚动。支持 Escape、关闭后归还焦点。图标按钮必须有 aria-label/title 与 focus-visible 样式。Tab 提示说明分叉所需条件，不拦截空画布的原生焦点导航。

全屏仅在 document.fullscreenEnabled、requestFullscreen 和 exitFullscreen 均可用时启用。API 不可用时禁用按钮，title 和 aria-label 说明原因；请求被拒绝时显示失败提示。监听 fullscreenchange 更新能力与真实进退状态。不得引入宿主权限或伪造全屏成功。

## 验收

- 每项行为变更先写失败测试，确认失败原因，再做最小实现。
- 真实 HTML 检查必需 ID 唯一、文本叶节点、浮层层级和控件可达性。
- 覆盖所有派生状态、最后卡片删除、最后会话删除、恢复失败、跨窗口冲突、零卡片 layout-only 同步。
- 无活动会话的手动/intent 宿主导入不得创建内存孤卡或 ACK；活动会话导入保持保存后 ACK 的次序。
- 覆盖帮助、全屏成功与拒绝、dispose 后无副作用、浮层鼠标和滚轮隔离。
- 真实 Chrome 检查顶栏长文本、保存错误、窄窗口；保留现有 IME、草稿和 96 组卡片标题栏几何测试。
- 状态更新不扫描正文、不重建卡片、不安装轮询或持续动画。
- 最终运行 node --experimental-vm-modules --test tests/*.test.mjs 与仓库已有 ESLint。无宿主实机证据时明确标记未验。
