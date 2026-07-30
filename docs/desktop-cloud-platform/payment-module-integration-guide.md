# 通用支付模块对接指南

## 1. 文档目的

本文用于约束“通用支付模块”的对接方式，目标是后续其他项目集成时只阅读本文即可完成接入，不需要重新阅读 Codex Manage 当前业务代码。

本文定义：

- 支付模块职责边界。
- 宿主项目必须实现的适配接口。
- 对外 HTTP API 规范。
- 支付回调、幂等、状态机和错误码。
- 数据表命名和迁移约定。
- 微信支付、支付宝配置要求。
- 桌面端、Web 前端、后台管理端接入方式。

## 2. 总体原则

### 2.1 支付模块只负责通用支付能力

通用支付模块负责：

- 套餐价格快照读取。
- 订单创建。
- 支付参数生成。
- 微信支付和支付宝适配。
- 支付回调验签。
- 支付状态机。
- 回调幂等。
- 订单关闭。
- 退款预留记录。
- 支付流水和回调日志。

### 2.2 业务权益由宿主项目负责

通用支付模块不直接理解任何宿主业务权益。

例如 Codex Manage 中的以下内容不能写入通用支付模块：

- `tunnel.quick`
- `tunnel.named`
- `device.max_count`
- Named Tunnel 开通逻辑
- 设备数量限制逻辑

支付成功后，通用支付模块只触发宿主项目实现的 `PaymentFulfillmentPort`。宿主项目自己决定如何开通订阅、发放权益、顺延有效期、写审计日志。

### 2.3 外部接口兼容和内部表名解耦

Codex Manage 可以继续保留现有外部接口：

- `GET /v1/plans`
- `POST /v1/orders`
- `GET /v1/orders`
- `POST /v1/orders/:orderId/pay`
- `POST /v1/payments/:provider/callback`

但通用模块内部建议使用 `billing_` 前缀表名，避免其他项目集成时与已有 `orders`、`payments`、`plans` 表冲突。

## 3. 推荐包结构

首版建议在当前仓库通过 workspace 建包，暂不发布 npm。

```text
packages/
  payment-core/
    src/
      domain.ts
      errors.ts
      ports.ts
      stateMachine.ts
      idempotency.ts
  payment-service/
    src/
      PaymentService.ts
      ProviderRegistry.ts
  payment-pg/
    src/
      BillingPgRepository.ts
      migrations/
  payment-fastify/
    src/
      registerBillingRoutes.ts
  payment-provider-wechat/
    src/
      WechatPayProvider.ts
  payment-provider-alipay/
    src/
      AlipayProvider.ts
```

### 3.1 包职责

| 包 | 职责 | 是否依赖宿主业务 |
| --- | --- | --- |
| `payment-core` | 类型、状态机、错误码、端口定义 | 否 |
| `payment-service` | 支付用例编排、幂等、订单状态流转 | 否 |
| `payment-pg` | PostgreSQL Repository 和迁移脚本 | 否 |
| `payment-fastify` | Fastify 路由封装和 raw body 处理 | 否 |
| `payment-provider-wechat` | 微信支付下单、验签、回调解析 | 否 |
| `payment-provider-alipay` | 支付宝下单、验签、回调解析 | 否 |
| 宿主项目 | 用户认证、套餐目录、权益发放、审计 | 是 |

## 4. 宿主项目接入点

宿主项目必须实现以下端口。

### 4.1 用户上下文端口

```ts
export interface BillingAuthPort {
  authenticateUser(token: string | null): Promise<{
    userId: string;
    subjectType: "user";
  }>;

  authenticateAdmin(token: string | null, requireWrite?: boolean): Promise<{
    adminId: string;
    role: string;
  }>;
}
```

要求：

- 支付模块不直接解析宿主项目 token。
- 用户订单接口必须校验订单归属。
- 后台退款预留接口必须校验管理员写权限。

### 4.2 套餐目录端口

```ts
export interface BillingPlanCatalogPort {
  listPurchasablePlans(): Promise<BillingPlan[]>;
  getPurchasablePlan(input: { planId?: string; planCode?: string }): Promise<BillingPlan | null>;
}

export type BillingPlan = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: "CNY";
  billingPeriod: "month" | "year" | "custom" | "lifetime";
  durationDays: number | null;
  purchaseEnabled: boolean;
  features: Record<string, unknown>;
};
```

要求：

- 金额、币种、有效期以服务端套餐目录为准。
- 客户端不得传入最终金额。
- 套餐改价后，历史订单仍使用订单创建时的金额快照。

