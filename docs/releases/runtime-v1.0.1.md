# Linux Runtime v1.0.1 发布记录

## 身份与证据

- 发布线：Linux Runtime。
- 原始 Git tag：`v1.0.1`，解析到提交 `7ee315b`（2026-08-03）。
- 规范历史基线 tag：`runtime/v1.0.1`，同样指向 `7ee315b`；该 annotated tag 于 2026-08-08 补录，仅固定 Runtime 源码参考点。
- 版本来源：`.github/workflows/build-runtime-package.yml` 的手动 workflow 输入与生成的 `build-info.txt`；根 `package.json` 仍为 `1.0.0`，因此不得用该文件单独判断 Runtime 发布版本。
- 当前证据等级：冻结基线。仓库内没有对应 GitHub Release 资产、构建 run URL 或 SHA-256 副本可供离线复核。

## 包含内容

- GitHub Actions 构建 Linux 单体运行包并在手动执行时创建 GitHub Release。
- `scripts/install-runtime.sh`：下载或离线安装运行包、校验 SHA-256、生成 systemd 服务、保留用户 Codex 会话所有权。
- 支持从 Actions Artifact ZIP 离线安装，并默认使用当前 Codex 用户。
- 运行包移除 sourcemap，保留 `build-info.txt` 记录构建提交和来源。

## 验证与缺口

后续补证时必须确认：GitHub Release 是否存在、`codex-manage-runtime.tgz` 与 `.sha256`、`build-info.txt` 中的 source commit、Linux systemd 启停/升级/回滚记录。未补齐前不可表述为“已验证对外发布”。
