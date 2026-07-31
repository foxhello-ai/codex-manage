# Codex Manage 云端部署与桌面发布指南

## 1. 云端准备

准备以下域名并指向部署入口：

| 服务 | 域名 |
| --- | --- |
| Control API / 桌面配置发现入口 | `codex-api.foxhello.com` |
| 管理后台 | `codex-admin.foxhello.com` |
| 桌面更新入口 | `codex-api.foxhello.com/updates/stable` |
| 设备固定域名 | `d-<设备短码>.foxhello.com` |

Cloudflare API Token 最少授予：

- Account / Cloudflare Tunnel / Edit
- Zone / DNS / Edit

Token、Account ID 和 Zone ID 只注入 Control API/Worker，不得进入桌面安装包。

## 2. 环境变量

复制 `deploy/.env.example` 为 `deploy/.env`，至少配置：

- 强随机 `POSTGRES_PASSWORD`
- 初始管理员邮箱和强密码
- Cloudflare API Token、Account ID
- 首个 Cloudflare Zone ID 可放在 `.env` 作为兜底，后续可在后台“系统配置”中切换
- 邮件验证码 Webhook
- 可选短信验证码 Webhook

生产环境必须保持：

```text
CONTROL_ALLOW_DEBUG_CODES=false
```

域名相关变量作为首次启动兜底配置：

```text
CONTROL_DEVICE_DOMAIN=foxhello.com
CONTROL_PUBLIC_API_BASE_URL=https://codex-api.foxhello.com
CONTROL_DESKTOP_UPDATE_FEED_URL=https://codex-api.foxhello.com/updates/stable
CONTROL_MANAGED_DOMAIN_SUFFIXES=foxhello.com,xmwefun.cn
CONTROL_ADMIN_ORIGIN=https://codex-admin.foxhello.com,https://codex-admin.xmwefun.cn,http://192.168.31.107
CODEX_ADMIN_CONTROL_API_URL=https://codex-api.foxhello.com
```

桌面端会通过 `GET /v1/desktop/config` 拉取 `api_base_url`、`update_feed_url` 和固定设备域名后缀，并缓存到本机。内置兜底配置发现入口为 `https://codex-api.foxhello.com/v1/desktop/config`。已安装了支持该接口版本的客户端，后续正常切换业务根域名时不需要重新打包。

首次启动后，管理后台提供“系统配置”页面，可写入数据库级运行配置：

- 控制 API 地址
- 桌面更新源
- 设备固定域名根域名
- 托管域名后缀列表
- 后台允许访问 Origin
- 桌面配置刷新 TTL
- Cloudflare Zone ID

这些值由 Control API 和 Tunnel Worker 在运行时读取，保存后无需修改 `.env`，也无需重启服务。`.env` 中的域名配置仅在数据库尚未写入系统配置时作为兜底。

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
curl http://127.0.0.1/
curl http://127.0.0.1:8080/updates/stable/latest.yml
```

局域网默认可通过 `http://服务器IP/` 打开管理后台，通过 `http://服务器IP:4320/health` 检查 API。可使用 `ADMIN_WEB_BIND_ADDRESS`、`ADMIN_WEB_PUBLISHED_PORT`、`CONTROL_API_BIND_ADDRESS` 和 `CONTROL_API_PUBLISHED_PORT` 覆盖监听地址及宿主机端口。

桌面自动更新文件由 `download-web` 服务提供，默认监听宿主机 `8080`，静态根目录为仓库同级 `downloads/`。生产环境需将 `codex-api.foxhello.com` 的 `/updates/*` 路由代理到：

```text
http://服务器IP:8080
```

注意：`codex.xmwefun.cn` 已被其他客户使用，不得作为 Codex Manage 桌面更新源。

其中 Electron 更新元数据路径必须存在：

```text
downloads/updates/stable/latest.yml
downloads/updates/stable/latest-mac.yml
```

公网生产环境仍建议由 Nginx、Caddy、Cloudflare Tunnel 或云负载均衡器终止 HTTPS；此时可将两个 `*_BIND_ADDRESS` 设为 `127.0.0.1`，只允许入口代理访问。

## 4. 根域名切换流程

支持桌面运行配置接口和后台系统配置页面的版本发布后，后续根域名切换按以下流程执行：

1. 在新根域名下准备 `codex-api.<新根域名>`、`codex-admin.<新根域名>` 和 `d-<设备短码>.<新根域名>`。
2. 在 Cloudflare 中准备新 Zone，确认 API Token 对新 Zone 具备 DNS Edit 权限。
3. 确认新旧 API 域名都能反向代理到同一套 Control API，灰度期不要提前关闭旧 `codex-api.*`。
4. 登录管理后台，打开“系统配置”，保存：
   - 控制 API 地址：`https://codex-api.<新根域名>`
   - 桌面更新源：`https://codex-api.<新根域名>/updates/stable`
   - 设备固定域名根域名：`<新根域名>`
   - 托管域名后缀：`<旧根域名>,<新根域名>`，灰度期必须同时保留新旧后缀。
   - 后台允许访问 Origin：至少保留当前后台域名，并加入 `https://codex-admin.<新根域名>`。
   - Cloudflare Zone ID：新根域名所在 Zone ID。
5. 保存后立即请求 `https://codex-api.foxhello.com/v1/desktop/config` 和 `https://codex-api.<新根域名>/v1/desktop/config`，确认返回新配置。
6. 灰度验证客户端配置刷新后诊断日志出现 `cloud-config applied`，并确认固定域名白名单包含新后缀。
7. 迁移已有 Named Tunnel。桌面端再次申请固定域名时，服务端会发现旧 `domains.hostname` 与当前设备根域名不一致，并排队撤销旧域名后按新 Zone 重新签发；大批量客户仍建议使用后台或批量脚本分批触发。
8. 观察一到两个版本周期后，再决定是否下线旧 API、旧更新入口和旧固定设备域名。

关键约束：如果旧 bootstrap/update 域名提前下线，尚未升级到支持远程配置的客户端仍无法自动发现新域名，只能重新下载安装包。

## 5. 首次管理员登录

首次启动时通过以下变量创建管理员：

```text
CONTROL_BOOTSTRAP_ADMIN_EMAIL
CONTROL_BOOTSTRAP_ADMIN_PASSWORD
```

数据库已存在同邮箱管理员时不会覆盖密码。首次登录成功后，应从长期部署配置中移除明文初始密码，并改用 Secret Manager 注入。

## 6. Named Tunnel 验收

1. 注册测试用户和设备。
2. 在管理后台人工开通正式权益。
3. 桌面端申请固定域名。
4. 观察 Worker 完成 Tunnel、ingress 和 CNAME。
5. 确认设备获得 `d-<设备短码>.foxhello.com`。
6. 修改本地端口，确认 Worker 重新更新 ingress。
7. 停用设备，确认设备 Token、DNS 和 Tunnel 被撤销。
8. 重复撤销操作，确认 Cloudflare 404 被幂等处理。

## 7. 桌面发布

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

## 8. 上线门禁

- PostgreSQL 迁移、备份和恢复演练通过。
- Cloudflare 创建、重试、撤销和对账演练通过。
- 邮件/短信限流和供应商故障演练通过。
- 三个平台安装、覆盖升级和卸载通过。
- macOS 签名、公证和 Windows 签名通过。
- 安装包 Secret 扫描通过。
- Quick Tunnel 页面保持“体验通道、无 SLA”提示。
