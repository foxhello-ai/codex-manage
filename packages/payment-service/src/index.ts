import {
  BillingError,
  type BillingOrderStatus,
  type BillingProvider,
  type BillingRepository,
  type CreateBillingOrderInput,
  type PaymentFulfillmentPort,
  type PaymentProvider
} from "@codex-manage/payment-core";

export type PaymentServiceOptions = {
  repository: BillingRepository;
  providers: PaymentProvider[];
  fulfillmentPort: PaymentFulfillmentPort;
  orderExpiresInSeconds: number;
};

export class PaymentService {
  private readonly providers = new Map<BillingProvider, PaymentProvider>();

  constructor(private readonly options: PaymentServiceOptions) {
    for (const provider of options.providers) {
      this.providers.set(provider.provider, provider);
    }
  }

  listPlans() {
    return this.options.repository.listPlans();
  }

  listAdminPlans() {
    return this.options.repository.listAdminPlans();
  }

  updateAdminPlan(planId: string, input: Parameters<BillingRepository["updateAdminPlan"]>[1]) {
    return this.options.repository.updateAdminPlan(planId, input);
  }

  createOrder(input: CreateBillingOrderInput) {
    return this.options.repository.createOrReuseOrder(input, this.options.orderExpiresInSeconds);
  }

  listUserOrders(userId: string, input?: { status?: BillingOrderStatus; limit?: number; cursor?: string | null }) {
    return this.options.repository.listUserOrders(userId, input);
  }

  async getUserOrder(userId: string, orderId: string) {
    const detail = await this.options.repository.getUserOrderDetail(userId, orderId);
    if (!detail) throw new BillingError("ORDER_NOT_FOUND", "订单不存在", 404);
    return detail;
  }

  async createPayment(userId: string, orderId: string, provider: BillingProvider, returnUrl?: string | null) {
    const existing = await this.options.repository.getUserOrderDetail(userId, orderId);
    if (!existing) throw new BillingError("ORDER_NOT_FOUND", "订单不存在", 404);
    if (existing.order.status === "paid") throw new BillingError("ORDER_ALREADY_PAID", "订单已支付", 409);
    if (
      existing.payment?.provider === provider
      && existing.payment.status === "pending"
      && new Date(existing.payment.expiresAt).getTime() > Date.now()
      && ["pending", "paying"].includes(existing.order.status)
    ) {
      return existing;
    }
    const order = await this.options.repository.getPayableOrder(userId, orderId);
    const adapter = this.providers.get(provider);
    if (!adapter) {
      throw new BillingError("PAYMENT_PROVIDER_NOT_CONFIGURED", "支付渠道未配置", 503, { provider });
    }
    const result = await adapter.createPayment({ order, returnUrl });
    return await this.options.repository.savePaymentParameters(order, result);
  }

  closeOrder(userId: string, orderId: string) {
    return this.options.repository.closeUserOrder(userId, orderId);
  }

  async handleCallback(provider: BillingProvider, input: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
    parsedBody: unknown;
  }) {
    const adapter = this.providers.get(provider);
    if (!adapter) {
      throw new BillingError("PAYMENT_PROVIDER_NOT_CONFIGURED", "支付渠道未配置", 503, { provider });
    }
    try {
      const verified = await adapter.verifyCallback(input);
      return await this.options.repository.completeVerifiedPayment(verified, this.options.fulfillmentPort);
    } catch (error) {
      if (error instanceof BillingError && error.code === "PAYMENT_SIGNATURE_INVALID") {
        await this.options.repository.recordInvalidCallback({
          provider,
          rawPayloadRedacted: redactCallbackBody(input.parsedBody, input.rawBody),
          errorCode: error.code
        });
      }
      throw error;
    }
  }

  listAdminOrders() {
    return this.options.repository.listAdminOrders();
  }

  listAdminPayments() {
    return this.options.repository.listAdminPayments();
  }

  listAdminCallbackLogs() {
    return this.options.repository.listAdminCallbackLogs();
  }

  recordRefundRequest(input: { adminId: string; orderId: string; amountCents: number | null; reason: string }) {
    return this.options.repository.recordRefundRequest(input);
  }
}

function redactCallbackBody(parsedBody: unknown, rawBody: string): Record<string, unknown> {
  if (parsedBody && typeof parsedBody === "object") {
    return JSON.parse(JSON.stringify(parsedBody, (_key, value) => {
      if (typeof value !== "string") return value;
      if (value.length <= 12) return value;
      return `${value.slice(0, 6)}...${value.slice(-4)}`;
    })) as Record<string, unknown>;
  }
  return { raw: rawBody.length > 200 ? `${rawBody.slice(0, 120)}...` : rawBody };
}
