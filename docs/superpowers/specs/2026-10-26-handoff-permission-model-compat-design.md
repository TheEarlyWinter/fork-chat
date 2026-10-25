# 在 Hana 中继续：权限模型兼容修复

## 已确认目标与取舍

用户要求直接实施并快速交付。用户明确接受不为突然断电、内核崩溃和目录项丢失增加保障。本文件覆盖原交接规格中 PM 环境下的目录同步要求。普通 Node 的既有持久化语义不变。

目标：修复 Node 26 Permission Model 下准备交接、确认和文件交付因 FileHandle.sync 被禁用而失败的问题。完整已保存正文、依赖范围、文件、主页会话、Agent、memoryEnabled=false、triggerTurn=false 均保持。

## 选择

保留现有文件 Store，不迁移到宿主 KV。KV 没有 CAS 或掉电保证，且共享现有画布存储配额，迁移增加改动与故障面。

新增交接专用的小型 IO 策略。PM 下，文件以 O_EXCL + O_SYNC 写入，不调用被禁用的 fd sync；目录仍检查真实目录与非符号链接，但不调用目录 sync。普通 Node 保留原文件与目录 sync。O_SYNC 不支持时明确失败。不能把文件同步称作目录或掉电保证。

## 改动边界

- `lib/handoff-io-policy.js`：`handoffUsesSynchronousWrites()` 与 `handoffWriteFlags(ordinaryFlags)`。真实 process.permission 决定模式。无用户请求开关。
- `lib/handoff-store-io.js`：使用策略；保留 EEXIST、owner、独占 claim、状态机、防重与清理规则。文件写入或关闭失败必须抛错。PM 的目录检查不因免同步而消失。
- `lib/handoff-delivery.js`：临时产物和交接 Markdown 同策略；保留私有目录、安全路径、关闭、rename 和清理错误处理。
- `ui/assets/panel-handoff-view.js`、README：简短说明异常中断后人工核查、不盲目重复交接，不增加设置或复杂交互。
- manifest：版本 2.3.0-beta.3；权限、最小平台版本和网络不变。

保留错误时停止、unknown/partial 不重发、创建前持有独占 claim、每阶段记录回执、只有全部成功才 ready。prepare 不创建会话，不调用模型。不同动作是否重新创建仍由用户明确发起。

## 验证与交付

只做必要验证：新增真实 Node PM 下的完整服务流程、并发确认和重建后的不重发；已有普通模式 IO 故障回归；最终 Node26 全量一次，Node24 只跑新增和相关回归。复用原 fixture，不做无关测试重构，不再测试掉电。

只运行隔离目录与 fake host，不操作真实画布、不调用业务模型或创建宿主会话。完成一次独立审查与正式静态打包校验，交付 beta.3 并通过正式入口提交更新。安装需要平台真实用户确认时，保留待确认状态，不绕过。

## 工作区

基线 74de8cb10b39fbacc3623e823ff6cb9f73e4ec4d，分支 fix/handoff-permission-model。小鲸鱼的测试入库、CI、打包与重组提交全部保留；其已交接停止写入。同一工作树只有一名源码写手。保留旧产物目录。不删除历史文件，不修改原项目或平台配置，不自动发布 Release。
