import { describe, it, expect, vi, beforeEach } from "vitest";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { CODEWORD_WORD_COUNT, deriveCodewords } from "@e2ee-drop/shared";
import { CreateLinkPage } from "./CreateLinkPage";

function render(ui: ReactElement) {
  return rtlRender(<MemoryRouter>{ui}</MemoryRouter>);
}

// Deliberately far from the old hardcoded 24h: the operator may configure any
// LINK_EXPIRY_HOURS, and the stored key must live exactly as long as the link.
const SERVER_EXPIRES_AT = Date.now() + 72 * 60 * 60 * 1000;

describe("CreateLinkPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          linkId: "link1",
          slug: "abc123",
          // Deliberately unrelated to the locally generated key: the page
          // must never display this server-supplied field (finding F1).
          codewords: ["fox", "river", "lamp", "otter"],
          codewordLocale: "en",
          expiresAt: SERVER_EXPIRES_AT,
        }),
      })
    );
  });

  it("does not create a link until the user submits the form", async () => {
    render(<CreateLinkPage />);

    expect(screen.getByRole("button", { name: /create/i })).toBeInTheDocument();
    expect(window.fetch).not.toHaveBeenCalled();
  });

  it("creates a link and shows the shareable URL once the user clicks create", async () => {
    const user = userEvent.setup();
    render(<CreateLinkPage />);

    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      expect(screen.getByText(/abc123/)).toBeInTheDocument();
    });
  });

  // Review finding F1: the creator's phrase comes from the key pair this
  // page generated locally, not from the response's `codewords` field.
  it("derives all verification words locally from its own generated key, ignoring the API's codewords", async () => {
    const user = userEvent.setup();
    render(<CreateLinkPage />);

    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      expect(screen.getByTestId("codewords")).toBeInTheDocument();
    });
    const sent = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    const expected = await deriveCodewords(sent.recipientPublicKey, "link1", "en", CODEWORD_WORD_COUNT);
    expect(expected).not.toEqual(["fox", "river", "lamp", "otter"]);

    expect(screen.getByTestId("codewords")).toHaveTextContent(expected.join(" · "));
    expect(screen.getByTestId("codewords").textContent!.split(" · ")).toHaveLength(CODEWORD_WORD_COUNT);
    expect(screen.queryByText(/fox · river · lamp/)).not.toBeInTheDocument();
  });

  it("links the recipient to their own download page for the new link", async () => {
    const user = userEvent.setup();
    render(<CreateLinkPage />);

    await user.click(screen.getByRole("button", { name: /create/i }));

    const link = await screen.findByRole("link", { name: /download page/i });
    expect(link).toHaveAttribute("href", "/receive/abc123");
  });

  it("sends the owner note and retention days entered in the form", async () => {
    const user = userEvent.setup();
    render(<CreateLinkPage />);

    await user.type(screen.getByLabelText(/note for the recipient/i), "For the design team");
    await user.clear(screen.getByLabelText(/delete received files after/i));
    await user.type(screen.getByLabelText(/delete received files after/i), "5");
    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      expect(window.fetch).toHaveBeenCalledWith(
        "/api/links",
        expect.objectContaining({
          body: expect.stringContaining('"ownerNote":"For the design team"'),
        })
      );
    });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(body.retentionDays).toBe(5);
  });

  it("I7: pre-fills the retention field with a default value instead of leaving it blank", () => {
    render(<CreateLinkPage />);
    expect(screen.getByLabelText(/delete received files after/i)).toHaveValue(1);
  });

  it("keeps the private key in localStorage until the server's expiresAt, not a hardcoded expiry", async () => {
    const user = userEvent.setup();
    render(<CreateLinkPage />);

    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem("e2ee-drop:links") ?? "{}");
      expect(stored.abc123?.expiresAt).toBe(SERVER_EXPIRES_AT);
    });
  });

  // Task 9 / review finding F9: awaiting saveLink can't itself observe a
  // localStorage failure — its actual write happens later, decoupled, inside
  // useLocalLinks' own useEffect (see that hook's source). So the guard has
  // to be a direct storage probe run before the irreversible POST /api/links
  // call, not something inferrable from saveLink's resolved/rejected promise.
  it("Task 9: warns instead of creating a link when localStorage is unavailable (private browsing/quota)", async () => {
    const user = userEvent.setup();
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });

    render(<CreateLinkPage />);
    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/save the decryption key/i);
    });
    // The irreversible server call must never fire once storage has already
    // failed to probe as writable — otherwise the key would exist only in
    // this tab's memory with no way to recover it later.
    expect(window.fetch).not.toHaveBeenCalled();
    expect(screen.queryByText(/abc123/)).not.toBeInTheDocument();

    setItemSpy.mockRestore();
  });

  it("PIN-protects the stored key when the user sets a PIN", async () => {
    const user = userEvent.setup();
    render(<CreateLinkPage />);

    await user.type(screen.getByLabelText(/protect your key with a pin/i), "1234");
    await user.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem("e2ee-drop:links") ?? "{}");
      expect(stored.abc123?.pinProtected).toBe(true);
      expect(stored.abc123?.privateKey).toBeUndefined();
      expect(stored.abc123?.wrapped).toBeDefined();
    });
  });
});
