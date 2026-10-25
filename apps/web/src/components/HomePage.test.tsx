import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import { CODEWORD_WORD_COUNT, deriveCodewords } from "@e2ee-drop/shared";

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

  // Issue #2: a browser-key link shows its real server-side status, read from
  // GET /api/links/:slug, instead of always "Waiting for file".
  it("shows the real status of this browser's links (file ready / expired)", async () => {
    const now = Date.now();
    window.localStorage.setItem(
      "e2ee-drop:links",
      JSON.stringify({
        ready1: { privateKey: "c2VjcmV0", createdAt: now, expiresAt: now + 60_000 },
        gone22: { privateKey: "c2VjcmV0", createdAt: now - 1, expiresAt: now + 60_000 },
      })
    );
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/links/ready1") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ drop: { fileUploadStatus: "complete", deliveryStatus: "sent" } }),
        });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderHome();

    const readyRow = screen.getByRole("link", { name: /ready1/ });
    const goneRow = screen.getByRole("link", { name: /gone22/ });
    await waitFor(() => expect(readyRow).toHaveTextContent("File ready"));
    await waitFor(() => expect(goneRow).toHaveTextContent("Expired"));
    expect(fetchMock).toHaveBeenCalledWith("/api/links/ready1");
    vi.unstubAllGlobals();
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

  it("merges account and browser links into one list, filterable by where the key lives", async () => {
    renderHome();

    await waitFor(() => expect(screen.getByText("verifieduser")).toBeInTheDocument());
    expect(screen.getByText("localslug")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(screen.getByText("verifieduser")).toBeInTheDocument();
    expect(screen.queryByText("localslug")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "This browser" }));
    expect(screen.queryByText("verifieduser")).not.toBeInTheDocument();
    expect(screen.getByText("localslug")).toBeInTheDocument();
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

// Review finding F1: the dashboard is a new owner-facing surface for a
// link's verification phrase. It must derive the words locally from the
// account's own key, and only for links whose recipient IS the account —
// never for a sender-initiated request link, whose recipient key belongs to
// the claimant (or doesn't exist yet).
describe("HomePage dashboard verification words", () => {
  const keyPair = nacl.box.keyPair();
  const ownKey = encodeBase64(keyPair.publicKey);
  const baseLink = { mode: "permanent", visibility: "public", createdAt: 1, retentionDays: 7, codewordLocale: "en" };

  beforeEach(() => {
    window.localStorage.clear();
    authState.user = {
      id: "u1",
      username: "owner",
      emailVerified: true,
      // Server-reported key deliberately differs from the local key pair:
      // the locally unwrapped key must be the one used.
      publicKey: encodeBase64(nacl.box.keyPair().publicKey),
      keyPair,
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
              { ...baseLink, linkId: "default-id", slug: "owner", isDefault: true, recipientIsOwner: true },
              { ...baseLink, linkId: "custom-id", slug: "owner-custom", isDefault: false, recipientIsOwner: true },
              { ...baseLink, linkId: "request-id", slug: "req-claimed", isDefault: false, recipientIsOwner: false },
              { ...baseLink, linkId: "request2-id", slug: "req-unclaimed", isDefault: false, recipientIsOwner: false },
            ],
          }),
        });
      })
    );
  });

  it("shows each owner-recipient link's phrase derived locally from the account's own key pair", async () => {
    const defaultWords = await deriveCodewords(ownKey, "default-id", "en", CODEWORD_WORD_COUNT);
    const customWords = await deriveCodewords(ownKey, "custom-id", "en", CODEWORD_WORD_COUNT);

    renderHome();

    await waitFor(() => {
      expect(screen.getByTestId("codewords-owner")).toHaveTextContent(defaultWords.join(" · "));
    });
    expect(screen.getByTestId("codewords-owner-custom")).toHaveTextContent(customWords.join(" · "));
  });

  it("shows NO phrase for a sender-initiated request link, claimed or not", async () => {
    // What a naive "derive from the owner's key for every row" would show —
    // a phrase for the wrong key, since the claimant holds this link's key.
    const misleading = await deriveCodewords(ownKey, "request-id", "en", CODEWORD_WORD_COUNT);

    renderHome();

    await waitFor(() => expect(screen.getByTestId("codewords-owner")).toBeInTheDocument());
    expect(screen.getByText("req-claimed")).toBeInTheDocument();
    expect(screen.queryByTestId("codewords-req-claimed")).not.toBeInTheDocument();
    expect(screen.queryByTestId("codewords-req-unclaimed")).not.toBeInTheDocument();
    expect(screen.queryByText(new RegExp(misleading.join(" · ")))).not.toBeInTheDocument();
  });
});

// Review finding F1 (fix): a cookie-restored session — every reload, new tab
// or later visit — has keyPair null. The dashboard must not fall back to the
// server-reported user.publicKey; it shows a re-login hint and no phrase.
describe("HomePage dashboard verification words without an unlocked key pair", () => {
  const serverReportedKey = encodeBase64(nacl.box.keyPair().publicKey);
  const baseLink = { mode: "permanent", visibility: "public", createdAt: 1, retentionDays: 7, codewordLocale: "en" };

  function stubLinks(links: unknown[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/inbox") {
          return Promise.resolve({ ok: true, json: async () => ({ counterparties: [] }) });
        }
        return Promise.resolve({ ok: true, json: async () => ({ links }) });
      })
    );
  }

  beforeEach(() => {
    window.localStorage.clear();
    authState.user = { id: "u1", username: "owner", emailVerified: true, publicKey: serverReportedKey, keyPair: null };
  });

  it("shows a re-login hint and no phrase derived from the server-reported publicKey", async () => {
    stubLinks([{ ...baseLink, linkId: "default-id", slug: "owner", isDefault: true, recipientIsOwner: true }]);
    const fromServerKey = await deriveCodewords(serverReportedKey, "default-id", "en", CODEWORD_WORD_COUNT);

    renderHome();

    await waitFor(() => expect(screen.getByTestId("codewords-relogin")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /log in again/i })).toHaveAttribute("href", "/login");
    expect(screen.getByText("owner")).toBeInTheDocument();
    expect(screen.queryByTestId("codewords-owner")).not.toBeInTheDocument();
    expect(screen.queryByText(new RegExp(fromServerKey.join(" · ")))).not.toBeInTheDocument();
  });

  it("shows no re-login hint when there are only request links (nothing to show a phrase for anyway)", async () => {
    stubLinks([{ ...baseLink, linkId: "request-id", slug: "req-claimed", isDefault: false, recipientIsOwner: false }]);

    renderHome();

    await waitFor(() => expect(screen.getByText("req-claimed")).toBeInTheDocument());
    expect(screen.queryByTestId("codewords-relogin")).not.toBeInTheDocument();
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
