import Image from "next/image";

import type { PublicBrand } from "@/server/email/identity";

/**
 * Header + footer for the public, token-bound customer pages (/consent,
 * /pay/*, /acknowledge).
 *
 * This lives in a component rather than in the route layouts because a layout
 * cannot see `params` or `searchParams`, and the brand can only be resolved
 * from the token or the `order` query param that identifies which booking —
 * and therefore which organization — the customer arrived with. While the
 * chrome was rendered by the layout it had no choice but to read the
 * deployment Branding singleton, so every tenant's customer was shown the
 * incumbent brand's name, logo and copyright.
 */
export function PublicBrandChrome({
  brand,
  eyebrow,
  children,
}: {
  brand: Pick<PublicBrand, "brandName" | "logo" | "footerTagline">;
  /** Small right-aligned label, e.g. "Secure confirmation". */
  eyebrow?: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <header className="border-b border-slate-200/70 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <span className="flex items-center gap-2.5">
            {brand.logo ? (
              <Image
                src={brand.logo}
                alt={brand.brandName}
                width={28}
                height={28}
                unoptimized
                className="size-7 rounded-md object-contain"
              />
            ) : null}
            <span className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-700">
              {brand.brandName}
            </span>
          </span>
          {eyebrow ? (
            <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-slate-400">
              {eyebrow}
            </span>
          ) : null}
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-6 py-10 sm:py-12">{children}</main>
      <footer className="mx-auto max-w-3xl px-6 py-8 text-center text-xs text-slate-500">
        © {new Date().getFullYear()} {brand.brandName}. All rights reserved.
        {brand.footerTagline ? (
          <span className="mt-1 block text-slate-400">
            {brand.footerTagline}
          </span>
        ) : null}
      </footer>
    </>
  );
}