### 4.3 支付成功履约端口

```ts
export interface PaymentFulfillmentPort {
  fulfillPaidOrder(input: PaidOrderFulfillmentInput): Promise<PaidOrderFulfillmentResult>;
}

export type PaidOrderFulfillmentInput = {
  fulfillmentId: string;
  userId: string;
  orderId: string;
  orderNo: string;
  plan: BillingPlanSnapshot;
  paidAt: string;
  amountCents: number;
  currency: "CNY";
  provider: "wechat" | "alipay";
  providerTransactionId: string;
};

export type PaidOrderFulfillmentResult = {
  fulfilled: true;
  businessObjectType: "subscription" | string;
  businessObjectId: string;
  startsAt: string;
  expiresAt: string | null;
  summary: Record<string, unknown>;
};
```

要求：

- `fulfillmentId` 必须作为业务开通幂等键。
- 同一笔订单重复回调时，宿主项目必须返回同一个履约结果或识别为已履约。
- Codex Manage 的免费覆盖、正式顺延逻辑在这里实现，不进入支付通用包。

### 4.4 审计端口

```ts
export interface BillingAuditPort {
  recordBillingAudit(input: {
    actorType: "system" | "user" | "admin" | "provider";
    actorId: string | null;
    action: string;
    targetType: string;
    targetId: string;
    summary: Record<string, unknown>;
  }): Promise<void>;
}
```

要求：

- 创建订单、支付成功、回调异常、退款预留必须可审计。
- 审计内容必须脱敏。

## 5. 对外 HTTP API

### 5.1 API 前缀

通用模块默认推荐前缀：

```text
/v1/billing
```

Codex Manage 兼容映射：

| 通用接口 | Codex Manage 兼容接口 |
| --- | --- |
| `GET /v1/billing/plans` | `GET /v1/plans` |
| `POST /v1/billing/orders` | `POST /v1/orders` |
| `GET /v1/billing/orders` | `GET /v1/orders` |
| `GET /v1/billing/orders/:orderId` | `GET /v1/orders/:orderId` |
| `POST /v1/billing/orders/:orderId/pay` | `POST /v1/orders/:orderId/pay` |
| `POST /v1/billing/orders/:orderId/close` | `POST /v1/orders/:orderId/close` |
| `POST /v1/billing/payments/:provider/callback` | `POST /v1/payments/:provider/callback` |

其他项目集成时建议直接使用 `/v1/billing` 前缀。

### 5.2 统一错误响应

```json
{
  "error": {
    "code": "ORDER_NOT_FOUND",
    "message": "订单不存在",
    "details": {}
  }
}
```

### 5.3 获取可购买套餐

```http
GET /v1/billing/plans
```

认证：可选。需要展示用户定向套餐时可启用用户认证。

响应：

```json
{
  "plans": [
    {
      "id": "plan-formal-year",
      "code": "formal_year",
      "name": "正式版年付",
      "description": "固定域名和更多设备额度",
      "price_cents": 19900,
      "currency": "CNY",
      "billing_period": "year",
      "duration_days": 365,
      "purchase_enabled": true,
      "features": {
        "device.max_count": 5,
        "tunnel.named": true
      }
    }
  ]
}
```

### 5.4 创建订单

```http
POST /v1/billing/orders
Authorization: Bearer <user-token>
Content-Type: application/json
```

请求：

```json
{
  "planCode": "formal_year",
  "channel": "wechat",
  "clientType": "desktop",
  "returnUrl": "codex-manage://billing/result"
}
```

响应：

```json
{
  "order": {
    "id": "ord_01J...",
    "order_no": "CM202607290001",
    "plan_id": "plan-formal-year",
    "plan_code": "formal_year",
    "plan_name": "正式版年付",
    "amount_cents": 19900,
    "currency": "CNY",
    "status": "pending",
    "expires_at": "2026-07-29T12:15:00.000Z",
    "created_at": "2026-07-29T12:00:00.000Z"
  }
}
```

要求：

- `amount_cents` 由服务端套餐快照生成。
- `order_no` 全局唯一。
- 同一用户同一套餐短时间重复创建时，可以返回现有未过期待支付订单。

### 5.5 获取支付参数

```http
POST /v1/billing/orders/:orderId/pay
Authorization: Bearer <user-token>
Content-Type: application/json
```

请求：

```json
{
  "channel": "wechat"
}
```

响应：

