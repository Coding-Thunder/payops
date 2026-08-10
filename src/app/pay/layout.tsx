import "../globals.css";

// Token-bound customer surface — never index. Single-use URLs, no
// SEO value, and `session_id` query params would otherwise leak into
// Google's index.
//
// The title is deliberately brand-neutral: this layout wraps both brands'
// return pages and cannot see which order the customer came back with.
export const metadata = {
  title: "Payment",
  robots: { index: false, follow: false, nocache: true },
};
export const dynamic = "force-dynamic";

/**
 * Shell only. The branded header/footer moved into the pages, which resolve
 * the organization from the `order` query param both gateways append to their
 * return URLs — see PublicBrandChrome.
 */
export default function PayLayout({
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
