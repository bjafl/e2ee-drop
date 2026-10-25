import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import nacl from "tweetnacl";
import { encodeBase64 } from "tweetnacl-util";
import { CODEWORD_WORD_COUNT, deriveCodewords } from "@e2ee-drop/shared";

const { authState } = vi.hoisted(() => ({
  authState: { user: null as null | { publicKey: string; keyPair: unknown } },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: authState.user, loading: false }),
}));

import { NewLinkPage } from "./NewLinkPage";

// NewLinkPage now renders a router <Link> (the re-login hint).
function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter>{ui}</MemoryRouter>);
}

// Deliberately unrelated to any key: the page must never display this
// server-supplied field (finding F1).
const API_CODEWORDS = ["fox", "river", "lamp", "otter"];

describe("NewLinkPage", () => {
  beforeEach(() => {
    authState.user = null;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ linkId: "l1", slug: "team-drop", codewords: API_CODEWORDS, codewordLocale: "en" }),
      })
    );
  });

  // Review finding F1: new owner-facing surface. /api/links/custom always
  // makes a link whose recipient is this account, so its phrase is derived
  // from the account's own locally unwrapped key pair — not the API's words.
  it("shows the new link's verification words, derived locally from the account's own key pair", async () => {
    const keyPair = nacl.box.keyPair();
    // user.publicKey (server-reported) deliberately differs from the local
    // key pair: the local key must win.
    authState.user = { publicKey: encodeBase64(nacl.box.keyPair().publicKey), keyPair };
    const expected = await deriveCodewords(encodeBase64(keyPair.publicKey), "l1", "en", CODEWORD_WORD_COUNT);
    expect(expected).not.toEqual(API_CODEWORDS);

    render(<NewLinkPage />);
    fireEvent.change(screen.getByLabelText(/link name/i), { target: { value: "team-drop" } });
    fireEvent.click(screen.getByText(/create link/i));

    await waitFor(() => {
      expect(screen.getByTestId("codewords")).toHaveTextContent(expected.join(" · "));
    });
    expect(screen.getByTestId("codewords").textContent!.split(" · ")).toHaveLength(CODEWORD_WORD_COUNT);
    expect(screen.queryByText(/fox · river/)).not.toBeInTheDocument();
  });

  // A restored session (reload, new tab) has no unwrapped key pair. The
  // server-reported user.publicKey must NOT be used as a substitute: a DB
  // attacker who rewrote it and the link's key together would otherwise get
  // matching wrong words on both sides (finding F1). Show a re-login hint.
  it("shows a re-login hint and NO phrase when this tab has no unlocked key pair", async () => {
    const publicKey = encodeBase64(nacl.box.keyPair().publicKey);
    authState.user = { publicKey, keyPair: null };
    const fromServerKey = await deriveCodewords(publicKey, "l1", "en", CODEWORD_WORD_COUNT);

    render(<NewLinkPage />);
    fireEvent.change(screen.getByLabelText(/link name/i), { target: { value: "team-drop" } });
    fireEvent.click(screen.getByText(/create link/i));

    await waitFor(() => {
      expect(screen.getByTestId("codewords-relogin")).toBeInTheDocument();
    });
    expect(screen.getByRole("link", { name: /log in again/i })).toHaveAttribute("href", "/login");
    expect(screen.queryByTestId("codewords")).not.toBeInTheDocument();
    expect(screen.queryByText(new RegExp(fromServerKey.join(" · ")))).not.toBeInTheDocument();
    expect(screen.queryByText(/fox · river/)).not.toBeInTheDocument();
  });

  it("submits the form and shows the created link", async () => {
    render(<NewLinkPage />);

    fireEvent.change(screen.getByLabelText(/link name/i), { target: { value: "team-drop" } });
    fireEvent.click(screen.getByText(/create link/i));

    await waitFor(() => {
      expect(screen.getByText(/team-drop/)).toBeInTheDocument();
    });
  });

  it("sends the owner note and retention days entered in the form", async () => {
    render(<NewLinkPage />);

    fireEvent.change(screen.getByLabelText(/link name/i), { target: { value: "team-drop" } });
    fireEvent.change(screen.getByLabelText(/note for the sender/i), {
      target: { value: "For the design team" },
    });
    fireEvent.change(screen.getByLabelText(/delete received files after/i), { target: { value: "5" } });
    fireEvent.click(screen.getByText(/create link/i));

    await waitFor(() => {
      expect(window.fetch).toHaveBeenCalledWith(
        "/api/links/custom",
        expect.objectContaining({
          body: expect.stringContaining('"ownerNote":"For the design team"'),
        })
      );
    });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(body.retentionDays).toBe(5);
  });

  it("omits owner note, and retention days, when both are explicitly cleared", async () => {
    render(<NewLinkPage />);

    fireEvent.change(screen.getByLabelText(/link name/i), { target: { value: "team-drop" } });
    fireEvent.change(screen.getByLabelText(/delete received files after/i), { target: { value: "" } });
    fireEvent.click(screen.getByText(/create link/i));

    await waitFor(() => {
      expect(window.fetch).toHaveBeenCalled();
    });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(body.ownerNote).toBeUndefined();
    expect(body.retentionDays).toBeUndefined();
  });

  it("I7: pre-fills the retention field with a default value instead of leaving it blank", () => {
    render(<NewLinkPage />);
    expect(screen.getByLabelText(/delete received files after/i)).toHaveValue(1);
  });

  it("creates a browser-key, one-time link via POST /api/links when 'This browser' is chosen", async () => {
    window.localStorage.clear();
    authState.user = { publicKey: encodeBase64(nacl.box.keyPair().publicKey), keyPair: nacl.box.keyPair() };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ linkId: "b1", slug: "brw123", codewords: API_CODEWORDS, codewordLocale: "en", expiresAt: Date.now() + 3_600_000 }),
      })
    );

    render(<NewLinkPage />);
    fireEvent.click(screen.getByLabelText(/this browser/i));
    // Account-only fields disappear; the browser-only PIN field appears.
    expect(screen.queryByLabelText(/link name/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^pin/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /create browser link/i }));

    await waitFor(() => {
      expect(screen.getByRole("link", { name: /download page/i })).toHaveAttribute("href", "/receive/brw123");
    });
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/links");
    const stored = JSON.parse(window.localStorage.getItem("e2ee-drop:links") ?? "{}");
    expect(stored.brw123).toBeDefined();
  });
});
