"use client";

import * as React from "react";

/**
 * Marketing-page motion controller.
 *
 * Five flavours of choreography, all keyed off `data-*` attributes
 * on the markup so sections stay declarative:
 *
 *   1. Reveal-on-scroll for `[data-reveal]`. Above-the-fold elements
 *      animate in IMMEDIATELY (no ScrollTrigger) so the hero never
 *      starts blank. Below-the-fold elements wait for ScrollTrigger.
 *   2. Parallax drift for `[data-parallax]`.
 *   3. Count-up animation for `[data-counter]`.
 *   4. Theme-tinted nav: body `data-active-theme` reflects the
 *      currently-anchored themed section.
 *   5. Fail-safe: any `[data-reveal]` element still at opacity 0
 *      after 1.5s is force-shown — protects against script-load
 *      failures, hydration races, and offline asset bundles.
 *
 * All scroll-driven motion respects `prefers-reduced-motion`.
 */
export function GsapController() {
  React.useEffect(() => {
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let cleanup: (() => void) | undefined;
    let cancelled = false;

    // ── Fail-safe: after 1.5s, any reveal element still hidden gets
    // force-shown. Guards against GSAP failing to load (offline,
    // CSP block, chunk error). Cleared if GSAP runs to completion.
    const failSafe = window.setTimeout(() => {
      document
        .querySelectorAll<HTMLElement>("[data-reveal]")
        .forEach((el) => {
          if (Number(getComputedStyle(el).opacity) < 0.98) {
            el.style.opacity = "1";
            el.style.transform = "none";
            el.style.filter = "none";
          }
        });
    }, 1500);

    (async () => {
      try {
        const [{ gsap }, { ScrollTrigger }] = await Promise.all([
          import("gsap"),
          import("gsap/ScrollTrigger"),
        ]);
        if (cancelled) return;

        gsap.registerPlugin(ScrollTrigger);

        const ctx = gsap.context(() => {
          // ─── 1. Reveal on scroll ────────────────────────────────
          const reveals = gsap.utils.toArray<HTMLElement>("[data-reveal]");
          const viewportH = window.innerHeight;

          reveals.forEach((el) => {
            const order = Number(el.dataset.revealOrder ?? "0");
            const rect = el.getBoundingClientRect();
            // Above-the-fold = element is already visible (or partially)
            // when the page first paints. Animate immediately so the
            // hero never starts blank, regardless of ScrollTrigger's
            // start-position math.
            const aboveFold = rect.top < viewportH * 0.95;

            const fromVars = {
              opacity: 0,
              y: reducedMotion ? 0 : 26,
              filter: reducedMotion ? "none" : "blur(8px)",
            };
            const toVars = {
              opacity: 1,
              y: 0,
              filter: "blur(0px)",
              duration: reducedMotion ? 0.01 : 0.9,
              delay: reducedMotion ? 0 : order * 0.08,
              ease: "expo.out",
            };

            if (aboveFold) {
              gsap.fromTo(el, fromVars, toVars);
            } else {
              gsap.fromTo(el, fromVars, {
                ...toVars,
                scrollTrigger: {
                  trigger: el,
                  start: "top 88%",
                  once: true,
                },
              });
            }
          });

          // ─── 2. Parallax ──────────────────────────────────────
          if (!reducedMotion) {
            const parallaxItems = gsap.utils.toArray<HTMLElement>(
              "[data-parallax]",
            );
            parallaxItems.forEach((el) => {
              const intensity = Number(el.dataset.parallax ?? "0.15");
              gsap.to(el, {
                yPercent: -intensity * 100,
                ease: "none",
                scrollTrigger: {
                  trigger: el,
                  start: "top bottom",
                  end: "bottom top",
                  scrub: 0.6,
                },
              });
            });
          }

          // ─── 3. Count-up counters ─────────────────────────────
          const counters = gsap.utils.toArray<HTMLElement>("[data-counter]");
          counters.forEach((el) => {
            const target = Number(el.dataset.counter ?? "0");
            const suffix = el.dataset.counterSuffix ?? "";
            const obj = { v: 0 };
            gsap.to(obj, {
              v: target,
              duration: reducedMotion ? 0.01 : 1.6,
              ease: "expo.out",
              scrollTrigger: {
                trigger: el,
                start: "top 80%",
                once: true,
              },
              onUpdate: () => {
                el.textContent = `${Math.round(obj.v)}${suffix}`;
              },
            });
          });

          ScrollTrigger.refresh();
        });

        // GSAP ran end-to-end — kill the fail-safe.
        window.clearTimeout(failSafe);

        cleanup = () => ctx.revert();
      } catch (err) {
        // Dynamic import failed (offline, CSP, network). Fail-safe
        // already running will reveal stuck elements at 1.5s.
        if (process.env.NODE_ENV !== "production") {
          console.warn("[GsapController] init failed:", err);
        }
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(failSafe);
      cleanup?.();
    };
  }, []);

  // ── 4. Theme-tinted nav ───────────────────────────────────────
  // The active theme MUST match the section physically behind the
  // nav (top of viewport), not whatever's in the middle. Using an
  // IntersectionObserver with a viewport-middle band creates a
  // mismatch during section transitions (nav can briefly be in
  // "dark" mode while a light section is what's actually behind it,
  // making white-on-white nav text invisible). A direct scroll
  // listener throttled to one rAF tick is cheaper AND accurate.
  React.useEffect(() => {
    const sections = Array.from(
      document.querySelectorAll<HTMLElement>("section[data-theme]"),
    );
    if (sections.length === 0) return;

    const NAV_PROBE_Y = 12; // a few px below the nav's bottom edge

    const setActive = (theme: string | null) => {
      if (theme) {
        if (document.body.dataset.activeTheme !== theme) {
          document.body.dataset.activeTheme = theme;
        }
      } else {
        delete document.body.dataset.activeTheme;
      }
    };

    let rafId = 0;
    const tick = () => {
      rafId = 0;
      // Find the section that currently contains the probe Y. With
      // sections rendered in document order and non-overlapping, the
      // last one whose top <= probe is the active one.
      let active: string | null = null;
      for (const s of sections) {
        const r = s.getBoundingClientRect();
        if (r.top <= NAV_PROBE_Y && r.bottom > NAV_PROBE_Y) {
          active = s.getAttribute("data-theme");
          break;
        }
      }
      // Fallbacks: above the first section → use first; below the
      // last → use last. Never leave the nav theme-less.
      if (!active) {
        const firstRect = sections[0].getBoundingClientRect();
        if (firstRect.top > NAV_PROBE_Y) {
          active = sections[0].getAttribute("data-theme");
        } else {
          active = sections[sections.length - 1].getAttribute("data-theme");
        }
      }
      setActive(active);
    };

    const onScroll = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(tick);
    };

    tick(); // initial paint
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, []);

  return null;
}
