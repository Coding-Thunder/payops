import { env } from "@/lib/env";

import "../globals.css";

export const metadata = { title: "Rental Confirmation" };

export default function PayLayout({ children }: { children: React.ReactNode }) {
  const brand = env.server.CUSTOMER_BRAND_NAME;
  return (
    <div className="min-h-svh bg-gradient-to-b from-slate-50 to-white">
      <header className="border-b border-slate-200/70 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <span className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-700">
            {brand}
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-6 py-12">{children}</main>
      <footer className="mx-auto max-w-3xl px-6 py-8 text-center text-xs text-slate-500">
        © {new Date().getFullYear()} {brand}. All rights reserved.
      </footer>
    </div>
  );
}
