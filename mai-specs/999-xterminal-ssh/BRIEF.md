# 999: XTerminal 服务器插件

| 项 | 值 |
|---|---|
| Phase | draft |
| Profile | simple |
| 优先级 | P1 |
| 负责人 | shuta |
| 目标日期 | 待填 |
| 涉及子系统 | 实验性工具、SQLite |

## 一句话描述

在用户交办的任务需要访问服务器时，使用 XTerminal 中已保存的连接继续任务。

## 背景

Harness 自动发现并记住本机 XTerminal 数据库位置，自动发现失败且尚未配置时支持模型首次补录，认证信息留在本机。

## 关键决策

因涉及本机认证数据，采用简版技术方案、设计评审、实施、代码评审和真实验收。[PRD](spec/PRD.md#验收条件)统一维护有效需求与验收条件。[技术方案](design/TECH_DESIGN.md)已按当前 PRD 同步首次路径补录、远端输出限制、完整输出续读与按目标管理 SSH 会话，待复评。

首版统一使用 TypeScript，覆盖 Cordis 插件入口、本机凭据读取和 SSH 认证建连，运行时沿用 Harness 的 Node.js。

## 上下文索引

- [素材索引](context/_INDEX.md)
- [简版 PRD](spec/PRD.md) · 待评审，保留 AC-1 至 AC-3，新增 AC-4 至 AC-8。
- [技术方案 HTML 审阅版](design/TECH_DESIGN.html)