```json
{
  "order": {
    "id": "ord_01J...",
    "order_no": "CM202607290001",
    "status": "paying",
    "expires_at": "2026-07-29T12:15:00.000Z"
  },
  "payment": {
    "id": "pay_01J...",
    "provider": "wechat",
    "channel": "native_qr",
    "status": "pending",
    "qr_code_url": "weixin://wxpay/bizpayurl?...",
    "expires_at": "2026-07-29T12:15:00.000Z"
  }
}
```

要求：

- 支付二维码必须有过期时间。
- 重复调用未过期支付参数时必须幂等。
- 已支付订单再次调用必须返回 `ORDER_ALREADY_PAID`。

### 5.6 查询订单列表

```http
GET /v1/billing/orders
Authorization: Bearer <user-token>
```

查询参数：

- `status`：可选。
- `limit`：默认 `20`，最大 `100`。
- `cursor`：可选。

响应：

```json
{
  "orders": [],
  "nextCursor": null
}
```

### 5.7 查询单个订单

```http
GET /v1/billing/orders/:orderId
Authorization: Bearer <user-token>
```

响应：

```json
{
  "order": {
    "id": "ord_01J...",
    "order_no": "CM202607290001",
    "status": "paid",
    "paid_at": "2026-07-29T12:03:00.000Z"
  },
  "payment": {
    "id": "pay_01J...",
    "provider": "wechat",
    "status": "succeeded",
    "provider_transaction_id": "420000..."
  },
  "fulfillment": {
    "fulfilled": true,
    "business_object_type": "subscription",
    "business_object_id": "sub_01J...",
    "expires_at": "2027-07-29T12:03:00.000Z"
  }
}
```

### 5.8 关闭订单

```http
POST /v1/billing/orders/:orderId/close
Authorization: Bearer <user-token>
```

响应：

```json
{
  "closed": true
}
```

要求：

- 只能关闭 `pending` 或 `paying` 订单。
- 已支付订单不能关闭。

### 5.9 支付回调

```http
POST /v1/billing/payments/:provider/callback
Content-Type: application/json
```

路径参数：

- `provider`：`wechat` 或 `alipay`。

要求：

- 不使用用户登录态。
- 必须使用支付平台签名认证。
- 必须读取原始请求体进行验签。
- 处理成功后按支付平台要求返回确认响应。

通用模块内部解析回调后统一产出：

```ts
export type VerifiedPaymentCallback = {
  provider: "wechat" | "alipay";
  orderNo: string;
  providerTransactionId: string;
  amountCents: number;
  currency: "CNY";
  paidAt: string;
  tradeState: "SUCCESS" | "FAILED" | "CLOSED";
  rawPayloadRedacted: Record<string, unknown>;
};
```

## 6. 状态机

### 6.1 订单状态

| 状态 | 含义 | 可流转到 |
| --- | --- | --- |
| `pending` | 已创建，未生成或未确认支付参数 | `paying`、`closed` |
| `paying` | 已生成支付参数，等待平台结果 | `paid`、`failed`、`closed` |
| `paid` | 支付成功 | `refunding` |
| `closed` | 用户关闭或超时关闭 | 终态 |
| `failed` | 支付失败且不可继续支付 | 终态 |
| `refunding` | 退款处理中，首版预留 | `refunded`、`paid` |
| `refunded` | 已退款，首版预留 | 终态 |

### 6.2 支付状态

| 状态 | 含义 |
| --- | --- |
| `created` | 支付记录已创建 |
| `pending` | 等待用户支付 |
| `succeeded` | 支付成功 |
| `failed` | 支付失败 |
| `closed` | 支付关闭或二维码过期 |
| `refund_pending` | 退款处理中，首版预留 |
| `refunded` | 已退款，首版预留 |

## 7. 幂等要求

### 7.1 订单幂等

推荐幂等键：

```text
user_id + plan_id + channel + pending_window
```

同一用户短时间重复购买同一套餐时，可以返回现有未过期订单，避免产生多个二维码。

### 7.2 支付回调幂等

推荐唯一约束：

```text
provider + provider_transaction_id
```

如果支付平台重复通知：

- 已成功处理过：直接返回成功确认。
- 处理中：通过行锁或事务等待处理完成。
- 上次处理失败：允许按 `callback_log_id` 重试，但不能重复发放业务权益。

### 7.3 履约幂等

推荐唯一约束：

```text
fulfillment_id = order_id
```

宿主项目必须保证同一 `fulfillmentId` 只开通一次业务权益。

