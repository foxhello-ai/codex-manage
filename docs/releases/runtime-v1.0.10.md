# Codex Manage Runtime v1.0.10

本版修复运行中会话打开慢、Web 审批需反复打开，以及桌面途中问题无法在 Web 回答的问题。

## 变更

- 会话首屏与轮询读取最近 20 轮，旧历史按需加载，保留已加载内容与原消息标识。
- 修复 Web 审批的 HTTP/WebSocket 状态对账，支持一次打开、刷新和重连恢复，已解决的请求不会重新出现。
- 支持官方桌面异步问题卡在 Web 展示、选择选项或填写文字，并将答案交回原桌面当前任务。无需修改桌面图标、启动方式、环境变量或后台。
- 增加旧问题检查、主用户鉴权和重复提交保护；发送结果未知时保留记录，禁止自动重发。
- Linux CI 使用 instabox，保留 macOS 安装验证。随包安装器支持 Linux systemd 和 macOS launchd。

## 适用范围

桌面问题同步要求 Manage 后端与官方桌面在同一台电脑、同一用户下运行，桌面保持目标会话打开。浏览器可从其他设备访问 Manage。已实测官方桌面 26.1002.52244、内置 CLI 0.162.0-alpha.2；使用内部本机通信入口，后续桌面升级需复验兼容性。

桌面停止任务、执行模型/权限设置及桌面同步权限审批仍在桌面操作。修复的审批显示问题属于 Manage Web 自身审批。

## 验证与发布

本地 189 项单元/集成测试、14 项手机/桌面交互专项、类型检查及生产构建通过。专用测试问题已完成真实 Web 提交、原桌面同一任务接收、问题清理和刷新不复活验证。完整功能验收见 [HTML 报告](../acceptance/2026-11-12-desktop-interaction-sync/report.html)。

发布流程先验证 Linux 全新安装、升级、回滚、登录、静态资源和 systemd 启停，再发布 Release 并复核下载文件。具体源码、校验和及流水线结果以随包 build-info.txt、SHA-256 和 runtime-installation-verification.json 为准。macOS 发布后安装验收另行记录；安装验证不使用真实账号或调用模型。

## 安装

macOS 使用当前桌面用户执行，**不要 sudo，不要 --user deploy**：

```bash
curl -fsSL https://github.com/foxhello-ai/codex-manage/releases/download/v1.0.10/install-runtime.sh \
  | bash -s -- --version 1.0.10
```

Linux 使用实际会话所属用户：

```bash
curl -fsSL https://github.com/foxhello-ai/codex-manage/releases/download/v1.0.10/install-runtime.sh \
  | sudo bash -s -- --user <实际运行用户> --version 1.0.10
```

GitHub Release：[v1.0.10](https://github.com/foxhello-ai/codex-manage/releases/tag/v1.0.10)。保留 v1.0.9 可用于回滚；安装升级保留既有配置与数据。
