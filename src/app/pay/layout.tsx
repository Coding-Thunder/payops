import "../globals.css";

// Token-bound customer surface, never index. Single-use URLs, no
// SEO value, and `session_id` query params would otherwise leak into
// Google's index.
//
// Layout is intentionally chrome-only (background + container), NO
// per-tenant brand at the layout level. Layouts can't see child route
// params in App Router without hacky `headers()` reads, and serving the
// legacy {key:"default"} singleton's env-default brand would leak the
// wrong identity to every tenant's customers. Pages under /pay/* that
// know the order's orgId (e.g. pay/success via the order param) render
// their own tenant-branded header in their content. Pages without
// order context (/pay/cancelled) show generic platform copy.
export const metadata = {
  title: "Payment",
  robots: { index: false, follow: false, nocache: true },
};
export const dynamic = "force-dynamic";

export default function PayLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-svh bg-gradient-to-b from-slate-50 to-white">
      <main className="mx-auto max-w-2xl px-6 py-12">{children}</main>
    </div>
  );
}
