import Link from "next/link";

import { Reveal } from "@/components/marketing/home/primitives";

/**
 * Closing CTA.
 *
 * The one place on the page that goes dark. The whole site is light, so
 * inverting here makes the final ask read as a distinct surface rather than
 * one more section — and it is the only moment where that spend is worth it.
 *
 * Same two actions as the hero, same destinations. A closing CTA that offers
 * something the hero did not is a closing CTA that was hiding the real offer.
 */
export function FinalCta() {
  return (
    <section className="border-t border-[#E9EFF6] bg-white">
      <div className="mx-auto max-w-[1180px] px-6 py-20 sm:py-24 lg:px-8">
        <Reveal>
          <div className="overflow-hidden rounded-xl bg-[#0A1128] px-6 py-14 text-center sm:px-12">
            <h2
              className="mx-auto max-w-[24ch] font-display text-[28px] font-semibold leading-[1.15] tracking-[-0.025em] text-white sm:text-[36px]"
              style={{ textWrap: "balance" }}
            >
              Stop rebuilding client context every time you open an account.
            </h2>
            <p className="mx-auto mt-5 max-w-[58ch] text-[15.5px] leading-[1.6] text-white/70">
              Keep the client, the transaction, the correspondence, the files
              and the payment history connected — in one record that is still
              readable in a year.
            </p>

            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/waitlist"
                className="inline-flex h-11 items-center justify-center rounded-md bg-white px-5 text-[14px] font-semibold text-[#0A1128] transition-colors hover:bg-white/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                Join the beta
              </Link>
              <a
                href="#demo"
                className="inline-flex h-11 items-center justify-center rounded-md border border-white/20 px-5 text-[14px] font-semibold text-white transition-colors hover:border-white/40 hover:bg-white/5"
              >
                See the product
              </a>
            </div>

            <p className="mt-5 text-[12.5px] text-white/50">
              Free while TraceTxn is in private beta.
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
