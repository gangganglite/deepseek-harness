# 技术方案 · XTerminal 任务连接

> Feature 999 | Profile simple | 待评审 | 代码基线 f607b270c5，工作区含未验证的查询插件 | 模板 .agents/skills/my-create-design/assets/templates/TECH_DESIGN.simple.tmpl.md

[返回 BRIEF](../BRIEF.md) · [有效需求与 AC](../spec/PRD.md#验收条件)

## 需求依据

PRD 统一维护 AC-1 至 AC-8。早期技术方案与[早期评审](../review/design_review.md)针对只读查询。保留该方案的查询投影、分页、结构化错误和回放验证。任务连接、凭据使用和路径更新按本方案重新评审。

## 最小实现方案

继续使用 `packages/experimental/tool-xterminal`，首版用 TypeScript 和现有 Node.js。保留 `xterminal_search_servers`。新增首次路径补录、建立连接和使用连接的独立工具。只有当前任务需要访问服务器时才调用建连工具。任一远程操作仍走 Harness 工具权限管线，部署必须能向用户展示并确认已选目标和具体命令。没有可用审批时拒绝受控操作。

现有 [SshConnection](../../../packages/ssh/ssh/src/index.ts) 启动 OpenSSH master，再启动部署指定的远端 Helper 并校验摘要。它没有接收外部会话的入口。插件首选使用经实测的 Node SSH 客户端，候选为 `ssh2`，在插件内部完成认证。Harness 的普通工具调用通过本插件使用已建立的会话。同一个 Agent 在当前 turn 可持有多个目标会话。独立远程命令工具要求每次显式提供目标，不维护默认会话。普通 Bash、文件、终端和 PTC 执行位置保持由各自配置控制。现有 `dsh-ssh` 无需改动，也无需服务器安装 Helper。

备选临时连接引用只在首选交接验证无法通过时进入设计评审。若启用备选，引用仅在本机进程间或服务间传递，绑定 Agent、Session、turn、目标与期限。插件负责兑付、认证和关闭，模型工具返回只含脱敏目标及连接状态。首选方案无需签发、持久化或回收此类引用。

### 路径发现与更新

- 如果 profile 已保存路径，只使用该路径。失效或不可读时报告配置故障。若尚未配置，先检查 macOS 默认路径 `~/Library/Application Support/xterminal/sqlite/local-store.db`，再在已知 XTerminal 数据根和本机配置允许的目录做有界发现。找到唯一可信的有效来源就保存并继续。无法确定来源时停止自动选择。
- 自动发现失败且未配置时，查询或建连返回 `XTERMINAL_DATABASE_UNCONFIGURED`，提示模型查找并调用 `xterminal_set_database_path` 首次补录。候选必须是允许目录内的本机普通文件。解析真实路径并以只读方式校验 SQLite 结构与来源，拒绝链接逃逸。模型提供的路径可能出现在工具调用记录中，模型结果省略原始 SQLite 错误。
- 自动保存和首次补录共享 profile 私有文件锁与原子写入。锁内复读已保存值，成功首写后其他写入都拒绝。显式补录在锁内重新检查未配置和自动发现失败，再校验候选并提交。如果此时已经可以自动发现，保存自动发现结果。失败不写入。每次打开重新验证有效路径，源数据库保持只读。

### 认证、会话归属与失败

1. 建连工具解析唯一目标，构造脱敏审批摘要。用户批准后按同一数据库与记录标识重新读取选定行，比较数据库标识、记录标识、主机、端口及记录修订。变动时取消本次连接并重新选择。数据库更新不会改变已建立会话的目标。
2. 认证读取只针对目标，覆盖密码、私钥及所需口令。使用 XTerminal 正常可访问的本机认证材料。遇到不可读或无法解锁项立即停止，返回固定错误。认证材料只传给本机 SSH 客户端，禁止经过 argv、环境变量、临时文件、工具结果、诊断或 Session。连接实现不注册 SSH 调试输出。
3. 连接握手启用主机密钥验证。首版验证由本机运维可信配置提供目标端点及主机 SHA-256 指纹。未知或变化的主机密钥在认证前拒绝，显示目标与恢复动作。密码和私钥共用相同验证。插件禁止 agent forwarding。
4. 会话按 Agent、Session、turn 和目标记录标识登记，并固定连接实例及端点。多个目标独立使用。相同目标的并发建连合并到同一次尝试，成功才登记。连接关闭后按实例移除，避免旧事件清理新实例。工具结果只返回已选目标和状态，会话句柄留在插件内。
5. 每条命令以选定目标标识和命令文本提交，审批绑定调用和选中的连接实例。等待审批不单独触发命令执行超时。批准后检查调用仍有效，在对应目标的会话队列内对同一实例原子登记在途通道并提交打开请求。审批期间操作其他目标互不影响。原实例已关闭或调用已取消时直接失败。拒绝按同名目标重新选取连接，拒绝向替换实例重放命令。
6. 通过 `session/event` 的对应 `turn/end`、Agent 销毁或插件卸载清理实例。先撤销对应连接入口并禁止新通道。正常 turn 结束时允许已交给作业管理的通道完成，Agent 销毁或插件卸载则取消作业并等待本地释放。建连阶段的失败、超时和取消关闭待建立连接。断线只使对应目标失效。已经发送命令但未取得确定结果时报告结果未知，避免自动重试。

### 并行调度与审批

连接和远程命令工具声明可并行，接入 profile 的并行槽位至少为 2。工具仍经过 Harness 的原有策略。插件专项的目标与命令确认在执行体中等待，避免在 [`batch.ts` 顺序执行的准备阶段](../../../packages/core/tools/src/batch.ts#L154)暂停整批。若该 profile 的通用前置策略也要等待审批，先用真实批次验证它不会把这两类工具重新串行化。没有批准的调用不提交 SSH 操作。

A、B 各用自己的 SSH 连接。B 已连接就复用，需要连接时可在同一并行批次发起 B 的建连调用，并按 B 的目标独立审批。命令依赖尚未就绪的连接时，等该连接就绪后提交。连接和命令各自绑定目标与调用，B 无需等待 A 的审批。插件的审批等待、远端运行与文件写入均在锁外。同一目标上的独立命令也可使用不同通道并行，存在依赖的命令由调用方串行提交。

并发验收使用可控审批和两个测试目标。在同一个真实 Harness 批次中挂起 A 的批准，并批准 B。测试夹具直接断言 A 尚未打开命令通道、B 的命令已独立执行，之后批准 A 并断言只在 A 的原连接执行。测试不需要人工观察服务器。工具批次沿用 Harness 的有序结果发布，执行可以重叠。

### 远程输出与续读

采集 SSH 命令通道的 stdout 和 stderr，保留原文及接收顺序，分流解码 UTF-8 跨块内容。在会话可读、私有的本机目录逐段写入文件，写入慢时对通道施加背压。内存只保留有界预览和写入队列。可见文本按 Unicode 码点计数，预览和尾部提示总计最多 3000 字。认证诊断走独立固定错误，本机读取的凭据、连接引用和客户端调试输出均与命令输出分离。

复用 [`ctx.jobs.start`](../../../packages/jobs/jobs/src/index.ts#L112) 托管每条已获批命令，使用 [`JobOutputSource.spillPath`](../../../packages/jobs/jobs/src/types.ts#L101) 发布最终完整文件的元数据。现有作业输出环可辅助读状态，完整文件由 SSH 输出写入器持有。工具在命令结束与输出超过内联预算两者先发生时响应。命令短且已完成时直接返回；一旦确认超限且文件已实际可读，即返回预览、文件路径和作业 ID，末尾提示「部分输出已省略。输出仍在写入 {路径}，请按需读取，并通过作业状态确认何时完成。」运行期间读到文件末尾只代表此刻已写到这里；作业完成且写入关闭后，文件才是完整输出。短命令超限且已结束时使用完整文件提示。

运行中的路径仅由首次响应带状态提供。写入全部数据且成功关闭后，写入器先发布完整路径元数据，再让作业进入终态，以便 Jobs 的末次采集读到该路径。取消、超时、断线或写入失败时，已返回的路径仍只代表可读的部分输出，作业终态说明原因，完整文件字段保持为空。文件创建失败时返回限长提示，省略路径。

插件持有会话私有输出目录并负责文件保留，作业持有写入期的文件所有权。运行中不删除。作业结束后保留文件供原会话续读，按部署配置的保留期清理已结束的文件。清理使用关闭后记录的终态时间与文件归属，覆盖完整和部分输出，避开仍被其他 Host 进程持有的写入文件。Jobs 的记录回收和文件清理各自执行。

工具返回后，作业继续拥有该命令通道及其连接引用。turn 结束后收回该 turn 的连接入口，仍在写入的任务已批准作业可继续运行，最后一个作业完成后释放连接。Agent 或插件销毁、取消、命令超时及断线时回收通道和写入器，作业可见状态区分已完成、已取消、读取或存储失败，以及命令结果未知。文件无法创建时不给路径，写入失败保留可读片段时明确标为不完整。关闭和剩余输出写入均结束后才提交终态。首版实施时验证文件路径可被同一 Harness 会话实际读取，并复用现有作业状态与停止机制。

## 供评审的代码设计

以下为拟议伪代码。省略注册样板与库 API 适配，尚未验证本机认证及工具调用链。

```text
index.ts
  search(input) -> catalog.search(await paths.resolve(), input)
  setPath(input) -> paths.initializeIfUnconfigured(input.path) -> configured
  connect(input, exec):
    owner = requireLiveAgentSessionTurn(exec)
    target = catalog.resolveUnique(await paths.resolve(), input)
    await authorizeExactTarget(owner, target.publicEndpoint, exec)
    runSerially(owner, target.id):
      requireStillLive(owner, exec.signal)
      if sessions.hasCurrent(owner, target): return publicStatus
      auth = catalog.readSelectedAuthIfUnchanged(target)
      session = await ssh.connectVerified(target, auth, exec.signal)
      commitIfLiveOrClose(owner, target, session, exec.signal)
    return target.publicEndpoint and ready

  run(input, exec):
    owner = requireLiveAgentSessionTurn(exec)
    session = sessions.requireTarget(owner, input.target)
    await authorizeExactCommand(owner, session.publicEndpoint, input.command, exec)
    job = jobs.startOwned(owner, callId, start: registerChannelIfSameInstance(session, input))
    return job.previewOnCompletionOrReadableOverflow(3000, exec.signal)
```

仅独立连接与远程命令工具声明并行，路径补录仍由文件锁保护。工具调用取消若发生在返回前，应取消已创建的作业，工具成功返回后由作业生命周期继续管理。认证数据类型保留在 `catalog.ts` 到 `ssh-session.ts` 的内部接口，工具定义只依赖目标投影。预期故障转换为固定 `HarnessError` 名称与错误码，避免附加原始错误。

## 实施任务与验证

| 任务 | 文件 / 模块 | AC | 完成条件 |
|---|---|---|---|
| 复用查询并处理路径 | `catalog.ts`、拟新增 `database-path.ts` | AC-1、AC-2、AC-3、AC-5 | 合成库验证投影、空表、分页、损坏、链接逃逸、并发首次补录、已有配置拒绝覆盖及重启复用。真实本机库只做脱敏查询冒烟。 |
| 验证认证和主机身份 | `catalog.ts`、拟新增 `ssh-session.ts`、依赖声明 | AC-2、AC-4、AC-6 | 合成库和隔离 SSH 服务验证密码及私钥两种建连、错误口令、未知或变化主机密钥。用本机支持的方式核实实际 XTerminal 认证记录可取得。 |
| 接通原任务 | `index.ts`、`ssh-session.ts`、显式 Cordis overlay | AC-3、AC-4、AC-6、AC-8 | 真实 `dsh` profile 用录制或模拟模型驱动两种认证的任务接续。验证无审批、受控审批下同批 A 被挂起、B 独立执行及 A 仅在原连接执行、同目标并发、原实例关闭、重复调用、取消、断线、卸载与跨 turn 拒用。 |
| 限长展示与续读 | 拟新增 `command-output.ts`、jobs 配置及文件读回 | AC-2、AC-7 | 验证 3000 字边界、中文及 emoji、跨块解码、提前返回后续读、运行中读到文件末尾、完整文件读回与元数据发布、部分输出标记、作业跨 turn 收尾、文件保留与存储失败。 |
| 完成发布面与快照 | 包 README、构建配置、keyless snapshot | AC-1 至 AC-8 | 检查模型请求、工具结果、日志及 Session 无认证哨兵与连接引用，完成聚焦测试及产物构建检查。 |

早返回为本轮已明确的交互，补充了 AC-7 的交付时序。PRD 后续应同步运行中路径、作业状态和最终完整性，保留现有 AC 编号。

## 实施前待验证

现已核对现有 SSH 部署入口、工具注册、审批接口和原查询代码。真实库先前只核验了记录字段和类型。实施前应验证两种凭据的本机可用性，验证候选 SSH 客户端的主机身份校验，并用隔离环境演示已建立连接可以完成一次 Harness 任务操作。此次为文档设计，以上运行验证尚未执行。早期只读查询评审不覆盖新能力。