## 8. 数据表规范

### 8.1 表名前缀

通用模块内部表必须使用 `billing_` 前缀。

推荐表：

- `billing_plans`
- `billing_plan_entitlements`
- `billing_orders`
- `billing_payments`
- `billing_payment_callback_logs`
- `billing_refund_requests`
- `billing_fulfillment_events`

### 8.2 `billing_plans`

核心字段：

- `id`
- `code`
- `name`
- `description`
- `price_cents`
- `currency`
- `billing_period`
- `duration_days`
- `purchase_enabled`
- `features`
- `status`
- `sort_order`
- `created_at`
- `updated_at`

### 8.3 `billing_orders`

核心字段：

- `id`
- `order_no`
- `user_id`
- `plan_id`
- `plan_snapshot`
- `amount_cents`
- `currency`
- `channel`
- `client_type`
- `status`
- `expires_at`
- `paid_at`
- `closed_at`
- `metadata`
- `created_at`
- `updated_at`

要求：

- `order_no` 唯一。
- `plan_snapshot` 保存订单创建时的套餐快照。

### 8.4 `billing_payments`

核心字段：

- `id`
- `order_id`
- `provider`
- `channel`
- `provider_order_no`
- `provider_transaction_id`
- `amount_cents`
- `currency`
- `status`
- `qr_code_url`
- `expires_at`
- `paid_at`
- `failure_code`
- `failure_message`
- `created_at`
- `updated_at`

要求：

- `provider + provider_transaction_id` 在非空时唯一。
- `qr_code_url` 可以加密保存或按过期时间清理。

### 8.5 `billing_payment_callback_logs`

核心字段：

- `id`
- `provider`
- `order_no`
- `payment_id`
- `provider_transaction_id`
- `signature_valid`
- `processing_status`
- `error_code`
- `raw_payload_redacted`
- `received_at`

要求：

- 原始回调日志必须脱敏。
- 不保存支付密钥、完整证件号、完整手机号等敏感信息。

### 8.6 `billing_refund_requests`

首版只做预留。

核心字段：

- `id`
- `order_id`
- `payment_id`
- `requested_by_admin_id`
- `amount_cents`
- `reason`
- `status`
- `provider_refund_id`
- `created_at`
- `updated_at`

### 8.7 `billing_fulfillment_events`

用于记录支付成功后的业务履约结果。

核心字段：

- `id`
- `fulfillment_id`
- `order_id`
- `user_id`
- `status`
- `business_object_type`
- `business_object_id`
- `summary`
- `created_at`
- `updated_at`

## 9. 支付服务初始化

示例：

```ts
import { PaymentService } from "@codex-manage/payment-service";
import { BillingPgRepository } from "@codex-manage/payment-pg";
import { WechatPayProvider } from "@codex-manage/payment-provider-wechat";
import { AlipayProvider } from "@codex-manage/payment-provider-alipay";

const billingRepository = new BillingPgRepository({ pool });

const paymentService = new PaymentService({
  repository: billingRepository,
  authPort,
  planCatalogPort,
  fulfillmentPort,
  auditPort,
  providers: [
    new WechatPayProvider(wechatConfig),
    new AlipayProvider(alipayConfig)
  ],
  orderExpiresInSeconds: 15 * 60
});
```

Fastify 路由注册示例：

```ts
import { registerBillingRoutes } from "@codex-manage/payment-fastify";

await registerBillingRoutes(app, {
  prefix: "/v1/billing",
  paymentService
});
```

Codex Manage 如需保留旧路径，可以额外注册兼容映射。

## 10. 支付渠道配置

### 10.1 微信支付

服务端配置项：

- `WECHAT_PAY_ENABLED`
- `WECHAT_PAY_APP_ID`
- `WECHAT_PAY_MCH_ID`
- `WECHAT_PAY_API_V3_KEY`
- `WECHAT_PAY_PRIVATE_KEY`
- `WECHAT_PAY_CERT_SERIAL_NO`
- `WECHAT_PAY_NOTIFY_URL`

要求：

- 私钥和 API Key 不得提交仓库。
- 回调地址必须为公网 HTTPS。
- 测试环境和生产环境必须隔离。

### 10.2 支付宝

服务端配置项：

- `ALIPAY_ENABLED`
- `ALIPAY_APP_ID`
- `ALIPAY_PRIVATE_KEY`
- `ALIPAY_PUBLIC_KEY`
- `ALIPAY_GATEWAY_URL`
- `ALIPAY_NOTIFY_URL`

