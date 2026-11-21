# 代码评审 · Feature 999

## 本轮复评 · 远端拒绝修复通过

明确拒绝 exec 时，Harness 现已正确返回结构化失败。默认命令超时仍为审批后的 120 秒。需求负责人接受启动确认前断线时的错误分类风险，本轮修复通过复评。上轮取消竞态按需求负责人选择暂缓，原验收条目仍需同步。Feature 的整体交付证据仍待补齐。

### 已接受的 P1 · 启动确认前断线会被报告为命令未启动

[命令采集](../../../packages/experimental/tool-xterminal/src/command-output.ts#L75)把 SSH exec 回调中的所有错误映射为 `XTERMINAL_COMMAND_START_FAILED`，提示“Could not start the SSH command”。[技术方案](../design/TECH_DESIGN.md#认证会话归属与失败)要求命令已发出而结果无法确认时报告结果未知。当前实现把明确拒绝和启动确认丢失合并，调用方可能把已经送达服务器的命令当成未启动而再次执行。

回环探针让 SSH 服务记录无副作用的命令标记，收到 exec 后在回复确认前断开。服务端确认收到命令，插件仍返回 `XTERMINAL_COMMAND_START_FAILED`。复现针对送达与确认顺序，未推断实际命令是否执行。旧版本在此分支统一报告结果未知，因此这是本轮结构化错误改动引入的语义回归。

仅在有肯定证据证明命令未发送或远端明确拒绝时使用启动失败。无法区分拒绝与连接中断时，采用保守的结果未知提示。复验明确拒绝、已收到 exec 但未确认即断开，以及已确认的非零退出，核对错误码及是否提示可安全重试。

### 上轮发现复核

- **明确拒绝返回成功已关闭。** [工具执行体](../../../packages/experimental/tool-xterminal/src/remote-tools.ts#L297)现在抛出结构化错误。当前隔离 headless profile 的真实工具结果为 `isError: true`，错误名和错误码分别为 `XTerminalCommandError` 与 `XTERMINAL_COMMAND_START_FAILED`。同批另一条命令的确认退出码 7 仍可见。
- **默认超时符合本轮要求。** [配置](../../../packages/experimental/tool-xterminal/src/index.ts#L28)和运行时均为 120 秒。审批后启动作业并创建超时信号，复评核对了代码，未专门等待 120 秒。
- **取消竞态按用户决定暂缓。** 原 P0 记录及证据保留，当前 [AC-8](../spec/PRD.md#验收条件) 仍要求取消时本次命令不执行。本轮决定未同步到 PRD，验收不得标为通过。
- **stdin EOF 仍开放。** 上轮 P1 继续存在于等待输入结束的命令路径，默认超时会限制等待时长。本轮范围仅确认默认超时与结果分类，未要求调整 stdin 行为。

### 本轮范围与证据

基线为 `f607b270c50fd0334811daa8384825b6bc3f5525`。分别检查暂存差异、未暂存差异及未跟踪源码和测试。按原报告同一清单生成的 SHA-256 摘要为 `f1be486697b5b5b622a2967b315b8fba40e0c28a4a7168927c7b91ce3565c3ff`。本轮聚焦远端拒绝、超时默认值与相关错误路径。

- 在仓库根目录使用 Node v24.22.3 执行 `node_modules/.bin/vitest run packages/experimental/tool-xterminal/tests`，9 项通过，退出 0。
- 在仓库根目录运行隔离 headless 测试驱动和回环 SSH 断线探针，两者均退出 0，分别验证明确拒绝的 `tool/result` 与确认前断线的错误分类。当前回归测试覆盖前者，后者仍缺常规测试。
- 当前仍缺 Feature 999 的无密钥会话快照。真实目标验收沿用上轮未通过的网络证据，本轮未连接真实服务器。

## 上轮评审记录

## 结论

修改后重新审查。取消竞态可让已取消的命令发往服务器，阻断合并。另有两项 P1，分别影响等待 stdin 的命令和失败结果的可识别性。

## 关键发现

### P0 · 批准后的命令可在取消后才发往服务器

[命令采集入口](../../../packages/experimental/tool-xterminal/src/command-output.ts#L50)在调用 `client.exec` 前检查取消，但直到 SSH 库回调才拿到通道。库在收到 session channel 的打开确认之后才发出 exec 请求。如果此时信号已取消，插件既无通道可关闭，又给整个连接留了 1 秒。期间迟到的打开确认仍会触发 exec。[工具层](../../../packages/experimental/tool-xterminal/src/remote-tools.ts#L279)取消预览等待与停止作业都走这一生产者取消入口。

回环探针让测试 SSH 服务在批准 session channel 时先触发本地取消，再完成通道打开。测试端收到了取消之后才送达的无副作用 exec 标记，而本地作业状态为 `killed`。这违反 AC-8。正式命令在同一时序下可能产生远端变更。

修复要求在真正发出 exec 请求前让挂起的通道打开能响应取消。若现有 SSH 接口无法撤销挂起的请求，应在这个阶段立即终止对应传输，并明确同目标其他作业受到的影响。补回归测试，挂起通道打开后取消，释放测试端等待点，断言未收到 exec、作业已结算且其他目标不受影响。已发出 exec 后的断线继续报告结果未知。

### P1 · 无输入工具没有关闭命令的 stdin

[通道建立后](../../../packages/experimental/tool-xterminal/src/command-output.ts#L66)只监听输出与退出，没有结束可写端。命令接口也没有 stdin 参数。回环测试端模拟等待 EOF 才返回的普通非交互命令，观察到按时限取消，服务端在正常执行窗口内没有收到 EOF。实际命令如等待输入结束的 `sort` 会被拖到超时。

启动后为 stdin 正常发送 EOF，保持 stdout 与 stderr 可读。测试等待 EOF 后继续回传输出的命令，并复核退出状态及全文采集。

### P1 · 远端拒绝启动时工具结果仍为成功

[采集错误分支](../../../packages/experimental/tool-xterminal/src/command-output.ts#L132)将失败提示交给 `publish`，同时把作业结算为 `failed`。[命令工具](../../../packages/experimental/tool-xterminal/src/remote-tools.ts#L295)只等待预览字符串，随后正常返回。Harness 将该次调用记录为成功结果。回环测试在 SSH 服务拒绝 exec 时复现了失败预览与作业 `failed` 的组合。此时响应也没有作业 ID，调用方无法从这次工具调用直接定位作业状态。

以结构化初次结果区分完成、提前返回与失败。命令尚未给出提前响应时，启动、采集或存储失败由工具抛出固定诊断和错误码。提前返回后发生的故障沿现有作业终态报告。用真实工具入口验证拒绝启动与输出写入失败的 `tool/result.isError`、错误码及无效路径缺失，并保留正常非零退出码的展示。

## 范围与证据

比较基线为 `f607b270c50fd0334811daa8384825b6bc3f5525`。分别检查暂存与未暂存差异，并纳入未跟踪的插件源码、文档和测试。范围为工作区 `packages/experimental/tool-xterminal`、关联构建接入，以及 [PRD](../spec/PRD.md#验收条件)、[技术方案](../design/TECH_DESIGN.md)、[设计评审](design_review.md)与[测试计划](../test/TEST_PLAN.md)。插件源码、测试与锁文件按路径顺序生成的 SHA-256 清单摘要为 `e37202926dbd9554aabdbc1d8531794bec3548a7c1286ff6b6990f53f1b2af05`。

- 在当前仓库根目录使用 Node v24.22.3 执行 `node_modules/.bin/vitest run packages/experimental/tool-xterminal/tests`，8 项通过。已有测试覆盖目录解析、首次保存、并发补录、只读查询、密码与私钥认证、错误指纹及提前返回后的完整文件。新发现落在这些测试尚未覆盖的失败时序。
- 隔离临时目录的 `node --import tsx/esm probe.mjs` 与 `node --import tsx/esm cancel.mjs` 均退出 0，分别确认等待 stdin 与通道拒绝、取消与 exec 到达顺序。只使用回环 SSH 与合成凭据。
- `git diff --check` 通过。暂存差异检查报告已有规格素材索引的文件末尾空行，以及 PRD 标题元信息行的行尾空格。
- Cordis 生命周期核对覆盖插件注册、作业归属与连接清理。插件卸载与断线同时发生时是否等待已经脱离活动连接表的作业写入，仍待受控生命周期验证。

## 待补交付证据

仓库尚无 Feature 999 的无密钥会话快照，需覆盖实际 profile 的模型可见结果与 Session。之前针对「阿里99元」的连接未成功，独立握手探测也超时，生产目标的认证与命令验收仍未完成。此轮未重试真实目标。PRD 的 AC-7 仍需按已确认的设计同步运行中续读及终态完整性。
