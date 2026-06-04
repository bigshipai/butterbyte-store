import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { cart, useStore } from "@/lib/store";
import { inr } from "@/lib/format";
import { toast } from "sonner";
import { useAuth } from "@/lib/use-auth";
import { createOrder } from "@/lib/orders.functions";
import { initiateUpiPayment } from "@/lib/upi.functions";
import { UPI_SESSION_KEY, type UpiSession } from "@/routes/upi-pay";

export const Route = createFileRoute("/checkout")({
  head: () => ({ meta: [{ title: "Checkout — BUTTERBYTE STORE" }] }),
  component: Checkout,
});

const NAME_RE = /^[A-Za-z][A-Za-z\s'\-.]{1,39}$/;
function isValidIndianName(raw: string): boolean {
  const s = raw.trim();
  if (!NAME_RE.test(s)) return false;
  if (!/[aeiouAEIOU]/.test(s)) return false;
  if (/(.)\1{3,}/.test(s)) return false;
  if (/^[bcdfghjklmnpqrstvwxyz]{5,}$/i.test(s.replace(/\s/g, ""))) return false;
  return true;
}

function Checkout() {
  const { user, loading: authLoading } = useAuth();
  const { cartItems } = useStore();
  const navigate = useNavigate();
  const subtotal = cartItems.reduce((s, l) => s + l.price * l.qty, 0);
  const shipping = subtotal >= 999 || subtotal === 0 ? 0 : 79;
  const total = subtotal + shipping;
  const [paymentMethod, setPaymentMethod] = useState<"cod" | "upi">("cod");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [line1, setLine1] = useState("");
  const [line2, setLine2] = useState("");
  const [pincode, setPincode] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [pinLoading, setPinLoading] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);

  const [errors, setErrors] = useState<{ firstName?: string; lastName?: string; pincode?: string; email?: string; phone?: string; line1?: string }>({});

  // Prefill email when user is logged in
  useEffect(() => {
    if (user?.email && !email) setEmail(user.email);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      toast.info("Please sign in to place your order");
      navigate({ to: "/login", search: { redirect: "/checkout" } as any });
    }
  }, [authLoading, user, navigate]);

  // Auto-fetch State/City from PIN
  useEffect(() => {
    if (!/^\d{6}$/.test(pincode)) {
      setPinError(null);
      return;
    }
    let cancelled = false;
    setPinLoading(true);
    setPinError(null);
    fetch(`https://api.postalpincode.in/pincode/${pincode}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const entry = Array.isArray(data) ? data[0] : null;
        const office = entry?.PostOffice?.[0];
        if (entry?.Status === "Success" && office) {
          setCity(office.District || office.Block || office.Name || "");
          setState(office.State || "");
          setPinError(null);
        } else {
          setCity("");
          setState("");
          setPinError("Invalid PIN code. Please enter a valid Indian PIN code.");
        }
      })
      .catch(() => {
        if (!cancelled) setPinError("Could not look up PIN code. Please enter City and State manually.");
      })
      .finally(() => {
        if (!cancelled) setPinLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pincode]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;

    const newErrors: typeof errors = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) newErrors.email = "Enter a valid email address.";
    if (!/^[6-9]\d{9}$/.test(phone)) newErrors.phone = "Enter a valid 10-digit Indian mobile number.";
    if (!isValidIndianName(firstName)) newErrors.firstName = "Enter a valid first name (letters only).";
    if (!isValidIndianName(lastName)) newErrors.lastName = "Enter a valid last name (letters only).";
    if (line1.trim().length < 5) newErrors.line1 = "Please enter your full street address.";
    if (!/^\d{6}$/.test(pincode)) newErrors.pincode = "Enter a valid 6-digit PIN code.";
    setErrors(newErrors);
    if (Object.keys(newErrors).length) {
      toast.error("Please correct the highlighted fields.");
      return;
    }
    if (!city || !state) {
      toast.error("City and State could not be determined. Please re-check your PIN code.");
      return;
    }
    if (pinLoading) {
      toast.info("Please wait for PIN lookup to finish.");
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);

    const orderItems = cartItems.map((l) => ({
      product_id: l.productId,
      name:       l.name,
      sku:        l.size ? `${l.slug}-${l.size}` : l.slug,
      price:      l.price,
      qty:        l.qty,
      image_url:  l.image,
    }));

    const address = {
      firstName: firstName.trim(),
      lastName:  lastName.trim(),
      email:     email.trim(),
      phone,
      line1:     line1.trim(),
      line2:     line2.trim() || null,
      pincode,
      city,
      state,
    };

    try {
      if (paymentMethod === "upi") {
        const res = await initiateUpiPayment({
          data: { items: orderItems, address },
        });

        const session: UpiSession = {
          merchantOrderId: res.merchantOrderId,
          paymentLink:     res.paymentLink,
          amount:          res.amount,
          timeoutMins:     res.timeoutMins,
          expiresAt:       Date.now() + res.timeoutMins * 60 * 1000,
          items:           res.pricedItems,
          address:         { ...address, line2: address.line2 ?? null },
        };
        sessionStorage.setItem(UPI_SESSION_KEY, JSON.stringify(session));

        navigate({ to: "/upi-pay", search: { mid: res.merchantOrderId } as never });
        return;
      }

      const { order_no } = await createOrder({
        data: {
          items:          orderItems,
          address,
          subtotal,
          shipping,
          total,
          payment_method: "cod",
        },
      });
      cart.clear();
      navigate({ to: "/order-success", search: { o: order_no } as any });
    } catch (err: any) {
      toast.error(err?.message || "Could not place your order. Please try again.");
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <div className="flex-1 flex items-center justify-center"><p className="text-muted-foreground">Loading…</p></div>
        <Footer />
      </div>
    );
  }

  if (cartItems.length === 0) {
    return (
      <div className="min-h-screen flex flex-col">
        <Header />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-muted-foreground">Your bag is empty.</p>
            <Link to="/shop" className="mt-4 inline-block underline">Go shopping</Link>
          </div>
        </div>
        <Footer />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 mx-auto max-w-6xl px-4 sm:px-6 py-8 sm:py-10 w-full">
        <h1 className="font-display text-3xl sm:text-4xl md:text-5xl mb-6 sm:mb-8">Checkout</h1>
        <form onSubmit={onSubmit} className="grid lg:grid-cols-[1fr_360px] gap-6 lg:gap-10">
          <div className="space-y-6">
            <Section title="Contact">
              <Input label="Email *" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
              <Input label="Phone *" type="tel" required value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))} error={errors.phone} maxLength={10} inputMode="numeric" />
            </Section>
            <Section title="Shipping Address">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input label="First Name *" required value={firstName} onChange={(e) => setFirstName(e.target.value)} error={errors.firstName} />
                <Input label="Last Name *" required value={lastName} onChange={(e) => setLastName(e.target.value)} error={errors.lastName} />
              </div>
              <Input label="Address line 1 *" required value={line1} onChange={(e) => setLine1(e.target.value)} error={errors.line1} />
              <Input label="Address line 2 (optional)" value={line2} onChange={(e) => setLine2(e.target.value)} />
              <Input
                label="PIN code *"
                required
                inputMode="numeric"
                maxLength={6}
                value={pincode}
                onChange={(e) => setPincode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                error={errors.pincode || pinError || undefined}
                hint={pinLoading ? "Looking up your location…" : undefined}
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input label="City *" required value={city} onChange={(e) => setCity(e.target.value)} readOnly={pinLoading} />
                <Input label="State *" required value={state} onChange={(e) => setState(e.target.value)} readOnly={pinLoading} />
              </div>
            </Section>
            <Section title="Payment">
              <label
                className={`flex items-start gap-3 border p-4 cursor-pointer transition-colors ${
                  paymentMethod === "cod" ? "border-foreground" : ""
                }`}
              >
                <input
                  type="radio"
                  name="pm"
                  className="mt-1"
                  checked={paymentMethod === "cod"}
                  onChange={() => setPaymentMethod("cod")}
                />
                <div>
                  <div className="text-sm font-medium">Cash on Delivery</div>
                  <div className="text-xs text-muted-foreground">
                    Pay when your order arrives.
                  </div>
                </div>
              </label>
              <label
                className={`flex items-start gap-3 border p-4 cursor-pointer transition-colors ${
                  paymentMethod === "upi" ? "border-foreground" : ""
                }`}
              >
                <input
                  type="radio"
                  name="pm"
                  className="mt-1"
                  checked={paymentMethod === "upi"}
                  onChange={() => setPaymentMethod("upi")}
                />
                <div>
                  <div className="text-sm font-medium">UPI</div>
                  <div className="text-xs text-muted-foreground">
                    Pay instantly via Google Pay, PhonePe, Paytm or any UPI app.
                  </div>
                </div>
              </label>
            </Section>
          </div>
          <aside className="border p-5 sm:p-6 h-fit space-y-3 text-sm lg:sticky lg:top-24">
            <div className="text-xs uppercase tracking-[0.2em] mb-2">Order Summary</div>
            {cartItems.map((l) => (
              <div key={`${l.productId}|${l.size ?? ""}`} className="flex justify-between text-xs text-muted-foreground">
                <span className="truncate pr-2">{l.name} × {l.qty}</span>
                <span>{inr(l.price * l.qty)}</span>
              </div>
            ))}
            <div className="border-t pt-3 flex justify-between"><span className="text-muted-foreground">Subtotal</span><span>{inr(subtotal)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Shipping</span><span>{shipping === 0 ? "Free" : inr(shipping)}</span></div>
            <div className="flex justify-between border-t pt-3 text-base font-semibold"><span>Total</span><span>{inr(total)}</span></div>
            <button disabled={submitting || pinLoading} type="submit" className="block w-full text-center bg-foreground text-background py-3 text-sm uppercase tracking-[0.2em] mt-4 hover:bg-[oklch(0.78_0.13_85)] hover:text-black transition disabled:opacity-60">
              {submitting
                ? paymentMethod === "upi"
                  ? "Initiating payment…"
                  : "Placing order…"
                : paymentMethod === "upi"
                ? "Pay with UPI"
                : "Place Order"}
            </button>
            <p className="text-[11px] text-muted-foreground text-center pt-1">By placing your order you agree to our terms.</p>
          </aside>
        </form>
      </main>
      <Footer />
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border p-5 sm:p-6 space-y-3">
      <div className="text-xs uppercase tracking-[0.2em] mb-1">{title}</div>
      {children}
    </div>
  );
}

function Input({
  label,
  error,
  hint,
  ...props
}: { label: string; error?: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="text-xs text-muted-foreground">{label}</span>
      <input
        {...props}
        className={`mt-1 w-full border px-3 py-2 bg-background focus:outline-none focus:border-foreground ${
          error ? "border-destructive" : ""
        }`}
      />
      {error && <span className="mt-1 block text-xs text-destructive">{error}</span>}
      {!error && hint && <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}
