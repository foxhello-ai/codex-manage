import { createSign, createVerify } from "node:crypto";
import {
  BillingError,
  type CreatePaymentInput,
  type PaymentProvider,
  type PaymentProviderResult,
  type VerifiedPaymentCallback
} from "@codex-manage/payment-core";

export type AlipayConfig = {
  appId: string;
  privateKeyPem: string;
  publicKeyPem: string;
  notifyUrl: string;
  gatewayUrl?: string;
};

export class AlipayProvider implements PaymentProvider {
  readonly provider = "alipay" as const;
  private readonly gatewayUrl: string;

  constructor(private readonly config: AlipayConfig) {
    this.gatewayUrl = config.gatewayUrl ?? "https://openapi.alipay.com/gateway.do";
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentProviderResult> {
    const params = new URLSearchParams(commonParams(this.config, "alipay.trade.precreate"));
    params.set("notify_url", this.config.notifyUrl);
    params.set("biz_content", JSON.stringify({
      out_trade_no: input.order.orderNo,
      total_amount: centsToYuan(input.order.amountCents),
      subject: input.order.planName,
      timeout_express: "15m"
    }));
    params.set("sign", signParams(params, this.config.privateKeyPem));

    const response = await fetch(this.gatewayUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded;charset=utf-8"
      },
      body: params.toString()
    });
    const payload = await response.json().catch(() => null) as {
      alipay_trade_precreate_response?: { code?: string; msg?: string; sub_msg?: string; qr_code?: string; out_trade_no?: string };
    } | null;
    const result = payload?.alipay_trade_precreate_response;
    if (!response.ok || result?.code !== "10000" || !result.qr_code) {
      throw new BillingError("PAYMENT_PROVIDER_ERROR", result?.sub_msg ?? result?.msg ?? "支付宝下单失败", 502, payload);
    }
    return {
      provider: this.provider,
      channel: "precreate_qr",
      providerOrderNo: result.out_trade_no ?? input.order.orderNo,
      qrCodeUrl: result.qr_code,
      expiresAt: input.order.expiresAt,
      payload: {}
    };
  }

  async verifyCallback(input: { rawBody: string; parsedBody: unknown }): Promise<VerifiedPaymentCallback> {
    const params = parseAlipayBody(input.rawBody, input.parsedBody);
    const signature = params.get("sign");
    if (!signature || !verifyParams(params, signature, this.config.publicKeyPem)) {
      throw new BillingError("PAYMENT_SIGNATURE_INVALID", "支付宝回调验签失败", 400);
    }
    const tradeStatus = params.get("trade_status") ?? "";
    const orderNo = params.get("out_trade_no") ?? "";
    const tradeNo = params.get("trade_no") ?? "";
    const totalAmount = params.get("total_amount") ?? "0";
    const paidAt = params.get("gmt_payment") ?? params.get("notify_time") ?? new Date().toISOString();
    return {
      provider: this.provider,
      orderNo,
      providerTransactionId: tradeNo,
      amountCents: yuanToCents(totalAmount),
      currency: "CNY",
      paidAt: normalizeAlipayTime(paidAt),
      tradeState: tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED" ? "SUCCESS" : tradeStatus === "TRADE_CLOSED" ? "CLOSED" : "FAILED",
      rawPayloadRedacted: {
        out_trade_no: orderNo,
        trade_no: redact(tradeNo),
        trade_status: tradeStatus,
        total_amount: totalAmount
      }
    };
  }
}

function commonParams(config: AlipayConfig, method: string): Record<string, string> {
  return {
    app_id: config.appId,
    method,
    format: "JSON",
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp: formatAlipayDate(new Date()),
    version: "1.0"
  };
}

function signParams(params: URLSearchParams, privateKeyPem: string): string {
  const signer = createSign("RSA-SHA256");
  signer.update(canonicalize(params));
  signer.end();
  return signer.sign(privateKeyPem, "base64");
}

function verifyParams(params: URLSearchParams, signature: string, publicKeyPem: string): boolean {
  const verifier = createVerify("RSA-SHA256");
  verifier.update(canonicalize(params));
  verifier.end();
  return verifier.verify(publicKeyPem, signature, "base64");
}

function canonicalize(params: URLSearchParams): string {
  return Array.from(params.entries())
    .filter(([key, value]) => key !== "sign" && key !== "sign_type" && value !== "")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function parseAlipayBody(rawBody: string, parsedBody: unknown): URLSearchParams {
  if (typeof parsedBody === "string") return new URLSearchParams(parsedBody);
  if (rawBody) return new URLSearchParams(rawBody);
  const params = new URLSearchParams();
  if (parsedBody && typeof parsedBody === "object") {
    for (const [key, value] of Object.entries(parsedBody)) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
  }
  return params;
}

function centsToYuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

function yuanToCents(value: string): number {
  return Math.round(Number.parseFloat(value) * 100);
}

function formatAlipayDate(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function normalizeAlipayTime(value: string): string {
  if (/^\d{4}-\d{2}-\d{2} /.test(value)) return new Date(value.replace(" ", "T")).toISOString();
  return new Date(value).toISOString();
}

function redact(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}...${value.slice(-4)}`;
}
