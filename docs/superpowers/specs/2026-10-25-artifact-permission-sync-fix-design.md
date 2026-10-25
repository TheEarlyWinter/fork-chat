# 文档产物 Permission Model 兼容修复

## 目标

修复真实 App 创建文档时的 `fsync API is disabled when Permission Model is enabled.`。只修文档产物持久化路径。保留已有用户数据、权限模型和原子发布方式。不自动安装或运行模型。

## 已核实

- 源基线为 `dc614aa`。`dist-real-device/` 是未跟踪的旧包目录，原样保留。
- 文档路径为 `createArtifactService.create → createArtifactStore.publish → exclusiveFile`。
- Node 26.12.1 开启 Permission Model 后，真实 publish 在 `artifact-store.js` 的 `FileHandle.sync()` 失败，无文件卡。Node 24.21.0 的异步 sync 行为不同，不能代替 Node 26 验证。
- 两版本在权限模型下都支持 `O_SYNC | O_EXCL | O_CREAT | O_WRONLY | O_NOFOLLOW` 的真实打开、写入、关闭和路径改名。权限范围外写入仍被拒绝。
- `writeFile({flush:true})` 仍依赖 fsync，不能解决 Node 26 故障。

## 方案与取舍

选择：为 `exclusiveFile` 增加默认关闭的同步写选项。仅 artifact publish 在 Permission Model 下开启该选项，不再调用被禁用的 fd-sync；普通 Node 保留原有 write + sync。

不选择关闭权限模型、额外进程、native addon、SQLite旁路或吞掉全部错误。这些不是必要兼容修复。

不全局替换全部 sync。handoff、bridge 等协议要求目录同步，而 `open(directory, O_SYNC)` 不等于 `fsync(directory)`。它们保持现有失败关闭行为，不在本次暗中降级。

## 不变量

- 默认 `exclusiveFile(root,name)` 的调用行为不变。
- 同步写选项必须实际传递非零 O_SYNC；不支持时明确失败，不退回普通写。
- 保留根目录校验、O_EXCL、O_NOFOLLOW和0600权限。
- document.bin、preview.html和manifest.pending均完成写入及关闭后，才发布manifest.json。
- 保留取消、失败回滚、所有者隔离、校验和、不可变版本及读取安全检查。
- 非权限模型下的真实sync错误仍向上传播，不能变成成功。
- 产物元数据和内容不变，不承诺新增目录级掉电持久化能力。O_SYNC只用于文件内容及其相关文件元数据。

## 验收

必须先在真实Node26 + --permission子进程中看到当前实现失败，再验证相同测试通过。测试走真实文档服务和存储，不调用LLM或宿主。核对创建、读取、重建service后的读取、MD字节、预览和manifest发布，以及越权写入拒绝。保留既有路径替换、篡改、取消和失败无ready回执测试。

O_SYNC可能增加大文件分块写入成本。记录一个自有临时目录中的大产物测量，不把本机单次结果当性能承诺。最终运行Node24/26全套、逐文件语法及正规离线打包校验。包更新版本，但不自动安装。宿主实机和完整交接验收仍须另行执行。
