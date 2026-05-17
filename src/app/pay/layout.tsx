import Image from "next/image";

import { getBranding } from "@/server/services/branding.service";

import "../globals.css";

export const metadata = { title: "Rental Confirmation" };
export const dynamic = "force-dynamic";

export default async function PayLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const branding = await getBranding();
  return (
    <div className="min-h-svh bg-gradient-to-b from-slate-50 to-white">
      <header className="border-b border-slate-200/70 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <span className="flex items-center gap-2.5">
            {branding.logo ? (
              <Image
                src={branding.logo}
                alt={branding.brandName}
                width={28}
                height={28}
                unoptimized
                className="size-7 rounded-md object-contain"
              />
            ) : null}
            <span className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-700">
              {branding.brandName}
            </span>
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-6 py-12">{children}</main>
      <footer className="mx-auto max-w-3xl px-6 py-8 text-center text-xs text-slate-500">
        © {new Date().getFullYear()} {branding.brandName}. All rights
        reserved.
        {branding.footerTagline ? (
          <span className="mt-1 block text-slate-400">
            {branding.footerTagline}
          </span>
        ) : null}
      </footer>
    </div>
  );
}
