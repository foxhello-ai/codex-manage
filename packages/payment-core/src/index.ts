export type BillingProvider = "wechat" | "alipay";
export type BillingCurrency = "CNY";
export type BillingPeriod = "none" | "month" | "year" | "custom" | "lifetime" | "manual";
export type BillingClientType = "desktop" | "web" | "admin" | string;

export type BillingOrderStatus =
  | "pending"
  | "paying"
  | "paid"
  | "closed"
  | "failed"
  | "refunding"
  | "refunded";

export type BillingPaymentStatus =
  | "created"
  | "pending"
  | "succeeded"
  | "failed"
  | "closed"
  | "refund_pending"
  | "refunded";

export type BillingPlan = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: BillingCurrency;
  billingPeriod: BillingPeriod;
  durationDays: number | null;
  purchaseEnabled: boolean;
  features: Record<string, unknown>;
  status: "active" | "inactive" | "archived";
  sortOrder: number;
};

export type BillingPlanSnapshot = Omit<BillingPlan, "purchaseEnabled" | "status" | "sortOrder">;

export type BillingOrder = {
  id: string;
  orderNo: string;
  userId: string;
  planId: string;
  planCode: string;
  planName: string;
  planSnapshot: BillingPlanSnapshot;
  amountCents: number;
  currency: BillingCurrency;
  channel: BillingProvider;
  clientType: BillingClientType;
  status: BillingOrderStatus;
  expiresAt: string;
  paidAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BillingPayment = {
  id: string;
  orderId: string;
  provider: BillingProvider;
  channel: string;
  providerOrderNo: string | null;
  providerTransactionId: string | null;
  amountCents: number;
  currency: BillingCurrency;
  status: BillingPaymentStatus;
  qrCodeUrl: string | null;
  expiresAt: string;
  paidAt: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BillingFulfillment = {
  fulfilled: true;
  businessObjectType: "subscription" | string;
  businessObjectId: string;
  startsAt: string;
  expiresAt: string | null;
  summary: Record<string, unknown>;
};

export type BillingOrderDetail = {
  order: BillingOrder;
  payment: BillingPayment | null;
  fulfillment: BillingFulfillment | null;
};

export type CreateBillingOrderInput = {
  userId: string;
  planId?: string;
  planCode?: string;
  channel: BillingProvider;
  clientType: BillingClientType;
  returnUrl?: string | null;
};

export type CreatePaymentInput = {
  order: BillingOrder;
  returnUrl?: string | null;
};

export type PaymentProviderResult = {
  provider: BillingProvider;
  channel: string;
  providerOrderNo: string | null;
  qrCodeUrl: string;
  expiresAt: string;
  payload: Record<string, unknown>;
};

export type VerifiedPaymentCallback = {
  provider: BillingProvider;
  orderNo: string;
  providerTransactionId: string;
  amountCents: number;
  currency: BillingCurrency;
  paidAt: string;
  tradeState: "SUCCESS" | "FAILED" | "CLOSED";
  rawPayloadRedacted: Record<string, unknown>;
};

export type PaidOrderFulfillmentInput = {
  fulfillmentId: string;
  userId: string;
  orderId: string;
  orderNo: string;
  plan: BillingPlanSnapshot;
  paidAt: string;
  amountCents: number;
  currency: BillingCurrency;
  provider: BillingProvider;
  providerTransactionId: string;
};

export type PaymentFulfillmentContext = {
  transaction?: unknown;
};

export interface PaymentFulfillmentPort {
  fulfillPaidOrder(input: PaidOrderFulfillmentInput, context?: PaymentFulfillmentContext): Promise<BillingFulfillment>;
}

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

export interface PaymentProvider {
  readonly provider: BillingProvider;
  createPayment(input: CreatePaymentInput): Promise<PaymentProviderResult>;
  verifyCallback(input: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
    parsedBody: unknown;
  }): Promise<VerifiedPaymentCallback>;
}

export interface BillingRepository {
  listPlans(): Promise<BillingPlan[]>;
  listAdminPlans(): Promise<BillingPlan[]>;
  updateAdminPlan(planId: string, input: Partial<Pick<BillingPlan, "name" | "description" | "priceCents" | "billingPeriod" | "durationDays" | "purchaseEnabled" | "features" | "status" | "sortOrder">>): Promise<BillingPlan | null>;
  createOrReuseOrder(input: CreateBillingOrderInput, orderExpiresInSeconds: number): Promise<BillingOrder>;
  listUserOrders(userId: string, input?: { status?: BillingOrderStatus; limit?: number; cursor?: string | null }): Promise<{ orders: BillingOrder[]; nextCursor: string | null }>;
  getUserOrderDetail(userId: string, orderId: string): Promise<BillingOrderDetail | null>;
  getPayableOrder(userId: string, orderId: string): Promise<BillingOrder>;
  savePaymentParameters(order: BillingOrder, result: PaymentProviderResult): Promise<BillingOrderDetail>;
  closeUserOrder(userId: string, orderId: string): Promise<boolean>;
  completeVerifiedPayment(input: VerifiedPaymentCallback, fulfillmentPort: PaymentFulfillmentPort): Promise<BillingOrderDetail & { duplicated: boolean }>;
  recordInvalidCallback(input: { provider: BillingProvider; rawPayloadRedacted: Record<string, unknown>; errorCode: string }): Promise<void>;
  listAdminOrders(): Promise<Array<Record<string, unknown>>>;
  listAdminPayments(): Promise<Array<Record<string, unknown>>>;
  listAdminCallbackLogs(): Promise<Array<Record<string, unknown>>>;
  recordRefundRequest(input: { adminId: string; orderId: string; amountCents: number | null; reason: string }): Promise<Record<string, unknown>>;
}

export type BillingErrorCode =
  | "PAYMENT_PROVIDER_NOT_CONFIGURED"
  | "PLAN_NOT_PURCHASABLE"
  | "ORDER_NOT_FOUND"
  | "ORDER_FORBIDDEN"
  | "ORDER_EXPIRED"
  | "ORDER_ALREADY_PAID"
  | "ORDER_NOT_PAYABLE"
  | "PAYMENT_SIGNATURE_INVALID"
  | "PAYMENT_AMOUNT_MISMATCH"
  | "PAYMENT_CALLBACK_DUPLICATED"
  | "PAYMENT_FULFILLMENT_FAILED"
  | "PAYMENT_PROVIDER_ERROR"
  | "INVALID_REQUEST";

export class BillingError extends Error {
  constructor(
    readonly code: BillingErrorCode,
    message: string,
    readonly statusCode = 400,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "BillingError";
  }
}

export function toPlanSnapshot(plan: BillingPlan): BillingPlanSnapshot {
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    description: plan.description,
    priceCents: plan.priceCents,
    currency: plan.currency,
    billingPeriod: plan.billingPeriod,
    durationDays: plan.durationDays,
    features: plan.features
  };
}

export function assertProvider(value: string): BillingProvider {
  if (value === "wechat" || value === "alipay") return value;
  throw new BillingError("INVALID_REQUEST", "支付渠道不支持", 400, { provider: value });
}
