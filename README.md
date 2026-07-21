# Codex Manage

Codex Manage 是一个本地优先的 Codex 会话管理与远程访问产品。仓库同时包含：

- 原有 React + Fastify Codex Manage Web/H5。
- macOS、Windows Electron 桌面客户端。
- 内置 cloudflared 的 Quick Tunnel 与 Named Tunnel 管理。
- 用户、设备、域名、权益和订单控制 API。
- 运营管理后台。

Codex 会话、命令、审批、项目文件和 Codex 凭证只保存在用户电脑；云端只保存账号、设备、Tunnel、域名和商业化元数据。

## 目录

```text
src/                 本地 Codex Manage Web 与 Fastify 服务
apps/desktop/        Electron 桌面客户端
apps/control-api/    云端控制 API、迁移与 Tunnel Worker
apps/admin-web/      运营管理后台
deploy/              Docker Compose 部署拓扑
resources/           cloudflared 发布资源说明
tooling/             cloudflared 下载校验与发布校验和工具
docs/desktop-cloud-platform/ 需求、架构、计划与验收文档
```

## 本地开发

要求 Node.js 22.5+ 和 npm 10+。本仓库固定使用 npm 11.6.2；如果系统 npm 异常，请优先使用项目内 npm：

```bash
PATH="$PWD/node_modules/.bin:$PATH" npm ci
PATH="$PWD/node_modules/.bin:$PATH" npm run dev
```

常用验证命令：

```bash
PATH="$PWD/node_modules/.bin:$PATH" npm run typecheck:all
./node_modules/.bin/vitest run
PATH="$PWD/node_modules/.bin:$PATH" npm run build:all
PATH="$PWD/node_modules/.bin:$PATH" npm run test:desktop:e2e
```

Web E2E 在 macOS 上可以使用本机 Chrome：

```bash
PATH="$PWD/node_modules/.bin:$PATH" \
CODEX_E2E_CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
npm run test:e2e
```

## 桌面客户端

开发模式可以通过环境变量指定 cloudflared：

```bash
CODEX_CLOUDFLARED_PATH=/usr/local/bin/cloudflared \
PATH="$PWD/node_modules/.bin:$PATH" \
npm run desktop:dev
```

正式构建前必须创建 `resources/cloudflared/manifest.json`，固定 cloudflared 版本并填写三个官方发布归档的 SHA-256，然后执行：

```bash
PATH="$PWD/node_modules/.bin:$PATH" npm run cloudflared:fetch
PATH="$PWD/node_modules/.bin:$PATH" npm run dist:desktop
```

目标平台：macOS arm64、macOS x64、Windows x64。公开发布还必须配置 Apple Developer ID、公证凭证和 Windows 代码签名证书。

## 云端控制面

复制并填写部署环境变量：

```bash
cp deploy/.env.example deploy/.env
docker compose --env-file deploy/.env -f deploy/docker-compose.yml up --build -d
```

主要服务：

- Control API：本机映射 `127.0.0.1:4320`，生产域名建议为 `codex-api.xmwefun.cn`。
- Admin Web：本机映射 `127.0.0.1:4321`，生产域名建议为 `codex-admin.xmwefun.cn`。
- PostgreSQL：保存账号、设备、Tunnel、域名、套餐、订阅、订单、支付占位和审计日志。
- Tunnel Worker：调用 Cloudflare API 创建、更新和撤销 Named Tunnel 与 DNS。

Cloudflare API Token 至少需要 Account Cloudflare Tunnel Edit 和 Zone DNS Edit 权限。验证码通过邮件、短信 Webhook 适配器发送；生产环境禁止开启 `CONTROL_ALLOW_DEBUG_CODES`。

更完整的部署步骤见 [部署与发布指南](docs/desktop-cloud-platform/deployment-guide.md)。

## 当前交付状态

代码层面的 P1-P8 已落地并通过测试。macOS x64 未签名测试 DMG 已生成；macOS arm64、Windows x64、真实 Cloudflare、原生 PostgreSQL 部署、签名和公证仍需在对应外部环境完成最终验收。

详见：

- [实施状态](docs/desktop-cloud-platform/implementation-status.md)
- [验收报告](docs/desktop-cloud-platform/acceptance-report.md)
- [需求文档](docs/desktop-cloud-platform/requirements.md)
- [总体架构](docs/desktop-cloud-platform/architecture.md)
- [实施计划](docs/desktop-cloud-platform/implementation-plan.md)
