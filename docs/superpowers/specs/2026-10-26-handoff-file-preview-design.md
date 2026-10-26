# 交接文件按需预览设计

## 目标与事实

用户已授权独立修复。交接正文已经显示。本轮只修两个 MD 文件无法打开，不重做交接，不调用模型。

真实文件可通过正式文件工具复制并读取。原产物为 1584 字节，归档为 3362 字节。因此不是文件被清理。

生产 renderer 的 `X0e → Y0e → jZ` 处理 App `resource.open`。它只查前端已加载的文件表，不按 `sessionId` 从宿主加载文件。这个缺口足以导致已交付文件无法打开。尚未取得本次点击的运行时错误码，不把源码推断写成实测。

Core `open_preview` 是另一条协议。不得据其严格 locator 校验删除 App 引用中合法的 `sessionId`。

## 方案

对 `text/markdown` 和 `text/plain` 按点击读取宿主真实文件，在卡片内预览。保留完整原文查看。Markdown 复用现有安全的基础渲染器，不声称支持全部 Markdown、数学公式或精确分页。其他格式维持现有宿主打开入口，本轮不承诺修复。

不增加权限、依赖、持久缓存或轮询。不改 PM IO、claim、unknown、防重、stage、会话创建及 custom 消息投递。

## 后端接口

新增 `GET /api/handoff/sessions/:sessionId/files/:fileId/preview`。

1. owner 仍由正式请求 principal 取得。复用现有 receiptReader。要求 fileId 精确属于该 owner、该 session 的交接回执。
2. MIME、文件名只取回执。只接受 `text/markdown`、`text/plain`，可忽略 MIME 参数及大小写。其他 MIME 返回明确不支持。
3. 正式调用 `sdk.resources.stat/read({kind:'session-file', sessionId, fileId})`。不得直接读宿主私有目录，不把 `session.path` 当文件路径；该字段是空间标签。
4. stat 必须存在、非目录、有有效 size，且不超过 2 MiB，才调用 read。read 必须返回 Buffer 或 Uint8Array，再次检查实际长度及资源身份。stat/read 的资源 kind、sessionId、fileId 必须与请求一致。
5. UTF-8 使用 fatal 解码。拒绝非法编码及 NUL。文件为空可正常显示。
6. 成功 DTO：`{ok:true, preview:{fileId,name,mime,format:'markdown'|'text',text,html?}}`。text 是完整解码原文。仅 Markdown 带安全 html fragment。
7. 使用 `parseDocumentBlocks` 和 `renderDocumentHtmlFragment`。结构超限或 HTML 超过 4 MiB 时改为完整原文预览，不能静默截断。
8. 文件读取最多 4 个不同请求同时进行；同 owner/session/file 的并发读取合并，结束后释放。不缓存文件内容。
9. 错误只返回固定短中文与稳定码。未归属文件返回 404；不支持 415；过大 413；繁忙 429；其它读取/编码/回执异常明确失败。不得返回宿主原始错误、路径或 owner 指纹。

## 前端边界

仍只认 embeddedSessionId。MD 和纯文本按钮走新接口，不依赖 `hana.resources.open`。普通交接正文仍按当前设计显示，不重做整段正文排版。

使用轻量卡内预览区。Markdown 使用空 sandbox、no-referrer 的 iframe；srcdoc 带 `default-src 'none'`、静态样式、禁止脚本/网络/表单/基址。完整原文用 textContent 显示。不要加载整个画布模块。若提取公共模板，改动必须仅为必要复用。

每张卡一次只读一个文件，加载时禁用文件按钮。预览提供关闭与预览/原文切换。绑定变化、关闭预览、卸载均使旧请求失效；旧响应及错误不得重开预览或污染新绑定。非文本保留现有 opened 检查及迟到隔离。错误展示固定文案和稳定码，不显示原始宿主信息。

## 验收

- 行为测试先 RED，再 GREEN。SDK fixture 必须匹配生产 stat/read 的完整形状，content 为真实字节，不把假调用成功当打开成功。
- 不依赖前端已加载文件表时，两份 Markdown 的真实字节仍可展示；原文完整。
- 覆盖越权 owner/file/session、错误资源身份、空文件、非法 UTF-8、NUL、2 MiB 前后边界、读取后超限、结构回退、恶意 HTML、并发与迟到隔离。
- 相关回归后只跑一次全量；一次独立审查。版本为 2.3.0-beta.5，13 项权限不变。
- 正式管理器安装，不改已安装目录。需要本人批准时停在批准入口，不代点。
- 实机仅用既有交接与文件。安装成功不等于实机预览通过。未验项目单独标明。
