# 支付生产上线准备清单

## 1. 当前结论

不建议现在直接全量部署并开启真实收款。

可以先部署支付代码和数据库迁移，但上线初期必须保持购买关闭，完成微信支付、支付宝商户参数、回调域名和小额真实订单验收后，再在后台打开套餐购买。

上线前控制项：

- `billing_plans.purchase_enabled` 默认保持 `false`。
- 生产环境必须设置 `BILLING_OFFLINE_PAYMENTS=false`，不能使用离线支付 Provider。
- 微信、支付宝密钥只能放在服务器 Secret 或受控配置中，不能提交到 Git，也不能写入桌面端。
- 回调域名必须使用正式 API 域名，当前建议为 `https://codex-api.xmwefun.cn`，不要使用客户站点域名 `https://codex.xmwefun.cn`。
- 退款首版只做后台预留和人工登记，不自动调用渠道退款。

## 2. 你现在需要准备什么

### 2.1 主体和业务材料

- 公司或个体工商户主体信息。
- 营业执照、统一社会信用代码。
- 法人或经办人身份信息，按支付平台后台要求提交。
- 结算银行卡或对公账户信息。
- 业务联系人姓名、手机号、邮箱。
- 产品名称、产品说明、定价说明、售卖权益说明。
- 官网或落地页地址，建议统一使用 `https://codex.xmwefun.cn` 展示产品，用 `https://codex-api.xmwefun.cn` 承载 API 和支付回调。
- HTTPS 证书、域名归属和备案信息，按支付平台审核要求准备。

### 2.2 套餐材料

需要先确定并给出后台可配置项：

| 套餐 | 建议编码 | 周期 | 价格 | 权益 |
| --- | --- | --- | --- | --- |
| 正式版月付 | `formal_month` | 30 天 | 待确认 | 固定域名 Named Tunnel、设备数上限 |
| 正式版年付 | `formal_year` | 365 天 | 待确认 | 固定域名 Named Tunnel、设备数上限 |

后台配置时价格使用分为单位，例如 99 元填写 `9900`。

## 3. 微信支付准备清单

当前代码接入的是微信支付 API v3 直连商户 Native 支付，用于桌面端生成二维码后让用户扫码支付。

需要准备：

- 微信支付商户号 `WECHAT_PAY_MCH_ID`。
- 商户号绑定的 AppID `WECHAT_PAY_APP_ID`。
- 已开通 Native 支付或等价扫码支付产品权限。
- API v3 密钥 `WECHAT_PAY_API_V3_KEY`。
- 商户 API 证书私钥文件，对应 `WECHAT_PAY_PRIVATE_KEY_FILE`。
- 商户 API 证书序列号 `WECHAT_PAY_CERT_SERIAL_NO`。
- 微信支付平台证书文件，对应 `WECHAT_PAY_PLATFORM_CERT_FILE`。
- 支付回调地址 `WECHAT_PAY_NOTIFY_URL`，建议：
  - `https://codex-api.xmwefun.cn/v1/billing/payments/wechat/callback`

当前实现限制：

- 首版按直连商户实现，不支持服务商、子商户、分账、营销券。
- 首版不自动拉取和轮换微信支付平台证书，证书轮换需要运维流程配合。
- 首版不自动发起微信退款，只在后台记录人工退款处理状态。

## 4. 支付宝准备清单

当前代码接入的是支付宝 `alipay.trade.precreate`，用于生成扫码支付二维码。

需要准备：

- 支付宝开放平台应用 AppID `ALIPAY_APP_ID`。
- 已开通当面付或支持 `alipay.trade.precreate` 的支付产品权限。
- 应用 RSA2 私钥文件，对应 `ALIPAY_PRIVATE_KEY_FILE`。
- 支付宝公钥文件，对应 `ALIPAY_PUBLIC_KEY_FILE`，用于异步通知验签。
- 支付宝网关地址 `ALIPAY_GATEWAY_URL`：
  - 生产：`https://openapi.alipay.com/gateway.do`
  - 沙箱：按支付宝沙箱后台提供的网关填写。
- 支付回调地址 `ALIPAY_NOTIFY_URL`，建议：
  - `https://codex-api.xmwefun.cn/v1/billing/payments/alipay/callback`

当前实现限制：

