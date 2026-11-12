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
