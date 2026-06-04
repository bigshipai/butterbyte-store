import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import md5 from "blueimp-md5";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";


function getUpiConfig() {
  return {
    appId:       process.env.UPI_APP_ID       ?? "",
    walletId:    process.env.UPI_WALLET_ID    ?? "",
    signKey:     process.env.UPI_SIGN_KEY     ?? "",
    apiUrl:      process.env.UPI_API_URL      ?? "",
    statusUrl:   process.env.UPI_STATUS_URL   ?? "",
    timeoutMins: parseInt(process.env.UPI_PAYMENT_TIMEOUT_MINS ?? "15", 10),
  };
}



function generateSignature(
  params: Record<string, string | number>,
  signKey: string,
): string {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== null && v !== undefined && v !== "",
  );
  entries.sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const str = entries.map(([k, v]) => `${k}=${v}`).join("&") + "&key=" + signKey;
  return md5(str);
}

function cleanParameter(value: string): string {
  return value.replace(/[^a-zA-Z0-9.@]/g, "");
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const OrderItemSchema = z.object({
  product_id: z.string().uuid(),
  name:       z.string().min(1).max(255),
  sku:        z.string().max(100).nullable().optional(),
  price:      z.number().nonnegative(),
  qty:        z.number().int().positive().max(99),
  image_url:  z.string().max(2000).nullable().optional(),
});

const AddressSchema = z.object({
  firstName: z.string().min(1).max(60),
  lastName:  z.string().min(1).max(60),
  email:     z.string().email().max(255),
  phone:     z.string().regex(/^[6-9]\d{9}$/),
  line1:     z.string().min(3).max(255),
  line2:     z.string().max(255).optional().nullable(),
  pincode:   z.string().regex(/^\d{6}$/),
  city:      z.string().min(1).max(100),
  state:     z.string().min(1).max(100),
});

// ---------------------------------------------------------------------------
// initiateUpiPayment
// ---------------------------------------------------------------------------

export const initiateUpiPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        items:   z.array(OrderItemSchema).min(1).max(50),
        address: AddressSchema,
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const cfg = getUpiConfig();

    if (!cfg.signKey) {
      throw new Error(
        "UPI payment is not configured. Please contact the store administrator.",
      );
    }

    // Server-authoritative pricing — re-fetch current prices from the database.
    const productIds = [...new Set(data.items.map((i) => i.product_id))];
    const { data: dbProducts, error: prodErr } = await supabase
      .from("products")
      .select("id, name, selling_price")
      .in("id", productIds);
    if (prodErr) throw new Error(prodErr.message);

    const priceMap = new Map((dbProducts ?? []).map((p) => [p.id, p]));
    const pricedItems = data.items.map((it) => {
      const p = priceMap.get(it.product_id);
      if (!p) throw new Error(`Product no longer available: ${it.name}`);
      const unitPrice = Number(p.selling_price);
      if (!Number.isFinite(unitPrice) || unitPrice < 0)
        throw new Error(`Invalid price for product: ${p.name}`);
      return {
        product_id: it.product_id,
        name:       p.name,
        sku:        it.sku ?? null,
        price:      unitPrice,
        qty:        it.qty,
        image_url:  it.image_url ?? null,
      };
    });

    const subtotal = pricedItems.reduce((s, l) => s + l.price * l.qty, 0);
    const shipping  = subtotal >= 999 || subtotal === 0 ? 0 : 79;
    const total     = subtotal + shipping;

    const merchantOrderId = "BB" + Date.now();
    const mobile = /^[6-9]\d{9}$/.test(data.address.phone)
      ? data.address.phone
      : "9123456789";

    const params: Record<string, string | number> = {
      appId:           cfg.appId,
      amount:          Math.round(total * 100),
      merchantOrderId: cleanParameter(merchantOrderId),
      paymentType:     "UPI",
      name:            cleanParameter(data.address.firstName + data.address.lastName),
      email:           cleanParameter(data.address.email),
      mobile,
      upi:             mobile,
      walletId:        cfg.walletId,
      channelId:       "WEB",
      walletType:      "UPI",
      ip:              "127.0.0.1",
    };

    const sign = generateSignature(params, cfg.signKey);

    const apiRes = await fetch(cfg.apiUrl, {
      method:  "POST",
      headers: {
        sign,
        "Content-Type": "application/json",
        "User-Agent":   "ButterbyteStore-UPI/1.0",
      },
      body: JSON.stringify(params),
    });

    if (!apiRes.ok)
      throw new Error(`Gateway request failed with status ${apiRes.status}`);

    type ApiBody = {
      code:  string;
      msg?:  string;
      data?: {
        result?:   { paymentLink?: string };
        orderId?:  string;
        status?:   string;
        errorMsg?: string;
      };
    };

    const body = (await apiRes.json()) as ApiBody;

    if (body.code !== "0000") throw new Error(body.msg ?? "Unknown gateway error");
    if (body.data?.status === "FAIL")
      throw new Error(body.data.errorMsg ?? "Payment initiation failed");

    const paymentLink = body.data?.result?.paymentLink;
    if (!paymentLink)
      throw new Error("No payment link received from gateway");

    // Return everything the payment page needs — no database write required.
    return {
      merchantOrderId: cleanParameter(merchantOrderId),
      paymentLink,
      amount:      total,
      timeoutMins: cfg.timeoutMins,
      pricedItems,
      subtotal,
      shipping,
    };
  });