- 首版使用扫码预创建接口，不是电脑网站跳转支付。
- 首版不自动发起支付宝退款，只在后台记录人工退款处理状态。

## 5. 服务端环境变量

生产建议使用文件型 Secret，不直接把 PEM 内容写入 `.env`。

```bash
BILLING_ORDER_EXPIRES_SECONDS=900
BILLING_OFFLINE_PAYMENTS=false

WECHAT_PAY_ENABLED=true
WECHAT_PAY_APP_ID=
WECHAT_PAY_MCH_ID=
WECHAT_PAY_API_V3_KEY=
WECHAT_PAY_PRIVATE_KEY_FILE=/run/secrets/wechat_apiclient_key.pem
WECHAT_PAY_CERT_SERIAL_NO=
WECHAT_PAY_PLATFORM_CERT_FILE=/run/secrets/wechat_platform_cert.pem
WECHAT_PAY_NOTIFY_URL=https://codex-api.xmwefun.cn/v1/billing/payments/wechat/callback

ALIPAY_ENABLED=true
ALIPAY_APP_ID=
ALIPAY_PRIVATE_KEY_FILE=/run/secrets/alipay_app_private_key.pem
ALIPAY_PUBLIC_KEY_FILE=/run/secrets/alipay_public_key.pem
ALIPAY_GATEWAY_URL=https://openapi.alipay.com/gateway.do
ALIPAY_NOTIFY_URL=https://codex-api.xmwefun.cn/v1/billing/payments/alipay/callback
```

如果只先联调一个渠道，只打开对应渠道的 `*_ENABLED=true`。

## 6. 后台配置动作

部署后先进入管理后台完成以下动作：

- 确认 `billing-plan-formal-month` 和 `billing-plan-formal-year` 存在。
- 设置套餐名称、描述、价格、周期和权益。
- 联调期间保持 `purchase_enabled=false`。
- 小额真实订单验收通过后，再将需要售卖的套餐设置为 `purchase_enabled=true`。
- 不要修改已有人工开通正式权益的用户数据，支付成功后系统会按当前有效期顺延。

权益 JSON 示例：

```json
{
  "tunnel.quick": true,
  "tunnel.named": true,
  "device.max_count": 5
}
```

## 7. 建议部署顺序

1. 备份生产数据库。
2. 打生产镜像并部署控制服务，但保持 `purchase_enabled=false`。
3. 执行数据库迁移，确认 `billing_` 表创建成功。
4. 配置管理后台套餐价格、周期、权益，但不开放购买。
5. 配置微信支付和支付宝生产或沙箱参数。
6. 用内测账号创建订单并生成二维码。
7. 完成小额支付，确认支付平台异步回调命中 API 域名。
8. 确认后台订单、支付、回调日志、订阅和权益全部正确。
9. 验证重复回调不会重复开通权益。
10. 验收通过后开启 `purchase_enabled=true`，再灰度给客户使用。

## 8. 验收清单

必须全部通过后才能正式开放购买：

- 桌面端能拉取可购买套餐。
- 微信支付二维码能生成，扫码后订单变为已支付。
- 支付宝二维码能生成，扫码后订单变为已支付。
- 免费用户购买正式版后立即获得正式权益。
- 已有正式版用户续费后按原到期时间顺延。
- 订单过期后不能继续开通权益。
- 金额、币种、订单号不匹配时不能开通权益。
- 支付平台重复通知时不会重复发放权益。
- 后台能看到订单、支付、回调日志和退款预留记录。
- 生产日志不包含私钥、API v3 密钥、完整交易号、完整手机号或邮箱。

## 9. 官方核对入口

支付平台审核材料和接口规则可能调整，上线前必须以官方后台和官方文档为准：

- 微信支付商户平台：`https://pay.weixin.qq.com/`
- 微信支付 API v3 文档：`https://pay.weixin.qq.com/doc/v3/merchant/`
- 支付宝开放平台：`https://open.alipay.com/`
- 支付宝 `alipay.trade.precreate` 接口：`https://opendocs.alipay.com/apis/api_1/alipay.trade.precreate`

## 10. 关联项目文档

- 支付需求变更：`docs/desktop-cloud-platform/payment-module-change-request.md`
- 支付模块对接文档：`docs/desktop-cloud-platform/payment-module-integration-guide.md`
- 当前实施状态：`docs/desktop-cloud-platform/implementation-status.md`
