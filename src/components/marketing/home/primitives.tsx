"use client";

import { motion, type HTMLMotionProps } from "motion/react";

import { cn } from "@/lib/utils";

/**
 * Shared building blocks for the redesigned homepage. The whole page is
 * a dark, restrained surface: near-black ground, white type, one emerald
 * accent used sparingly. These primitives keep the rhythm consistent so
 * fourteen sections read as one system.
 */

const EASE = [0.22, 1, 0.36, 1] as const;

interface RevealProps extends HTMLMotionProps<"div"> {
  /** Seconds of delay before the reveal starts. */
  delay?: number;
  /** Vertical travel in px. Defaults to 18. */
  y?: number;
}

/**
 * Fade + rise the first time the element scrolls into view. `once` so it
 * never re-animates on scroll-back — nothing is more distracting than a
 * page that keeps flickering as you move through it.
 */
export function Reveal({
  className,
  delay = 0,
  y = 18,
  children,
  ...props
}: RevealProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -12% 0px" }}
      transition={{ duration: 0.55, delay, ease: EASE }}
      className={cn(className)}
      {...props}
    >
      {children}
    </motion.div>
  );
}

/** Small uppercase kicker with a live emerald dot. Anchors each section. */
export function Eyebrow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-[11.5px] font-medium uppercase tracking-[0.16em] text-white/45",
        className,
      )}
    >
      <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400/60" />
        <span className="relative inline-flex size-1.5 rounded-full bg-emerald-400" />
      </span>
      {children}
    </span>
  );
}

/** Section shell: id anchor + generous vertical rhythm + centered column. */
export function Section({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn(
        "relative mx-auto w-full max-w-[1140px] px-6 py-24 sm:py-28 lg:px-8",
        className,
      )}
    >
      {children}
    </section>
  );
}
