---
description: "从本机 Harness profile 查找 XTerminal 保存的服务器端点。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-tool-xterminal

[English](README.md) | 中文

## 概要

按名称或主机查找 XTerminal 保存的服务器。每个 Harness profile 可记住一个只读数据库。查询返回名称、主机和端口。获批的远程操作通过本机保存的密码或私钥认证。

## 使用方式

使用 `dsh plugin --profile <name> add file:/绝对路径/插件包.tgz` 安装本地包，或在 Desktop 插件管理器中选择该归档。Profile 会自动加载[组合包配置](cordis.patch.yml)。从源码调试时，可通过 `dsh --patch` 加载 `cordis.source.patch.yml`。

macOS 上默认检查 XTerminal 的应用数据目录。Host 管理者可以在 `allowedRoots` 中配置额外的本机受信目录，目录以绝对路径表示。发现失败时，模型可以提交候选路径，验证后首次保存。目录内容应由本机管理者控制。macOS 上，连接会复用 XTerminal 为同一主机和端口保存的可信 SHA-256 指纹。可在 `hostKeys` 中以 `host:port` 为键配置可信的 OpenSSH SHA-256 指纹，用于覆盖或补充。Profile 需要审批及后台作业能力。并发操作独立目标时，配置至少两个并行工具槽位。

## 模型体验

`xterminal_search_servers` 搜索并分页返回服务器端点。`xterminal_set_database_path` 在发现失败时首次配置数据库位置。`xterminal_connect` 和 `xterminal_run` 使用准确的名称、主机和端口来选择目标。长输出在文件写入期间返回最多 3000 字的预览、文件路径和作业 ID。通过作业状态确认文件是否完整。SSH 服务器拒绝启动命令时，工具返回错误。提前返回预览之后的失败通过作业状态查看。命令默认超时为审批后的 120 秒。工具定义会进入模型请求前缀。

#### KV Cache 影响

查询参数和已保存路径变化时，工具定义保持稳定。

## 已知限制与后续工作

- XTerminal 和 profile 均无目标指纹时，需要先配置可信指纹才能连接。本机进程必须能读取保存的密码或私钥。
- 已关闭的输出文件默认保留 30 天，可通过 `outputRetentionDays` 调整。
- 已保存的路径跨重启保留。路径失效时需修复 profile 本机配置。
