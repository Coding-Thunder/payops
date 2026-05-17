/**
 * Email design tokens.
 *
 * Centralized so every email template draws from the same palette,
 * spacing rhythm, and type scale. Tokens are plain JS values (not CSS
 * variables) because most email clients strip <style> blocks — every
 * style we ship has to be inline.
 *
 * Aesthetic target: fintech-grade transactional email (Stripe, Mercury,
 * Ramp). Restrained, typographic, monochrome with a single muted
 * success accent.
 */

export const EMAIL_CONTAINER_MAX_WIDTH = 600;

export const COLOR = {
  // Surfaces
  page: "#f6f7f9",
  surface: "#ffffff",
  surfaceMuted: "#fafbfc",
  surfaceSubtle: "#f4f5f7",

  // Borders
  border: "#e5e7eb",
  borderSoft: "#eef0f3",

  // Text
  textPrimary: "#0f172a",
  textSecondary: "#475569",
  textMuted: "#6b7280",
  textFaint: "#94a3b8",
  textInverted: "#ffffff",

  // Accents (kept restrained — used sparingly)
  success: "#0e9f6e",
  successSoft: "#ecfdf5",
  successBorder: "#d1fae5",
} as const;

export const SPACE = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const RADIUS = {
  sm: 4,
  md: 6,
  lg: 8,
  xl: 10,
} as const;

export const FONT = {
  family:
    "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, Arial, sans-serif",
  mono: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
} as const;

export const TYPE = {
  // (size, lineHeight, weight) — kept small to mirror Stripe receipts
  display: { size: 24, line: 30, weight: 700, track: "-0.02em" },
  amount: { size: 30, line: 34, weight: 700, track: "-0.025em" },
  heading: { size: 16, line: 22, weight: 600, track: "-0.01em" },
  body: { size: 14, line: 22, weight: 400, track: "0" },
  bodyStrong: { size: 14, line: 22, weight: 600, track: "0" },
  label: { size: 12, line: 16, weight: 500, track: "0" },
  meta: { size: 13, line: 18, weight: 600, track: "0" },
  micro: { size: 11, line: 15, weight: 600, track: "0.10em" },
  legal: { size: 10, line: 15, weight: 400, track: "0" },
} as const;

/** Tiny helper so callers don't repeat the boilerplate. */
export function typeStyle(
  key: keyof typeof TYPE,
): {
  fontSize: number;
  lineHeight: string;
  fontWeight: number;
  letterSpacing: string;
} {
  const t = TYPE[key];
  return {
    fontSize: t.size,
    lineHeight: `${t.line}px`,
    fontWeight: t.weight,
    letterSpacing: t.track,
  };
}
