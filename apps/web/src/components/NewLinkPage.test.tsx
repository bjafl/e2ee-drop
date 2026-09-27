import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

  it("falls back to the account's publicKey when this tab has no unlocked key pair", async () => {
    const publicKey = encodeBase64(nacl.box.keyPair().publicKey);
    authState.user = { publicKey, keyPair: null };
    const expected = await deriveCodewords(publicKey, "l1", "en", CODEWORD_WORD_COUNT);

    render(<NewLinkPage />);
    fireEvent.change(screen.getByLabelText(/link name/i), { target: { value: "team-drop" } });
    fireEvent.click(screen.getByText(/create link/i));

    await waitFor(() => {
      expect(screen.getByTestId("codewords")).toHaveTextContent(expected.join(" · "));
    });
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
    fireEvent.change(screen.getByLabelText(/note for the recipient/i), {
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
});
