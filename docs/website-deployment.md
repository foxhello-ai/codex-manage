# 官网部署说明（内部）

官网文件位于 `website/`，与 Codex Manage Runtime 分开发布。官网为零依赖静态页面，公开页面不展示代码仓库地址、内部路径或官网托管商信息。

## 静态官网部署

将 `website/` 作为静态站点根目录发布：

- 根目录：`website`
- 构建命令：留空，或使用 `exit 0`
- 输出目录：`.`

也可以使用 Cloudflare Pages 的 Direct Upload，将整个 `website/` 目录作为上传目录。该托管配置仅用于官网，不承载 Codex Manage Runtime。

### GitHub Actions 自动发布

`.github/workflows/build-runtime-package.yml` 只监听符合 `release/vX.Y.Z` 的分支。例如推送 `release/v1.0.7` 后，workflow 会：

1. 校验版本分支格式并检查官网入口文件。
2. 构建 Runtime 生产包，并将 `codex-manage-runtime.tgz` 及其 SHA-256 校验文件上传到 GitHub Release `v1.0.7`。
3. 使用 Cloudflare Pages Direct Upload 部署 `website/` 官网。

仓库需要配置以下 GitHub Actions Secrets：

- `CLOUDFLARE_API_TOKEN`：具有目标 Pages 项目部署权限的 API Token。
- `CLOUDFLARE_ACCOUNT_ID`：Cloudflare 账户 ID。
- `CLOUDFLARE_PAGES_PROJECT`：Cloudflare Pages 项目名。

同一个版本的 Release 已存在时，workflow 会停止并不会覆盖已有发布物。官网和 Runtime 使用同一个版本号和同一次提交，便于回溯。

## Codex Manage Runtime 部署

当前 `main` 安装器按系统选择服务管理方式：Linux 使用 root/sudo 和 systemd；macOS 使用当前登录用户的 launchd LaunchAgent，不使用 sudo。macOS 命令和服务路径见 [README 的 macOS 安装说明](../README.md#macos-安装macbook-air--pro)。`v1.0.9` Release 附带的旧安装器仍仅支持 Linux，macOS 需要从 `main` 获取更新后的安装器。

Windows 当前可以作为浏览器访问端连接已部署的 Runtime；Windows 本机服务安装仍未实现。Web Runtime 与 `.app`/Windows 桌面安装物属于不同的发布形态。官网继续以已发布版本的验收范围为准，不能把 `main` 安装器的新支持范围推定为旧 Release 资产已更新。

```bash
codex login
sudo bash ./scripts/install-runtime.sh \
  --user <codex-user> \
  --package ./codex-manage-runtime.tgz
```

生产环境需要设置 `CODEX_WEB_PASSWORD`，并在反向代理、防火墙和访问控制层限制管理台暴露范围。
