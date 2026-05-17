"use client";

import { motion, type HTMLMotionProps } from "motion/react";

import { cn } from "@/lib/utils";

interface FadeInProps extends HTMLMotionProps<"div"> {
  /** Delay in milliseconds. */
  delay?: number;
  /** Vertical translate distance in pixels. Defaults to 6. */
  y?: number;
}

/**
 * Subtle Stripe-style fade + tiny rise on mount. Use sparingly — apply to
 * page-level sections, not every element.
 */
export function FadeIn({
  className,
  delay = 0,
  y = 6,
  children,
  ...props
}: FadeInProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.32,
        delay: delay / 1000,
        ease: [0.22, 1, 0.36, 1],
      }}
      className={cn(className)}
      {...props}
    >
      {children}
    </motion.div>
  );
}

interface StaggerProps {
  className?: string;
  children: React.ReactNode;
  /** Per-child stagger in ms. */
  step?: number;
}

/**
 * Wrap a list so each child fades in with a tiny step. Use cautiously —
 * staggering more than 6-8 items feels slow.
 */
export function Stagger({ className, children, step = 60 }: StaggerProps) {
  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={{
        hidden: {},
        visible: { transition: { staggerChildren: step / 1000 } },
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export const StaggerItem = motion.div;
