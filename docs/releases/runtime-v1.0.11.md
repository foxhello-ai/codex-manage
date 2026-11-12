# Codex Manage Runtime v1.0.11

设置和诊断 → Web 服务增加“当前版本”，用于确认安装升级是否成功。

## 变更

- 安装版读取正在运行包内的 build-info.txt，显示实际 Runtime 版本，例如 v1.0.11。
- 源码启动显示提交号；存在代码修改时注明“本地修改”。缺少可信版本记录时显示“未知版本”。
- 版本按进程启动时读取，旧服务不会因升级替换了文件而误报新版。无需更改官方桌面启动方式。
- Linux 与 macOS 安装检查新增运行版本核对，覆盖安装、升级、还原与服务重启。

根 package.json 的 1.0.0 是项目包信息，不作为 Runtime 发布版本。

## 验证与发布

相关 5 项测试、类型检查、生产构建以及桌面/375px 设置页检查已通过；[功能验收报告](../acceptance/2026-11-12-settings-version/report.html) 含截图。发布流水线会运行完整测试和 Linux 安装验收，正式发布后复验 Linux、Intel macOS 与 Apple ARM macOS。本页的最终发布记录将补充源码、SHA-256 和实际流水线结果。

## 升级

macOS 使用当前桌面用户，不要 sudo，不要 --user deploy：

```bash
curl -fsSL https://github.com/foxhello-ai/codex-manage/releases/download/v1.0.11/install-runtime.sh \
  | bash -s -- --version 1.0.11
```

Linux 使用实际会话所属用户：

```bash
curl -fsSL https://github.com/foxhello-ai/codex-manage/releases/download/v1.0.11/install-runtime.sh \
  | sudo bash -s -- --user <实际运行用户> --version 1.0.11
```

安装器保留已有配置和数据。升级后打开设置和诊断，“当前版本”应为 v1.0.11。v1.0.10 可用于回滚。

## 正式发布结果

已于 2026-11-12T06:39:00Z 正式发布。源码 `2315e46b7a08834eb22f571737662c7cec814e03`。版本 tag 与 release 分支均冻结于此提交。

[发布流水线](https://github.com/foxhello-ai/codex-manage/actions/runs/43169476570) 的 192 项测试、构建、Linux 8 项安装检查和正式下载复核均通过。[发布后矩阵](https://github.com/foxhello-ai/codex-manage/actions/runs/43169841959) 对 Linux、Intel Mac、Apple ARM Mac 均通过；本机 Intel Mac 10 项 launchd 检查也通过。正式包设置页显示 v1.0.11，1440px 与 375px 验证通过。

SHA-256：`1f4d2b5bfe0e11badc8012049ce89948010c62e368bb28e6a6b5906a0154c650`。[完整证据](../acceptance/2026-11-12-runtime-v1.0.11/README.md)。用户现有生产安装未自动升级。
