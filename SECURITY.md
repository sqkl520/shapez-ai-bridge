[English](SECURITY-EN.md) | 简体中文

# 安全策略

## 报告漏洞

**安全问题的报告千万不要开公开 issue。**

请通过 GitHub 的[私密漏洞报告](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)渠道私下提交：

1. 打开本仓库的 **Security** 标签页。
2. 点击 **Report a vulnerability**。
3. 描述问题，并说明如何复现。

如果这个渠道对你不可用，请开一个公开 issue，**只**写「Security issue — requesting a private channel」，不要带任何技术细节，维护者会主动联系你。

请尽量提供：

- 受影响的组件（mod / bridge / MCP server / agent / GUI），
- 版本号或 commit，
- 复现步骤，或一个 PoC，
- 你判断的影响范围。

## 响应时间

| 阶段 | 目标 |
| --- | --- |
| 确认收到报告 | 3 个工作日内 |
| 初步评估（严重程度、是否在范围内） | 7 个工作日内 |
| 已确认问题的修复或缓解方案 | 30 天内，高危更快 |

这些目标来自单人维护的项目，不构成合约性质的 SLA。如果某个目标要延期，会主动告诉你，而不是让你干等。

除非你要求匿名，否则会在安全公告里署名致谢。

## 范围

在范围内 —— 本项目与安全相关的部分：

- **mod**（`src/mod/`）：它运行在游戏的渲染进程里，向本机 bridge 开 WebSocket。
- **bridge**（`src/bridge/`）：只绑定 `127.0.0.1`，暴露的 RPC 可以读写存档，也能读写磁盘文件（快照、蓝图）。
- **MCP server**（`src/mcp/`）：把 bridge 暴露成 MCP 客户端可用的工具。
- **GUI**（`gui/`）：一个能执行安装脚本的本机 web server。
- **任何地方的路径处理**：快照名、蓝图名、存档路径都是用户输入，不得逃出各自的目标目录。

不在范围内：

- shapez.io 本体或 Node.js 自身的漏洞 —— 请报给上游。
- 需要攻击者已经能在本机执行代码或访问文件系统才能利用的问题。
- 针对你自己本机进程的拒绝服务。

## 与安全相关的设计说明

- bridge **只绑定 `127.0.0.1`**，并拒绝非本机的浏览器来源。把它绑到公网接口是不受支持的配置。
- 快照名与蓝图名做了目录穿越校验；见 `src/bridge/selftest.mjs` 里以 `SECURITY:` 开头的检查。
- mod、bridge、MCP server 都以本机当前用户的权限运行，与你的 shell 之间没有权限边界 —— 不要拿一个你不愿意被修改的存档去跑它们。
- 本项目不存储任何凭据。LLM 服务商的 API key 从环境变量读取，绝不写盘。