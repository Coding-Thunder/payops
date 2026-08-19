import type { Metadata } from "next";

import "./console.css";

/**
 * Platform super-admin console — subtree layout.
 *
 * This file used to be the console's ROOT layout (its own Next app served at
 * `/`), so it rendered `<html>`/`<body>` and imported the console's global
 * stylesheet. Mounted at `/admin` inside the main app it is a NESTED layout:
 * `src/app/layout.tsx` owns the document, and a nested layout may not emit
 * `<html>`/`<body>`.
 *
 * What replaces them:
 *   - the document shell comes from the root layout (fonts, providers);
 *   - the console's own look is re-established by `console.css`, which scopes
 *     every rule to the `data-console="admin"` wrapper below so that (a) the
 *     console keeps its dark palette even though the root `<body>` is light,
 *     and (b) not a single console declaration can reach the tenant app or
 *     the marketing site.
 */
export const metadata: Metadata = {
  // `absolute` is required: the root layout sets `title.template` to
  // "%s • TraceTxn", which would otherwise render "TraceTxn Admin • TraceTxn".
  title: { absolute: "TraceTxn Admin" },
  description: "Platform super-admin console",
  robots: { index: false, follow: false },
};

export default function AdminConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div data-console="admin">{children}</div>;
}
