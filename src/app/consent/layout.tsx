import "../globals.css";

// Token-bound consent surface — never index. The HMAC token in the
// path IS the credential; allowing this in any search index would be
// a security regression.
//
// Layout is chrome-only — same rationale as /pay/layout.tsx: layouts
// can't resolve per-tenant orgId from child route params cleanly, and
// the legacy {key:"default"} singleton would leak env-default brand
// to every tenant's customers. The page under /consent/[token] reads
// the order's orgId via the token and renders its own tenant-branded
// header inside this chrome.
export const metadata = {
  title: "Confirm your booking",
  robots: { index: false, follow: false, nocache: true },
};
export const dynamic = "force-dynamic";

export default function ConsentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-svh bg-gradient-to-b from-slate-50 to-white">
      <main className="mx-auto max-w-2xl px-6 py-10 sm:py-12">{children}</main>
    </div>
  );
}