要求：

- 沙箱网关和生产网关必须明确区分。
- 验签必须使用支付宝公钥。

## 11. 桌面端接入

桌面端只调用后端 API，不直接接触支付密钥。

### 11.1 页面能力

需要实现：

- 请求套餐列表。
- 创建订单。
- 获取支付二维码。
- 弹窗展示二维码和倒计时。
- 轮询订单状态。
- 支付成功后刷新订阅和权益。
- 订单超时后允许重新发起支付。

### 11.2 客户端轮询建议

- 轮询间隔：`2s`。
- 最大轮询到订单 `expires_at`。
- 页面关闭后停止轮询。
- 应用重启后通过当前订阅接口恢复状态。

### 11.3 支付成功后的动作

Codex Manage 桌面端需要调用：

- `GET /v1/subscriptions/current`
- `GET /v1/entitlements`
- 必要时刷新 Named Tunnel 状态。

其他项目接入时调用自己的业务状态刷新接口。

## 12. 管理后台接入

后台需要集成：

- 套餐配置。
- 订单列表。
- 订单详情。
- 支付流水。
- 回调日志。
- 退款预留。
- 审计日志。

后台退款首版仅记录处理意向，不自动调用支付平台退款。

## 13. Codex Manage 履约规则

Codex Manage 的 `PaymentFulfillmentPort` 必须实现以下规则：

- 免费用户购买正式套餐：从支付成功时间开通正式套餐。
- 已有正式套餐且未过期：从当前有效到期时间顺延。
- 已有正式套餐但已过期：从支付成功时间重新计算。
- 长期有效正式权益：默认不缩短，不覆盖成短期权益。
- 人工开通和支付开通都通过统一订阅权益服务处理。

## 14. 错误码

| 错误码 | 含义 | HTTP 状态 |
| --- | --- | --- |
| `PAYMENT_PROVIDER_NOT_CONFIGURED` | 支付渠道未配置 | 503 |
| `PLAN_NOT_PURCHASABLE` | 套餐不可购买 | 400 |
| `ORDER_NOT_FOUND` | 订单不存在 | 404 |
| `ORDER_FORBIDDEN` | 订单不属于当前用户 | 403 |
| `ORDER_EXPIRED` | 订单已过期 | 409 |
| `ORDER_ALREADY_PAID` | 订单已支付 | 409 |
| `ORDER_NOT_PAYABLE` | 当前订单状态不可支付 | 409 |
| `PAYMENT_SIGNATURE_INVALID` | 支付回调验签失败 | 400 |
| `PAYMENT_AMOUNT_MISMATCH` | 回调金额不一致 | 409 |
| `PAYMENT_CALLBACK_DUPLICATED` | 回调已处理 | 200 |
| `PAYMENT_FULFILLMENT_FAILED` | 支付成功但业务履约失败 | 500 |

## 15. 测试要求

### 15.1 通用模块测试

- 创建订单使用服务端套餐价格。
- 重复创建订单幂等。
- 订单超时后不能支付。
- 支付二维码重复获取幂等。
- 回调验签失败拒绝处理。
- 金额不一致拒绝履约。
- 重复回调不重复履约。
- 缺少渠道配置时返回明确错误。

### 15.2 宿主项目集成测试

- 支付成功后业务权益正确开通。
- 正式套餐续费顺延。
- 人工权益不会被支付权益缩短。
- 老客户端仍能读取订阅和权益。
- 后台能查看订单、支付、回调和退款预留记录。

## 16. 接入检查清单

其他项目接入前必须完成：

- 已实现 `BillingAuthPort`。
- 已实现 `BillingPlanCatalogPort`。
- 已实现 `PaymentFulfillmentPort`。
- 已实现 `BillingAuditPort`。
- 已执行 `billing_` 表迁移。
- 已配置微信支付参数。
- 已配置支付宝参数。
- 已配置公网 HTTPS 回调地址。
- 已验证 raw body 验签。
- 已配置订单过期时间。
- 已接入订单状态轮询。
- 已完成重复回调测试。
- 已完成金额篡改测试。

## 17. 不允许的集成方式

- 不允许前端直接调用微信或支付宝密钥接口。
- 不允许客户端传入最终支付金额。
- 不允许支付模块直接写宿主项目业务权益表。
- 不允许跳过支付平台验签。
- 不允许人工把未支付订单改成已支付。
- 不允许保存未脱敏的完整支付回调敏感数据。

