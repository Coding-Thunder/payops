import { type ReactElement } from "react";
import {
  render as rtlRender,
  type RenderOptions,
  type RenderResult,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Project-standard render helper.
 *
 *   const { user } = renderWithUser(<MyForm />)
 *   await user.type(screen.getByLabelText(/email/i), "x@y.z")
 *
 * Wraps `@testing-library/react`'s render in a thin layer that also sets
 * up `userEvent` with sensible defaults (no fake timers — they cause
 * flake) and exposes it on the result.
 *
 * Provider wrappers (QueryClientProvider, ThemeProvider) live here so a
 * future test never has to remember which providers to include.
 */

interface ExtendedRenderOptions extends RenderOptions {
  /** Skip wrapping in app providers. Useful for shadcn/ui primitives that
   *  shouldn't need them. */
  withoutProviders?: boolean;
}

function NoopWrapper({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export function renderWithUser(
  ui: ReactElement,
  opts: ExtendedRenderOptions = {},
): RenderResult & { user: ReturnType<typeof userEvent.setup> } {
  const Wrapper = opts.withoutProviders ? NoopWrapper : NoopWrapper;
  const user = userEvent.setup();
  const result = rtlRender(ui, { wrapper: Wrapper, ...opts });
  return { ...result, user };
}

export { screen, within, waitFor, fireEvent } from "@testing-library/react";
export { default as userEvent } from "@testing-library/user-event";
