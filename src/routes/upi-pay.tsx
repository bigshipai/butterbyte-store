import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { cart } from "@/lib/store";
import { inr } from "@/lib/format";
import { checkUpiPaymentStatus } from "@/lib/upi.functions";

export const UPI_SESSION_KEY = "upi_pending_session";

export interface UpiSession {
  merchantOrderId: string;
  paymentLink:     string;
  amount:          number;
  timeoutMins:     number;
  expiresAt:       number; // ms timestamp
  items: Array<{
    product_id: string;
    name:       string;
    sku:        string | null;
    price:      number;
    qty:        number;
    image_url:  string | null;
  }>;
  address: {
    firstName: string;
    lastName:  string;
    email:     string;
    phone:     string;
    line1:     string;
    line2:     string | null;
    pincode:   string;
    city:      string;
    state:     string;
  };
}

export const Route = createFileRoute("/upi-pay")({
  validateSearch: z.object({ mid: z.string() }),
  head: () => ({
    meta: [{ title: "Complete UPI Payment — BUTTERBYTE STORE" }],
  }),
  component: UpiPayPage,
});

type Phase = "loading" | "waiting" | "checking" | "paid" | "expired" | "error";

function UpiPayPage() {
  const { mid }  = Route.useSearch();
  const navigate = useNavigate();

  const [session,    setSession]    = useState<UpiSession | null>(null);
  const [qrDataUrl,  setQrDataUrl]  = useState<string | null>(null);
  const [timeLeft,   setTimeLeft]   = useState(0);
  const [phase,      setPhase]      = useState<Phase>("loading");
  const [checkCount, setCheckCount] = useState(0);

  const doneRef    = useRef(false);
  const startedRef = useRef(false);


  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(UPI_SESSION_KEY);
      if (!raw) throw new Error("no session");
      const s: UpiSession = JSON.parse(raw);
      if (s.merchantOrderId !== mid) throw new Error("session mismatch");
      if (Date.now() > s.expiresAt) throw new Error("session expired");

      
      if (/^https?:\/\//i.test(s.paymentLink)) {
        window.location.href = s.paymentLink;
        return;
      }

      setSession(s);
      setTimeLeft(Math.floor((s.expiresAt - Date.now()) / 1000));
      setPhase("waiting");

      QRCode.toDataURL(s.paymentLink, {
        width:               220,
        errorCorrectionLevel: "H",
        margin:              1,
        color: { dark: "#000000", light: "#ffffff" },
      }).then(setQrDataUrl);
    } catch {
      setPhase("error");
      setTimeout(() => navigate({ to: "/cart" }), 2500);
    }

  }, []);

  useEffect(() => {
    if (phase !== "waiting" || startedRef.current) return;
    startedRef.current = true;

 
    const cdTimer = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          clearInterval(cdTimer);
          if (!doneRef.current) {
            doneRef.current = true;
            setPhase("expired");
            sessionStorage.removeItem(UPI_SESSION_KEY);
            setTimeout(() => navigate({ to: "/cart" }), 2000);
          }
          return 0;
        }
        return t - 1;
      });
    }, 1000);

    // Polling
    const poll = async () => {
      if (doneRef.current || !session) return;

      setPhase("checking");
      setCheckCount((c) => c + 1);

      try {
        const result = await checkUpiPaymentStatus({
          data: {
            merchantOrderId: session.merchantOrderId,
            items:           session.items,
            address:         session.address,
          },
        });

        if (doneRef.current) return;

        if (result.status === "PAID" && "order_no" in result) {
          doneRef.current = true;
          clearInterval(cdTimer);
          clearInterval(pollTimer);
          setPhase("paid");
          sessionStorage.removeItem(UPI_SESSION_KEY);
          cart.clear();
          setTimeout(
            () =>
              navigate({
                to:     "/order-success",
                search: { o: result.order_no } as never,
              }),
            1500,
          );
          return;
        }

        if (!doneRef.current) setPhase("waiting");
      } catch {
        if (!doneRef.current) setPhase("waiting");
      }
    };

    poll();
    const pollTimer = setInterval(poll, 2000);

    return () => {
      clearInterval(cdTimer);
      clearInterval(pollTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const mins   = Math.floor(timeLeft / 60);
  const secs   = timeLeft % 60;
  const pad    = (n: number) => String(n).padStart(2, "0");
  const urgent = timeLeft > 0 && timeLeft <= 60;

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm space-y-5">

          {/* Header */}
          <div className="text-center">
            <h1 className="font-display text-2xl">Complete Your UPI Payment</h1>
            {session && (
              <p className="mt-1 text-sm text-muted-foreground">
                Amount:{" "}
                <strong className="text-foreground">{inr(session.amount)}</strong>
              </p>
            )}
          </div>

          {/* Countdown */}
          {timeLeft > 0 && (
            <div
              className={`flex items-center justify-center gap-2 border rounded px-4 py-2.5 text-sm font-medium ${
                urgent
                  ? "border-orange-300 bg-orange-50 text-orange-700"
                  : "border-blue-200 bg-blue-50 text-blue-700"
              }`}
            >
              <span>&#9200;</span>
              <span>Time remaining: {pad(mins)}:{pad(secs)}</span>
            </div>
          )}

          {/* QR Code */}
          {qrDataUrl ? (
            <div className="text-center space-y-2">
              <div className="inline-block p-3 border rounded-xl bg-white shadow-sm">
                <img
                  src={qrDataUrl}
                  alt="UPI QR Code"
                  width={220}
                  height={220}
                  draggable={false}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Scan with any UPI app to pay
              </p>
            </div>
          ) : (
            phase === "loading" && (
              <div className="mx-auto w-[220px] h-[220px] bg-muted animate-pulse rounded-xl" />
            )
          )}

          {/* Supported apps */}
          {session && (
            <p className="text-center text-sm text-muted-foreground">
              Google Pay &bull; PhonePe &bull; Paytm &bull; BHIM
            </p>
          )}

          {/* How to pay */}
          {session && (
            <div className="border rounded p-4 text-sm bg-muted/30 space-y-2">
              <p className="text-xs font-medium uppercase tracking-wider">
                How to pay:
              </p>
              <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                <li>Open Google Pay, PhonePe, Paytm or any UPI app.</li>
                <li>Scan the QR code above.</li>
                <li>Verify the amount and complete the payment.</li>
                <li>Your order will be confirmed automatically.</li>
              </ol>
            </div>
          )}

          {/* Status */}
          <StatusBadge phase={phase} checkCount={checkCount} />

          {/* Notice */}
          {(phase === "waiting" || phase === "checking") && (
            <div className="border-l-4 border-blue-500 pl-4 py-2 text-xs text-muted-foreground leading-relaxed">
              <strong>Important:</strong> Do not close or refresh this page.
              Your order will be confirmed automatically once payment is
              received.
            </div>
          )}

        </div>
      </main>
      <Footer />
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatusBadge
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<Phase, { icon: string; label: string; cls: string }> = {
  loading:  { icon: "⏳", label: "Loading payment data…",              cls: "border-muted bg-muted/40 text-muted-foreground" },
  waiting:  { icon: "⏳", label: "Waiting for payment…",               cls: "border-yellow-200 bg-yellow-50 text-yellow-800" },
  checking: { icon: "🔄", label: "Checking payment status…",           cls: "border-blue-200 bg-blue-50 text-blue-700" },
  paid:     { icon: "✅", label: "Payment successful! Redirecting…",   cls: "border-green-300 bg-green-50 text-green-700" },
  expired:  { icon: "❌", label: "Time expired. Redirecting to cart…", cls: "border-red-200 bg-red-50 text-red-600" },
  error:    { icon: "❌", label: "Session not found. Redirecting…",    cls: "border-red-200 bg-red-50 text-red-600" },
};

function StatusBadge({ phase, checkCount }: { phase: Phase; checkCount: number }) {
  const { icon, label, cls } = STATUS_CONFIG[phase];
  return (
    <div className={`flex items-center justify-center gap-2 border rounded px-4 py-3 text-sm transition-colors ${cls}`}>
      <span>{icon}</span>
      <span>
        {label}
        {phase === "checking" && checkCount > 0 ? ` (${checkCount})` : ""}
      </span>
    </div>
  );
}
