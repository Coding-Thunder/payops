import "../globals.css";

// Token-bound consent surface — never index. The HMAC token in the
// path IS the credential; allowing this in any search index would be
// a security regression.
export const metadata = {
  title: "Confirm your booking",
  robots: { index: false, follow: false, nocache: true },
};
export const dynamic = "force-dynamic";

/**
 * Public, unauthenticated shell for the hosted consent flow. Only the page
 * background lives here: the branded header and footer moved into the page,
 * which can resolve the booking's organization from its token. A layout
 * cannot, so anything branded rendered at this level was necessarily the
 * deployment default — the wrong brand for every tenant but one.
 */
export default function ConsentLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-svh bg-gradient-to-b from-slate-50 to-white">
      {children}
    </div>
  );
}
