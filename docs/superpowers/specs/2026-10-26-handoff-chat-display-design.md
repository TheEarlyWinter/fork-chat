# 交接后 Chat 空白修复

## 目标与事实

用户要求直接修复。用户确认 Chat 页已经创建目标会话，但正文和文件均不可见。此前 Code 可见性与验收浮窗造成的导航判断已撤回。

基线：8fa083d126e758ec0a56ef05e2015bb9dc2e9915。PM IO 修复不变。只改开发副本，不改宿主或已安装目录，不重新创建现有交接。

已核官方 1.2.1-beta APPS.md 1406-1429 与宿主投影实现：sendCustom(display:true) 的 App 消息要声明 contributes.messageRenderers 才生成流内卡。stageFile 只登记 SessionFile，不产生原生附件气泡。现有 branch-handoff 无映射。自定义消息本身会写入，仍需实机回读确认现有目标。

## 方案

增加专用轻量只读交接卡，不复用完整画布。manifest 将 branch-handoff 映射到 /handoff-receipt.html。历史 custom entry 会重新投影，legacy 来源不阻止普通只读 iframe；不需要重复 create、stage 或全文补发。

卡片只用宿主 surface.getContext().embeddedSessionId 识别所在会话。originSessionId 语义不同，不能代替 embedded；禁止 URL、全局 getActive、当前焦点或猜测会话。无绑定即明确不可用，不请求数据。绑定变化立即清空旧内容，迟到响应不得串会话。

新增 GET /api/handoff/sessions/:sessionId/receipt。沿现有稳定 principal 解析 owner。通过正式 sdk.sessions.get/entries 读取该公开 home 会话中本 App 的 app:timeline-reverser/branch-handoff custom_message。只投影目标消息正文、来源和文件回执；不返回其他消息、系统提示、路径或凭据。sessionId 回显必须匹配。使用当前 leafId 父链限定活动分支，循环/缺父链失败关闭，多候选不猜。

正文权威来源是宿主已保存 custom entry，而不是会被回收的动作 payload。新消息 details 增加 handoffView v1，包含由 owner 得到的 ownerScopeKey、agentId、安全文件回执（含 archive）。这是消息自有数据，不修改模型触发策略。ownerScopeKey 仅在服务端依据真实 principal 计算比对，持有该值不构成授权。新元数据无效或归属不符就拒绝，不能降级绕过。

旧 beta.3 消息没有 handoffView：仅当当前 owner 的现有动作记录与 sessionId、entryId、actionId 一致时，允许用原文件回执和宿主正文恢复显示。不依赖旧 payload，也不自动补发。旧记录已完全回收且无可核归属时明确不可用，不放宽权限。

卡片用文本节点显示完整正文和文件名，不注入 HTML。文件按钮使用 hana.resources.open({resource:{kind:'session-file',sessionId,fileId},mode:'preview'})。不伪造原生用户消息或原生附件气泡，不自动调用模型。文件入口位于交接卡，真实文件继续属于主页会话。

## 性能与边界

新页不加载画布、模型池、KaTeX 或新依赖。每次绑定一次 GET，无轮询。SDK entries 没有分页，因此只在首次读取时调用，缓存仅含经授权的不可变交接投影。服务端按 ownerScopeKey+sessionId 去重并缓存，最多32项且总UTF-8数据不超过16MiB；失败不缓存，不保存其他历史。缓存丢弃可重读，不参与业务状态机。

原有 owner/claim/回执/unknown 不重发、home、指定Agent、memoryEnabled=false、triggerTurn=false 保留。不扩权限、不改网络。版本 2.3.0-beta.4；最低宿主取已验证的1.2.1-beta，不断言这是功能首次引入版本。

## 验证与交付

必要 RED/GREEN 覆盖映射、真实 SDK DTO 形状、旧消息恢复、新消息脱离动作记录仍可读、跨 owner 拒绝、消息选择、绑定缺失/迟到响应、文本转义与文件预览。Node26相关回归后全量一次，一次独立审查。正式打包新目录，保留旧包。正式入口提交更新；本人批准后，优先重开原目标会话验收，不再盲目新建。原目标线索 sess_0mvoq8kuz_14978a2622dadfae97e5，动作 ha_397b2a7a5318e0343cd06b600e623214。
