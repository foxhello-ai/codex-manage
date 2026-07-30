import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { assertProvider, BillingError, type BillingProvider } from "@codex-manage/payment-core";
import type { PaymentService } from "@codex-manage/payment-service";

const CreateOrderRequest = z.object({
  planId: z.string().min(1).optional(),
  planCode: z.string().min(1).optional(),
  channel: z.enum(["wechat", "alipay"]),
  clientType: z.string().min(1).max(40).default("desktop"),
  returnUrl: z.string().max(500).nullable().optional()
}).refine((value) => Boolean(value.planId || value.planCode), "必须指定套餐");

const PayOrderRequest = z.object({
  channel: z.enum(["wechat", "alipay"]),
  returnUrl: z.string().max(500).nullable().optional()
});

const OrderParams = z.object({ orderId: z.string().min(1) });
const ProviderParams = z.object({ provider: z.enum(["wechat", "alipay"]) });
const ListOrdersQuery = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().nullable().optional()
});

const PlanParams = z.object({ planId: z.string().min(1) });
const UpdatePlanRequest = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  priceCents: z.number().int().min(0).optional(),
  billingPeriod: z.enum(["none", "month", "year", "custom", "lifetime", "manual"]).optional(),
  durationDays: z.number().int().min(1).nullable().optional(),
  purchaseEnabled: z.boolean().optional(),
  features: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["active", "inactive", "archived"]).optional(),
  sortOrder: z.number().int().optional()
}).refine((value) => Object.keys(value).length > 0, "至少需要一个更新字段");

const RefundRequest = z.object({
  amountCents: z.number().int().min(1).nullable().optional(),
  reason: z.string().trim().min(1).max(500)
});

export type BillingRouteOptions = {
  prefix: string;
  compatibleRoutes?: boolean;
  paymentService: PaymentService;
  authenticateUser(request: FastifyRequest): Promise<string>;
  authenticateAdmin(request: FastifyRequest, requireWrite?: boolean): Promise<string>;
};

export async function registerBillingRoutes(app: FastifyInstance, options: BillingRouteOptions): Promise<void> {
  registerRawBodyHook(app);
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => done(null, body));

  registerUserRoutes(app, options.prefix, options);
  registerAdminRoutes(app, options);
  if (options.compatibleRoutes) registerUserRoutes(app, "/v1", options, true);
}

function registerUserRoutes(app: FastifyInstance, prefix: string, options: BillingRouteOptions, compatible = false): void {
  const plansPath = compatible ? `${prefix}/plans` : `${prefix}/plans`;
  const ordersPath = compatible ? `${prefix}/orders` : `${prefix}/orders`;

  app.get(plansPath, async () => ({ plans: (await options.paymentService.listPlans()).map(serializePlan) }));

  app.post(ordersPath, async (request) => {
    const userId = await options.authenticateUser(request);
    const body = parseBody(CreateOrderRequest, request.body);
    const order = await options.paymentService.createOrder({
      userId,
      planId: body.planId,
      planCode: body.planCode,
      channel: body.channel,
      clientType: body.clientType,
      returnUrl: body.returnUrl
    });
    return { order: serializeOrder(order) };
  });

  app.get(ordersPath, async (request) => {
    const userId = await options.authenticateUser(request);
    const query = parseBody(ListOrdersQuery, request.query);
    const result = await options.paymentService.listUserOrders(userId, {
      status: query.status as never,
      limit: query.limit,
      cursor: query.cursor
    });
    return { orders: result.orders.map(serializeOrder), nextCursor: result.nextCursor };
  });

  app.get(`${ordersPath}/:orderId`, async (request) => {
    const userId = await options.authenticateUser(request);
    const params = parseBody(OrderParams, request.params);
    return serializeDetail(await options.paymentService.getUserOrder(userId, params.orderId));
  });

  app.post(`${ordersPath}/:orderId/pay`, async (request) => {
    const userId = await options.authenticateUser(request);
    const params = parseBody(OrderParams, request.params);
    const body = parseBody(PayOrderRequest, request.body);
    return serializeDetail(await options.paymentService.createPayment(userId, params.orderId, body.channel, body.returnUrl));
  });

  app.post(`${ordersPath}/:orderId/close`, async (request) => {
    const userId = await options.authenticateUser(request);
    const params = parseBody(OrderParams, request.params);
    if (!await options.paymentService.closeOrder(userId, params.orderId)) {
      throw new BillingError("ORDER_NOT_FOUND", "订单不存在", 404);
    }
    return { closed: true };
  });

  app.post(`${prefix}/payments/:provider/callback`, async (request, reply) => {
    const params = parseBody(ProviderParams, request.params);
    const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody ?? rawBodyFromParsed(request.body);
    const result = await options.paymentService.handleCallback(assertProvider(params.provider), {
      headers: request.headers,
      rawBody,
      parsedBody: request.body
    });
    if (params.provider === "alipay") {
      return reply.type("text/plain").send("success");
    }
    return { code: "SUCCESS", message: "成功", duplicated: result.duplicated };
  });
}

