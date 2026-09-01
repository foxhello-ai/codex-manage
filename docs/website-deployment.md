# 官网部署说明（内部）

官网文件位于 `website/`，与 Codex Manage Runtime 分开发布。官网为零依赖静态页面，公开页面不展示代码仓库地址、内部路径或官网托管商信息。

## 静态官网部署

将 `website/` 作为静态站点根目录发布：

- 根目录：`website`
- 构建命令：留空，或使用 `exit 0`
- 输出目录：`.`

也可以使用 Cloudflare Pages 的 Direct Upload，将整个 `website/` 目录作为上传目录。该托管配置仅用于官网，不承载 Codex Manage Runtime。

## Codex Manage Runtime 部署

当前主线的 Runtime 一条命令安装只支持 Linux：安装脚本依赖 Bash、root/sudo、systemd、Node.js 和已登录 Codex 的 Linux 用户。

Windows/macOS 当前可以作为浏览器访问端连接 Linux Runtime；桌面安装物属于独立发布线，当前工作区没有统一的三平台一键安装入口。要补齐 Windows、macOS、Linux 一条命令部署，需要分别实现 Windows Service、launchd、systemd 的服务安装、签名、升级和回滚，并完成三平台实机验收。

```bash
codex login
sudo bash ./scripts/install-runtime.sh \
  --user <codex-user> \
  --package ./codex-manage-runtime.tgz
```

生产环境需要设置 `CODEX_WEB_PASSWORD`，并在反向代理、防火墙和访问控制层限制管理台暴露范围。

## 反馈渠道配置

官网问题反馈入口在 `website/main.js` 中配置：

- `FEEDBACK_EMAIL`：使用私有邮箱接收反馈
- `FEEDBACK_ENDPOINT`：使用内部 API 接收结构化 JSON

当 `FEEDBACK_ENDPOINT` 有值时，按钮会直接提交结构化反馈；当 `FEEDBACK_EMAIL` 有值时，会打开预填好的客服邮件。

两者都为空时，页面不会自动上传反馈，但仍可以将反馈内容整理成文本、下载并复制，便于通过已有客服渠道转交。官网页面不展示内部接收地址。
