import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";

/**
 * Regression guard: the composer must not cancel its own context fetch.
 *
 * The bug (8f2d065): the effect that loads the compose context read
 * `loadingContext` in its guard AND listed it in its dependency array, then
 * called `setLoadingContext(true)` inside a requestAnimationFrame callback.
 * That state flip changed the deps, so React ran the effect cleanup, which set
 * `cancelled = true`. The in-flight response was then discarded by the
 * `cancelled` bails, and the `.finally` — guarded by `if (!cancelled)` — never
 * cleared the flag. The dialog was left with loadingContext stuck true,
 * context null and contextError null: a permanently disabled "Use template"
 * button that reported no error at all.
 *
 * Timing matters. With an already-resolved fetch the response lands before
 * React processes the state change and the bug hides, which is why this test
 * uses a DEFERRED promise and waits for the disabled/loading render before
 * resolving it.
 */

const apiGet = vi.fn();

vi.mock("@/lib/api-client", () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
  },
  ApiClientError: class ApiClientError extends Error {},
}));

vi.mock("@/hooks/use-idempotency-key", () => ({
  useIdempotencyKey: () => "test-idempotency-key",
}));

/**
 * The composer mounts AttachmentPicker and LinkPicker, which fetch through
 * react-query. Stub the whole module: this test is about the CONTEXT effect,
 * and a real query client would add unrelated async noise.
 */
const idleQuery = {
  data: undefined,
  isLoading: false,
  isError: false,
  error: null,
  refetch: vi.fn(),
};
vi.mock("@/hooks/use-client-resources", () => ({
  useClientFiles: () => idleQuery,
  useClientLinks: () => idleQuery,
  useInvalidateResources: () => vi.fn(),
  clientFilesKey: () => ["files"],
  clientLinksKey: () => ["links"],
}));

import { EmailComposerDialog } from "@/components/features/email-composer/email-composer-dialog";
import { renderWithUser } from "@/tests/utils/render";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const CONTEXT = {
  client: { id: "c1", name: "Jane Doe", email: "jane@abc.test", company: null },
  business: { name: "Acme Studio" },
  sender: { name: "Operator" },
  orders: [],
  templates: [
    {
      templateKey: "meeting-time",
      displayName: "Meeting Time",
      description: null,
      subject: "Call on {{meeting_date}}",
      body: "Hi {{client_name}}, can we talk at {{meeting_time}}?",
    },
  ],
};

async function open() {
  const { user } = renderWithUser(
    <EmailComposerDialog customerId="c1" defaultRecipient="jane@abc.test" />,
  );
  const [trigger] = screen.getAllByRole("button");
  await user.click(trigger);
  return user;
}

describe("email composer context loading", () => {
  beforeEach(() => {
    apiGet.mockReset();
  });

  it("enables 'Use template' after the context resolves, even when the loading render flushes first", async () => {
    const d = deferred<typeof CONTEXT>();
    apiGet.mockReturnValue(d.promise);

    await open();

    // The fetch is deferred a frame; it must actually be issued.
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));

    // Let the render caused by setLoadingContext(true) flush — the exact
    // window in which the old effect cancelled itself.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /use template/i }),
      ).toBeDisabled(),
    );

    d.resolve(CONTEXT);

    // Before the fix this response was discarded and the button stayed
    // disabled forever.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /use template/i }),
      ).toBeEnabled(),
    );

    // The effect must settle, not loop.
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it("surfaces a context failure instead of sitting silently disabled", async () => {
    // The old deadlock swallowed errors too: contextError stayed null because
    // the .catch bailed on `cancelled`, so a real 403 looked identical to
    // "still loading".
    const d = deferred<typeof CONTEXT>();
    apiGet.mockReturnValue(d.promise);

    await open();
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));

    d.reject(new Error("boom"));

    await waitFor(() =>
      expect(
        screen.getByText(/couldn't load this client's details/i),
      ).toBeInTheDocument(),
    );
  });
});
