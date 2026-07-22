# Codex Manage 云端部署与桌面发布指南

## 1. 云端准备

准备以下域名并指向部署入口：

| 服务 | 域名 |
| --- | --- |
| Control API | `codex-api.xmwefun.cn` |
| 管理后台 | `codex-admin.xmwefun.cn` |
| 官网与下载页 | `codex.xmwefun.cn` |
| 设备固定域名 | `d-<设备短码>.xmwefun.cn` |

Cloudflare API Token 最少授予：

- Account / Cloudflare Tunnel / Edit
- Zone / DNS / Edit

Token、Account ID 和 Zone ID 只注入 Control API/Worker，不得进入桌面安装包。

## 2. 环境变量

复制 `deploy/.env.example` 为 `deploy/.env`，至少配置：

- 强随机 `POSTGRES_PASSWORD`
- 初始管理员邮箱和强密码
- Cloudflare API Token、Account ID、Zone ID
- 邮件验证码 Webhook
- 可选短信验证码 Webhook

生产环境必须保持：

```text
CONTROL_ALLOW_DEBUG_CODES=false
```

验证码 Webhook 接收 JSON：

```json
{
  "type": "email",
  "identifier": "user@example.com",
  "code": "123456",
  "purpose": "register",
  "expiresAt": "2026-07-21T12:00:00.000Z"
}
```

Webhook 返回任意 2xx 表示发送成功。

## 3. 启动服务

```bash
docker compose --env-file deploy/.env -f deploy/docker-compose.yml pull
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d
```

`migrate` 服务先执行数据库迁移，成功后 Control API 和 Tunnel Worker 才启动。

健康检查：

```bash
curl http://127.0.0.1:4320/health
curl http://127.0.0.1:4321/
```

生产环境应由 Nginx、Caddy、Cloudflare Tunnel 或云负载均衡器终止 HTTPS，再转发到两个 loopback 端口。

## 4. 首次管理员登录

首次启动时通过以下变量创建管理员：

```text
CONTROL_BOOTSTRAP_ADMIN_EMAIL
CONTROL_BOOTSTRAP_ADMIN_PASSWORD
```

数据库已存在同邮箱管理员时不会覆盖密码。首次登录成功后，应从长期部署配置中移除明文初始密码，并改用 Secret Manager 注入。

## 5. Named Tunnel 验收

1. 注册测试用户和设备。
2. 在管理后台人工开通正式权益。
3. 桌面端申请固定域名。
4. 观察 Worker 完成 Tunnel、ingress 和 CNAME。
5. 确认设备获得 `d-<设备短码>.xmwefun.cn`。
6. 修改本地端口，确认 Worker 重新更新 ingress。
7. 停用设备，确认设备 Token、DNS 和 Tunnel 被撤销。
8. 重复撤销操作，确认 Cloudflare 404 被幂等处理。

## 6. 桌面发布

发布流水线需要 Secret：

- `CLOUDFLARED_MANIFEST_JSON`
- macOS：`CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`
- Windows：`WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`

`CLOUDFLARED_MANIFEST_JSON` 必须包含固定版本和三个官方归档 SHA-256。流水线会先校验 cloudflared，再构建 macOS x64、macOS arm64 和 Windows x64 安装包，最后生成 `SHA256SUMS.txt`。

本地内部测试包示例：

```bash
PATH="$PWD/node_modules/.bin:$PATH" npm run build:desktop
PATH="$PWD/node_modules/.bin:$PATH" \
ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/' \
ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/' \
./node_modules/.bin/electron-builder --projectDir apps/desktop --config electron-builder.yml --mac dmg --x64
```

未签名包只能用于内部测试，不应放到公开下载页。

## 7. 上线门禁

- PostgreSQL 迁移、备份和恢复演练通过。
- Cloudflare 创建、重试、撤销和对账演练通过。
- 邮件/短信限流和供应商故障演练通过。
- 三个平台安装、覆盖升级和卸载通过。
- macOS 签名、公证和 Windows 签名通过。
- 安装包 Secret 扫描通过。
- Quick Tunnel 页面保持“体验通道、无 SLA”提示。
