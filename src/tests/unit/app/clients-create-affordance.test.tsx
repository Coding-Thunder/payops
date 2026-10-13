import { describe, expect, it, vi, beforeEach } from "vitest";

import { Permission } from "@/lib/constants/permissions";
import { renderWithUser, screen, waitFor, within } from "@/tests/utils/render";

/**
 * Creating a client from /app/customers.
 *
 * The journey audit found the roster was read-only: `NewClientDialog` was
 * mounted on the dashboard and nowhere else, so a user who navigated to
 * Clients in order to add one had to leave the page to do it. The page now
 * renders the SAME dialog in its header — not a second create form, which
 * would be a second set of validation rules to drift.
 *
 * Two things here are authorization, not cosmetics, and both are asserted:
 *
 *   - the page is still gated on CUSTOMER_VIEW, before any data read;
 *   - the button is gated on CUSTOMER_MANAGE, which is what
 *     `POST /api/customers` requires. Rendering it for view-only staff would
 *     hand them a control that 403s.
 *
 * `listClients` is mocked, so no database is touched; the assertions on its
 * arguments double as the tenant-scoping and filter/pagination guard — the
 * orgId must come from the session, never from the query string.
 *
 * The page is an async server component: awaiting it yields the element tree,
 * whose children are client components that render fine under jsdom.
 */

const requirePermission = vi.fn();
const listClients = vi.fn();
const push = vi.fn();
const apiPost = vi.fn();

vi.mock("@/server/auth/session", () => ({
  requirePermission: (p: unknown) => requirePermission(p),
}));

vi.mock("@/server/services/client-profile.service", () => ({
  listClients: (orgId: unknown, query: unknown) => listClients(orgId, query),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/app/customers",
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    api: {
      get: vi.fn(),
      post: (path: string, body: unknown) => apiPost(path, body),
      patch: vi.fn(),
      del: vi.fn(),
    },
  };
});

function userWith(permissions: Permission[]) {
  return {
    id: "u1",
    name: "Ada",
    email: "ada@tracetxn.test",
    role: "ADMIN",
    workspaceRole: "OWNER",
    permissions: new Set(permissions),
    orgId: "org_a",
    orgIds: ["org_a"],
    impersonation: null,
  };
}

const EMPTY = { items: [], total: 0, page: 1, pageSize: 25, totalPages: 0 };

async function renderClientsPage(
  permissions: Permission[],
  sp: Record<string, string> = {},
) {
  const { default: ClientsPage } = await import("@/app/app/customers/page");
  requirePermission.mockResolvedValue(userWith(permissions));
  listClients.mockResolvedValue(EMPTY);
  const element = await ClientsPage({ searchParams: Promise.resolve(sp) });
  return renderWithUser(element);
}

describe("/app/customers — create affordance", () => {
  beforeEach(() => {
    requirePermission.mockReset();
    listClients.mockReset();
    push.mockReset();
    apiPost.mockReset();
  });

  it("gates the page on CUSTOMER_VIEW before reading any data", async () => {
    await renderClientsPage([Permission.CUSTOMER_VIEW]);

    expect(requirePermission).toHaveBeenCalledWith(Permission.CUSTOMER_VIEW);
    // Ordering matters: an App Router layout redirect does not stop a page
    // rendering, so the permission check has to precede the query.
    expect(requirePermission.mock.invocationCallOrder[0]).toBeLessThan(
      listClients.mock.invocationCallOrder[0],
    );
  });

  it("scopes the query to the session's org and keeps filters + paging", async () => {
    await renderClientsPage([Permission.CUSTOMER_VIEW], {
      q: "bloom",
      sort: "name",
      page: "3",
    });

    expect(listClients).toHaveBeenCalledWith("org_a", {
      search: "bloom",
      sort: "name",
      page: 3,
    });
  });

  it("offers New Client Record to a user who can manage clients", async () => {
    await renderClientsPage([
      Permission.CUSTOMER_VIEW,
      Permission.CUSTOMER_MANAGE,
    ]);

    expect(
      screen.getByRole("button", { name: /new client record/i }),
    ).toBeInTheDocument();
  });

  it("hides it from view-only staff, because the POST would 403", async () => {
    await renderClientsPage([Permission.CUSTOMER_VIEW]);

    expect(
      screen.queryByRole("button", { name: /new client record/i }),
    ).not.toBeInTheDocument();
    // The roster itself is unaffected — this is still a usable page.
    expect(
      screen.getByRole("heading", { name: /clients/i }),
    ).toBeInTheDocument();
  });

  it("creates a client and opens the new record", async () => {
    const { user } = await renderClientsPage([
      Permission.CUSTOMER_VIEW,
      Permission.CUSTOMER_MANAGE,
    ]);
    apiPost.mockResolvedValue({ id: "cl_9", existed: false });

    await user.click(screen.getByRole("button", { name: /new client record/i }));

    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/client name/i), "Sarah Chen");
    await user.type(
      within(dialog).getByLabelText(/^email$/i),
      "sarah@bloomstudio.co",
    );
    await user.click(within(dialog).getByRole("button", { name: /create record/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost.mock.calls[0][0]).toBe("/api/customers");
    expect(apiPost.mock.calls[0][1]).toMatchObject({
      name: "Sarah Chen",
      email: "sarah@bloomstudio.co",
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/app/customers/cl_9"));
  });

  it("requires a name before it will POST", async () => {
    const { user } = await renderClientsPage([
      Permission.CUSTOMER_VIEW,
      Permission.CUSTOMER_MANAGE,
    ]);

    await user.click(screen.getByRole("button", { name: /new client record/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /create record/i }));

    expect(
      await within(dialog).findByText(/client name is required/i),
    ).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and shows the reason when the API refuses", async () => {
    const { ApiClientError } = await import("@/lib/api-client");
    const { user } = await renderClientsPage([
      Permission.CUSTOMER_VIEW,
      Permission.CUSTOMER_MANAGE,
    ]);
    apiPost.mockRejectedValue(
      new ApiClientError(403, { code: "FORBIDDEN", message: "Not allowed" }),
    );

    await user.click(screen.getByRole("button", { name: /new client record/i }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/client name/i), "Sarah Chen");
    await user.click(within(dialog).getByRole("button", { name: /create record/i }));

    expect(await within(dialog).findByText(/not allowed/i)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});
