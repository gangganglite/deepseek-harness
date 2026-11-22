---
description: "从本机 Harness profile 查找 XTerminal 保存的服务器端点。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-tool-xterminal

[English](README.md) | 中文

## 概述

按名称或主机查找 XTerminal 保存的服务器。每个 Harness profile 可记住一个只读数据库。查询返回名称、主机和端口。获批的远程操作通过本机保存的密码或私钥认证。

## 目录

- [使用方式](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用方式

使用 `dsh plugin --profile <name> add file:/绝对路径/插件包.tgz` 安装本地包，或在 Desktop 插件管理器中选择该归档。Profile 会自动加载[组合包配置](cordis.patch.yml)。从源码调试时，可通过 `dsh --patch` 加载 `cordis.source.patch.yml`。

macOS 上默认检查 XTerminal 的应用数据目录。Host 管理者可以在 `allowedRoots` 中配置额外的本机受信目录，目录以绝对路径表示。发现失败时，模型可以提交候选路径，验证后首次保存。目录内容应由本机管理者控制。macOS 上，连接会复用 XTerminal 为同一主机和端口保存的可信 SHA-256 指纹。可在 `hostKeys` 中以 `host:port` 为键配置可信的 OpenSSH SHA-256 指纹，用于覆盖或补充。Profile 需要审批及后台作业能力。并发操作独立目标时，配置至少两个并行工具槽位。

`xterminal_connect` 默认为 `mode: "plugin"`。任务需要由 Harness 发起连接时，使用 `mode: "harness"`。Harness 在本机进程内使用一次性引用，用目标保存的密码或私钥完成认证。两种模式都可在当前任务中通过 `xterminal_run` 操作已选目标。同模式的重复调用复用连接。当前连接或建连尝试结束后，可切换模式连接同一目标。

<a id="model-experience"></a>
## 模型体验

### 工具定义与结果

#### 模型看到的内容

[XTerminal 工具定义](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-xterminal)覆盖端点查询、首次配置数据库、建连和执行命令。通过准确的已保存名称、主机和端口选择目标。命令默认超时为审批后的 120 秒。长输出会返回最多 3000 字的预览、输出文件路径和作业 ID。通过作业状态检查是否完成或失败。SSH 服务器拒绝启动命令时，工具返回错误。

#### Token 影响

工具可见时随请求发送四份固定工具定义。

#### KV Cache 影响

查询参数和已保存路径变化时，工具定义保持稳定。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- XTerminal 和 profile 均无目标指纹时，需要先配置可信指纹才能连接。本机进程必须能读取保存的密码或私钥。
- 已关闭的输出文件默认保留 30 天，可通过 `outputRetentionDays` 调整。
- 已保存的路径跨重启保留。路径失效时需修复 profile 本机配置。

<a id="dev-note"></a>
### 开发备注

无。