function registerAdminRoutes(app: FastifyInstance, options: BillingRouteOptions): void {
  app.get("/v1/admin/billing/plans", async (request) => {
    await options.authenticateAdmin(request);
    return { plans: (await options.paymentService.listAdminPlans()).map(serializePlan) };
  });

  app.patch("/v1/admin/billing/plans/:planId", async (request) => {
    await options.authenticateAdmin(request, true);
    const params = parseBody(PlanParams, request.params);
    const body = parseBody(UpdatePlanRequest, request.body);
    const plan = await options.paymentService.updateAdminPlan(params.planId, body);
    if (!plan) throw new BillingError("PLAN_NOT_PURCHASABLE", "套餐不存在", 404);
    return { plan: serializePlan(plan) };
  });

  app.get("/v1/admin/billing/callbacks", async (request) => {
    await options.authenticateAdmin(request);
    return { callbacks: await options.paymentService.listAdminCallbackLogs() };
  });

  app.post("/v1/admin/billing/orders/:orderId/refund", async (request) => {
    const adminId = await options.authenticateAdmin(request, true);
    const params = parseBody(OrderParams, request.params);
    const body = parseBody(RefundRequest, request.body);
    return { refund: await options.paymentService.recordRefundRequest({
      adminId,
      orderId: params.orderId,
      amountCents: body.amountCents ?? null,
      reason: body.reason
    }) };
  });
}

function registerRawBodyHook(app: FastifyInstance): void {
  app.addHook("preParsing", (request, _reply, payload, done) => {
    if (!request.url.includes("/payments/") || !request.url.includes("/callback")) {
      done(null, payload);
      return;
    }
    const chunks: Buffer[] = [];
    payload.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    payload.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      (request as FastifyRequest & { rawBody?: string }).rawBody = rawBody.toString("utf8");
      done(null, Readable.from(rawBody));
    });
    payload.on("error", (error) => done(error));
  });
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BillingError("INVALID_REQUEST", "请求参数不正确", 400, parsed.error.flatten());
  }
  return parsed.data;
}

function rawBodyFromParsed(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

function serializePlan(plan: ReturnType<PaymentService["listPlans"]> extends Promise<Array<infer Plan>> ? Plan : never) {
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    description: plan.description,
    price_cents: plan.priceCents,
    currency: plan.currency,
    billing_period: plan.billingPeriod,
    duration_days: plan.durationDays,
    purchase_enabled: plan.purchaseEnabled,
    features: plan.features,
    status: plan.status,
    sort_order: plan.sortOrder
  };
}

function serializeOrder(order: Parameters<typeof serializeDetail>[0]["order"]) {
  return {
    id: order.id,
    order_no: order.orderNo,
    user_id: order.userId,
    plan_id: order.planId,
    plan_code: order.planCode,
    plan_name: order.planName,
    plan_snapshot: order.planSnapshot,
    amount_cents: order.amountCents,
    currency: order.currency,
    channel: order.channel,
    client_type: order.clientType,
    status: order.status,
    expires_at: order.expiresAt,
    paid_at: order.paidAt,
    closed_at: order.closedAt,
    created_at: order.createdAt,
    updated_at: order.updatedAt
  };
}

function serializePayment(payment: NonNullable<Parameters<typeof serializeDetail>[0]["payment"]>) {
  return {
    id: payment.id,
    order_id: payment.orderId,
    provider: payment.provider,
    channel: payment.channel,
    provider_order_no: payment.providerOrderNo,
    provider_transaction_id: payment.providerTransactionId,
    amount_cents: payment.amountCents,
    currency: payment.currency,
    status: payment.status,
    qr_code_url: payment.qrCodeUrl,
    expires_at: payment.expiresAt,
    paid_at: payment.paidAt,
    failure_code: payment.failureCode,
    failure_message: payment.failureMessage,
    created_at: payment.createdAt,
    updated_at: payment.updatedAt
  };
}

function serializeDetail(detail: Awaited<ReturnType<PaymentService["getUserOrder"]>>) {
  return {
    order: serializeOrder(detail.order),
    payment: detail.payment ? serializePayment(detail.payment) : null,
    fulfillment: detail.fulfillment ? {
      fulfilled: detail.fulfillment.fulfilled,
      business_object_type: detail.fulfillment.businessObjectType,
      business_object_id: detail.fulfillment.businessObjectId,
      starts_at: detail.fulfillment.startsAt,
      expires_at: detail.fulfillment.expiresAt,
      summary: detail.fulfillment.summary
    } : null
  };
}
