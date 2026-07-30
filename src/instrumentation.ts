/**
 * Next.js instrumentation hook — runs once when the server process boots.
 * The Node-only backstop lives in a separate module imported ONLY under the
 * Node.js runtime, so Turbopack never edge-compiles `process.on` (which the
 * Edge runtime doesn't support).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
