import { createHmac } from "node:crypto";
import {
  BillingError,
  type BillingProvider,
  type CreatePaymentInput,
  type PaymentProvider,
  type PaymentProviderResult,
  type VerifiedPaymentCallback
} from "@codex-manage/payment-core";

export class OfflinePaymentProvider implements PaymentProvider {
  constructor(readonly provider: BillingProvider, private readonly secret: string) {}

  async createPayment(input: CreatePaymentInput): Promise<PaymentProviderResult> {
    return {
      provider: this.provider,
      channel: "offline_qr",
      providerOrderNo: input.order.orderNo,
      qrCodeUrl: `codex-manage://offline-pay?provider=${this.provider}&orderNo=${encodeURIComponent(input.order.orderNo)}&amount=${input.order.amountCents}`,
      expiresAt: input.order.expiresAt,
      payload: {}
    };
  }

  async verifyCallback(input: { headers: Record<string, string | string[] | undefined>; rawBody: string; parsedBody: unknown }): Promise<VerifiedPaymentCallback> {
    const signature = headerValue(input.headers, "x-codex-offline-signature");
    const expected = createHmac("sha256", this.secret).update(input.rawBody).digest("hex");
    if (!signature || signature !== expected) {
      throw new BillingError("PAYMENT_SIGNATURE_INVALID", "离线支付回调验签失败", 400);
    }
    const body = typeof input.parsedBody === "object" && input.parsedBody
      ? input.parsedBody as Record<string, unknown>
      : JSON.parse(input.rawBody) as Record<string, unknown>;
    return {
      provider: this.provider,
      orderNo: String(body.orderNo),
      providerTransactionId: String(body.providerTransactionId ?? `offline-${body.orderNo}`),
      amountCents: Number(body.amountCents),
      currency: "CNY",
      paidAt: typeof body.paidAt === "string" ? new Date(body.paidAt).toISOString() : new Date().toISOString(),
      tradeState: body.tradeState === "CLOSED" ? "CLOSED" : body.tradeState === "FAILED" ? "FAILED" : "SUCCESS",
      rawPayloadRedacted: {
        orderNo: body.orderNo,
        providerTransactionId: body.providerTransactionId,
        amountCents: body.amountCents,
        tradeState: body.tradeState ?? "SUCCESS"
      }
    };
  }
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
