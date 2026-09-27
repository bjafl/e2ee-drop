import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

interface MockUser {
  id: string;
  username: string;
  name?: string;
  email?: string;
  emailVerified?: boolean;
  publicKey?: string;
  totpEnabled?: boolean;
  keyPair?: unknown;
}

const authState: { user: MockUser | null } = { user: null };
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: authState.user, loading: false, login: vi.fn(), logout: vi.fn(), register: vi.fn() }),
}));

import { HomePage } from "./HomePage";

function renderHome() {
  return render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>
  );
}

describe("HomePage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    authState.user = null;
  });

  it("lists this browser's unexpired links so the recipient can get back to their download page", () => {
    const now = Date.now();
    window.localStorage.setItem(
      "e2ee-drop:links",
      JSON.stringify({
        abc123: { privateKey: "c2VjcmV0", createdAt: now, expiresAt: now + 60_000 },
        old999: { privateKey: "c2VjcmV0", createdAt: now - 120_000, expiresAt: now - 60_000 },
      })
    );

    renderHome();

    expect(screen.getByRole("link", { name: /abc123/ })).toHaveAttribute("href", "/receive/abc123");
    expect(screen.queryByText(/old999/)).not.toBeInTheDocument();
  });

  it("shows no link list when this browser has no stored links", () => {
    renderHome();

    expect(screen.queryByText(/your links/i)).not.toBeInTheDocument();
  });

  it("shows a link to the account page when logged in", () => {
    authState.user = { id: "u1", username: "alice" };

    renderHome();

    expect(screen.getByRole("link", { name: /my account/i })).toHaveAttribute("href", "/account");
  });

  it("shows no account link when logged out", () => {
    renderHome();

    expect(screen.queryByRole("link", { name: /my account/i })).not.toBeInTheDocument();
  });
});

describe("HomePage dashboard branch", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // A local (anonymous-browser) link so the "still renders the anonymous
    // local-links section" test below has something to assert on — the
    // dashboard branch must not swallow this pre-existing block.
    const now = Date.now();
    window.localStorage.setItem(
      "e2ee-drop:links",
      JSON.stringify({
        localslug: { privateKey: "c2VjcmV0", createdAt: now, expiresAt: now + 60_000 },
      })
    );
    authState.user = {
      id: "u1",
      username: "verifieduser",
      name: "Verified User",
      email: "v@example.com",
      emailVerified: true,
      publicKey: "x",
      totpEnabled: false,
      keyPair: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/inbox") {
          return Promise.resolve({ ok: true, json: async () => ({ counterparties: [] }) });
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            links: [
              { slug: "verifieduser", mode: "permanent", visibility: "public", isDefault: true, createdAt: 1, retentionDays: 7 },
            ],
          }),
        });
      })
    );
  });

  it("shows the active-links dashboard section for a verified user instead of the generic landing content", async () => {
    renderHome();

    await waitFor(() => expect(screen.getByTestId("dashboard-active-links")).toBeInTheDocument());
    expect(screen.getByText("verifieduser")).toBeInTheDocument();
  });

  it("still renders the anonymous local-links section as its own block for a verified user", async () => {
    renderHome();

    await waitFor(() => expect(screen.getByTestId("dashboard-active-links")).toBeInTheDocument());
    expect(screen.getByTestId("anonymous-links-section")).toBeInTheDocument();
  });

  it("shows the pending-receipts section with an incoming counterparty from GET /api/inbox", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/inbox") {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              counterparties: [
                {
                  key: "incoming:account:2",
                  kind: "account",
                  displayName: "waitingsender",
                  direction: "incoming",
                  drops: [
                    { id: "d1", linkSlug: "s", deliveryStatus: "sent", messageEnvelopeStatus: "sealed", fileEnvelopeStatus: "sealed", hasMessage: false, createdAt: 1 },
                  ],
                },
              ],
            }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({ links: [] }) });
      })
    );

    renderHome();

    await waitFor(() => expect(screen.getByTestId("dashboard-pending-receipts")).toBeInTheDocument());
    expect(screen.getByText("waitingsender")).toBeInTheDocument();
  });

  it("shows the empty-state message when the inbox has no incoming counterparties", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/inbox") {
          return Promise.resolve({ ok: true, json: async () => ({ counterparties: [] }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({ links: [] }) });
      })
    );

    renderHome();

    await waitFor(() => expect(screen.getByTestId("dashboard-pending-receipts")).toBeInTheDocument());
    expect(screen.getByText("You have no pending receipts.")).toBeInTheDocument();
  });
});

describe("HomePage generic landing (unchanged)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("shows the generic landing content, not the dashboard, for an unverified logged-in user", () => {
    authState.user = {
      id: "u2",
      username: "unverified",
      name: "Unverified",
      email: "u@example.com",
      emailVerified: false,
      publicKey: "x",
      totpEnabled: false,
      keyPair: null,
    };

    renderHome();

    expect(screen.queryByTestId("dashboard-active-links")).not.toBeInTheDocument();
  });
});