export const checkUpiPaymentStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    const schema = z.object({
      merchantOrderId: z.string().min(1).max(80),
      // Cart snapshot — only used when the payment is confirmed PAID.
      items:   z.array(OrderItemSchema).min(1).max(50),
      address: AddressSchema,
    });
    const result = schema.safeParse(input);
    if (!result.success) {
      console.error(
        "[checkUpiPaymentStatus] Input validation failed:",
        JSON.stringify(result.error.issues, null, 2),
      );
      throw result.error;
    }
    return result.data;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const cfg = getUpiConfig();

    const queryParams: Record<string, string> = {
      appId:           cfg.appId,
      merchantOrderId: data.merchantOrderId,
    };

    const sign = generateSignature(queryParams, cfg.signKey);

    let apiRes: Response;
    try {
      apiRes = await fetch(cfg.statusUrl, {
        method:  "POST",
        headers: {
          sign,
          "Content-Type": "application/json",
          "User-Agent":   "ButterbyteStore-UPI/1.0",
        },
        body: JSON.stringify(queryParams),
      });
    } catch (err) {
      console.error("[checkUpiPaymentStatus] Network error fetching status:", err);
      return { status: "PENDING" as const };
    }

    if (!apiRes.ok) {
      console.warn("[checkUpiPaymentStatus] Gateway returned non-OK status:", apiRes.status);
      return { status: "PENDING" as const };
    }

    type StatusBody = {
      code:  string;
      data?: Record<string, unknown>;
    };

    const body = (await apiRes.json()) as StatusBody;

    // 打印完整响应，方便排查字段名/状态值
    console.log("[checkUpiPaymentStatus] Gateway raw response:", JSON.stringify(body, null, 2));

    if (body.code !== "0000") return { status: "PENDING" as const };

    // 兼容多种字段名：orderStatus / status / payStatus / order_status
    const rawData = body.data as Record<string, unknown> | undefined;
    const orderStatus: string =
      (rawData?.orderStatus as string) ??
      (rawData?.status as string) ??
      (rawData?.payStatus as string) ??
      (rawData?.order_status as string) ??
      "PENDING";

    const transactionId =
      (rawData?.transactionId as string) ??
      (rawData?.transaction_id as string) ??
      (rawData?.orderId as string) ??
      "";

    console.log("[checkUpiPaymentStatus] Resolved orderStatus:", orderStatus, "transactionId:", transactionId);

    // 兼容 PAID / SUCCESS / paid / success
    const isPaid = /^(PAID|SUCCESS|paid|success)$/i.test(orderStatus);

    if (!isPaid) {
      return { status: orderStatus as "PENDING" | "FAIL" };
    }

    // Payment confirmed — re-validate prices from database and create the order.
    const productIds = [...new Set(data.items.map((i) => i.product_id))];
    const { data: dbProducts, error: prodErr } = await supabase
      .from("products")
      .select("id, name, selling_price")
      .in("id", productIds);
    if (prodErr) return { status: "PENDING" as const };

    type DbProduct = { id: string; name: string; selling_price: number };
    const priceMap = new Map((dbProducts ?? []).map((p) => [p.id, p as DbProduct]));
    const pricedItems = data.items.map((it) => {
      const p = priceMap.get(it.product_id);
      if (!p) return null;
      return {
        product_id: it.product_id,
        name:       p.name,
        sku:        it.sku ?? null,
        price:      Number(p.selling_price),
        qty:        it.qty,
        image_url:  it.image_url ?? null,
      };
    }).filter((x): x is NonNullable<typeof x> => x !== null);

    const subtotal = pricedItems.reduce((s, l) => s + l.price * l.qty, 0);
    const shipping  = subtotal >= 999 || subtotal === 0 ? 0 : 79;
    const total     = subtotal + shipping;

    const orderNo = "BB" + Date.now().toString().slice(-8);

    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .insert({
        user_id:          userId,
        order_no:         orderNo,
        subtotal,
        discount:         0,
        shipping,
        total,
        status:           "confirmed",
        payment_method:   "upi",
        address_snapshot: {
          ...data.address,
          upi_merchant_order_id: data.merchantOrderId,
          upi_transaction_id:    transactionId,
        },
      })
      .select("id, order_no")
      .single();

    if (orderErr || !order) return { status: "PENDING" as const };

    await supabase.from("order_items").insert(
      pricedItems.map((it) => ({ order_id: order.id, ...it })),
    );

    return { status: "PAID" as const, order_no: order.order_no };
  });
