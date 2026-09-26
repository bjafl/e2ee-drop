import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

// Minimal controllable EventSource, mirroring ReceivePage.test.tsx's fake —
// only what UploadPage's claim-detection effect (I3) needs: opens
// asynchronously, and emit() delivers a message.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
}

function latestEventSource(): FakeEventSource {
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error("no EventSource was created");
  return source;
}

// Renders at /login and surfaces `location.state.returnTo`, so tests can
// assert on the I8 returnTo mechanism without a real LoginPage.
function LoginRouteStub() {
  const location = useLocation();
  const state = location.state as { returnTo?: string } | null;
  return <p>login page{state?.returnTo ? ` returnTo=${state.returnTo}` : ""}</p>;
}

// jsdom's Blob/File implementation doesn't provide `.arrayBuffer()` (see the identical
// workaround/comment in useFileEncryption.test.ts). UploadPage's doSend calls
// `file.arrayBuffer()` directly on the selected Files before handing bytes to
// encryptForSend, so patch it here via FileReader, which jsdom does support fully. Real
// browsers implement Blob.arrayBuffer natively, so this only affects the test environment.
if (typeof Blob.prototype.arrayBuffer !== "function") {
  Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

const { encryptForSendMock, setKeyPairMock, uploadWithProgressMock, authState } = vi.hoisted(() => ({
  encryptForSendMock: vi.fn(),
  setKeyPairMock: vi.fn(),
  uploadWithProgressMock: vi.fn(),
  // Mutable so each test can choose logged-out / logged-in-with-key /
  // logged-in-without-key without re-mocking the module.
  authState: {
    user: null as null | { id: string; keyPair: unknown },
    loading: false,
  },
}));

vi.mock("@/hooks/useFileEncryption", () => ({
  useFileEncryption: () => ({
    setKeyPair: setKeyPairMock,
    encryptForSend: encryptForSendMock,
    isProcessing: false,
    progress: 0,
  }),
}));

vi.mock("@/hooks/useXhrUpload", () => ({
  uploadWithProgress: uploadWithProgressMock,
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: authState.user,
    loading: authState.loading,
    login: vi.fn(),
    logout: vi.fn(),
    register: vi.fn(),
  }),
}));

import { UploadPage } from "./UploadPage";

const LINK_RESPONSE = {
  recipientPublicKey: "cmVjaXBpZW50",
  codewords: ["fox", "river", "lamp", "otter"],
  retentionDays: 7,
};

const ENVELOPES_RESULT = {
  archiveBlob: new Blob(["ciphertext"]),
  archiveNonce: "YXJjaGl2ZQ==",
  encryptedMetadata: "bWV0YWRhdGE=",
  metadataNonce: "bWV0YW5vbmNl",
  encryptedMessage: null,
  messageNonce: null,
  senderPublicKey: "c2VuZGVy",
  fileSize: 3,
  contentMD5: "bWQ1",
};

function renderAt(slug: string) {
  return render(
    <MemoryRouter initialEntries={[`/send/${slug}`]}>
      <Routes>
        <Route path="/send/:slug" element={<UploadPage />} />
        <Route path="/login" element={<LoginRouteStub />} />
      </Routes>
    </MemoryRouter>
  );
}

// react-dropzone reads the FileList via an async getFilesFromEvent internally
// (even for a plain <input type="file"> change), so onDrop — and therefore
// the `files` state update — lands a tick or more after fireEvent.change.
// Callers must await this before asserting on file-dependent UI (the file
// list, the send button's disabled state, etc.).
async function selectFile(name = "test.txt") {
  const input = screen.getByTestId("file-input") as HTMLInputElement;
  const file = new File(["hello"], name, { type: "text/plain" });
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => {
    expect(screen.getByText(name)).toBeInTheDocument();
  });
}

function clickSend() {
  fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
}

describe("UploadPage", () => {
  beforeEach(() => {
    encryptForSendMock.mockReset();
    setKeyPairMock.mockReset();
    uploadWithProgressMock.mockReset();
    uploadWithProgressMock.mockResolvedValue(undefined);
    authState.user = null;
    authState.loading = false;
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => LINK_RESPONSE,
      })
    );
  });

  it("shows only the first three verification codewords, not the rest", async () => {
    renderAt("abc123");

    await waitFor(() => {
      expect(screen.getByText("fox · river · lamp")).toBeInTheDocument();
    });
    expect(screen.queryByText(/otter/)).not.toBeInTheDocument();
  });

  it("shows the anonymous-recipient indicator for an ownerless link", async () => {
    renderAt("abc123");

    await waitFor(() => {
      expect(screen.getByTestId("recipient-badge")).toHaveTextContent(/anonymous/i);
    });
  });

  it("shows the owner's name, username, email-verified, and TOTP status for a claimed link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ...LINK_RESPONSE,
          recipientName: "Ada Lovelace",
          recipientUsername: "ada",
          recipientEmailVerified: true,
          recipientTotpEnabled: true,
        }),
      })
    );

    renderAt("ada");

    await waitFor(() => {
      const badge = screen.getByTestId("recipient-badge");
      expect(badge).toHaveTextContent("Ada Lovelace");
      expect(badge).toHaveTextContent("@ada");
      expect(badge).toHaveTextContent(/email verified/i);
      expect(badge).toHaveTextContent(/two-factor authentication enabled/i);
    });
  });

  it("shows a waiting message instead of the form when the link is unclaimed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ...LINK_RESPONSE, recipientPublicKey: null }),
      })
    );

    renderAt("abc123");

    await waitFor(() => {
      expect(screen.getByText(/hasn't been claimed/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId("dropzone")).not.toBeInTheDocument();
  });

  it("does not send on file selection alone — the sender must explicitly click send", async () => {
    renderAt("abc123");
    await waitFor(() => {
      expect(screen.getByTestId("recipient-badge")).toBeInTheDocument();
    });

    await selectFile();

    expect(encryptForSendMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^send$/i })).not.toBeDisabled();
  });

  it("disables the send button until a file is chosen or a message is typed", async () => {
    renderAt("abc123");
    await waitFor(() => {
      expect(screen.getByTestId("recipient-badge")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /^send$/i })).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/optional message/i), {
      target: { value: "hi" },
    });

    expect(screen.getByRole("button", { name: /^send$/i })).not.toBeDisabled();
  });

  it("shows the anonymous-consent dialog for a logged-out sender, and sends after continuing anonymously", async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => LINK_RESPONSE }) // GET link
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ dropId: "drop1", uploadUrl: "https://example.com/upload" }),
      }) // upload-url
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // complete
    vi.stubGlobal("fetch", fetchMock);
    encryptForSendMock.mockResolvedValue(ENVELOPES_RESULT);

    renderAt("abc123");
    await waitFor(() => {
      expect(screen.getByTestId("recipient-badge")).toBeInTheDocument();
    });

    await selectFile();
    clickSend();

    await waitFor(() => {
      expect(screen.getByText(/send without an account/i)).toBeInTheDocument();
    });
    expect(encryptForSendMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /continue anonymously/i }));

    await waitFor(() => {
      expect(screen.getByText(/file sent successfully/i)).toBeInTheDocument();
    });
    expect(encryptForSendMock).toHaveBeenCalledTimes(1);
    expect(uploadWithProgressMock).toHaveBeenCalledTimes(1);
  });

  it("navigates to /login when the sender chooses to log in instead, from the anonymous-consent dialog", async () => {
    renderAt("abc123");
    await waitFor(() => {
      expect(screen.getByTestId("recipient-badge")).toBeInTheDocument();
    });

    await selectFile();
    clickSend();

    await waitFor(() => {
      expect(screen.getByText(/send without an account/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /log in instead/i }));

    await waitFor(() => {
      expect(screen.getByText(/login page/i)).toBeInTheDocument();
    });
    expect(encryptForSendMock).not.toHaveBeenCalled();
    // I8: the sender should land back on this same send page after logging in,
    // not a generic dead end.
    expect(screen.getByText(/returnTo=\/send\/abc123/)).toBeInTheDocument();
  });

  it("sends immediately without a consent dialog for a freshly-logged-in sender with an unlocked key", async () => {
    const fakeKeyPair = { publicKey: new Uint8Array([1]), secretKey: new Uint8Array([2]) };
    authState.user = { id: "u1", keyPair: fakeKeyPair };
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => LINK_RESPONSE }) // GET link
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ dropId: "drop1", uploadUrl: "https://example.com/upload" }),
      }) // upload-url
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // complete
    vi.stubGlobal("fetch", fetchMock);
    encryptForSendMock.mockResolvedValue(ENVELOPES_RESULT);

    renderAt("abc123");
    await waitFor(() => {
      expect(screen.getByTestId("recipient-badge")).toBeInTheDocument();
    });

    // The hook must have been handed the account's real, already-unlocked
    // keypair — never a freshly generated one — for a genuine same-tab login.
    await waitFor(() => {
      expect(setKeyPairMock).toHaveBeenCalledWith(fakeKeyPair);
    });

    await selectFile();
    clickSend();

    expect(screen.queryByText(/send without an account/i)).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText(/file sent successfully/i)).toBeInTheDocument();
    });
    expect(encryptForSendMock).toHaveBeenCalledTimes(1);
  });

  it("shows a re-authenticate prompt — never the send form — when signed in but the private key isn't unlocked in this tab", async () => {
    // This is the session-restore case: `user` is truthy (a valid session
    // cookie exists) but `user.keyPair` is null, because the private key is
    // never sent to or cached by the server (see useAuth.tsx). Falling back
    // to a random keypair here would make the server-side sender-identity
    // check reject the upload, so the page must not render the normal send
    // path (or call setKeyPair with any keypair) in this state.
    authState.user = { id: "u1", keyPair: null };

    renderAt("abc123");

    await waitFor(() => {
      expect(screen.getByText(/please log in again/i)).toBeInTheDocument();
    });

    expect(screen.queryByTestId("dropzone")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^send$/i })).not.toBeInTheDocument();
    expect(setKeyPairMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("link", { name: /log in again/i }));
    await waitFor(() => {
      expect(screen.getByText(/login page/i)).toBeInTheDocument();
    });
    // I8: this sender should land back on this same send page after
    // re-authenticating, not a generic dead end.
    expect(screen.getByText(/returnTo=\/send\/abc123/)).toBeInTheDocument();
  });

  it("does not affect a genuinely anonymous visitor (no session at all)", async () => {
    authState.user = null;

    renderAt("abc123");

    await waitFor(() => {
      expect(screen.getByTestId("recipient-badge")).toBeInTheDocument();
    });
    expect(screen.queryByText(/please log in again/i)).not.toBeInTheDocument();
    await waitFor(() => {
      expect(setKeyPairMock).toHaveBeenCalledWith(
        expect.objectContaining({ publicKey: expect.anything(), secretKey: expect.anything() })
      );
    });
  });

  it("keeps the form usable after an upload-url failure, and lets the sender retry", async () => {
    // Logged in with an unlocked key so clicking send skips the
    // anonymous-consent dialog — this test is about the retry mechanics,
    // not the consent flow (covered separately above).
    authState.user = { id: "u1", keyPair: { publicKey: new Uint8Array([1]), secretKey: new Uint8Array([2]) } };
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => LINK_RESPONSE }) // GET link
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) }) // upload-url fails (attempt 1)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ dropId: "drop1", uploadUrl: "https://example.com/upload" }),
      }) // upload-url succeeds (attempt 2)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // complete succeeds
    vi.stubGlobal("fetch", fetchMock);
    encryptForSendMock.mockResolvedValue(ENVELOPES_RESULT);

    renderAt("abc123");
    await waitFor(() => {
      expect(screen.getByTestId("recipient-badge")).toBeInTheDocument();
    });

    await selectFile();
    clickSend();

    await waitFor(() => {
      expect(screen.getByText(/upload failed/i)).toBeInTheDocument();
    });

    // The form must still be present and interactive after a failure — not
    // replaced by a full-page dead end.
    expect(screen.getByTestId("recipient-badge")).toBeInTheDocument();
    const sendButton = screen.getByRole("button", { name: /^send$/i });
    expect(sendButton).not.toBeDisabled();

    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(screen.getByText(/file sent successfully/i)).toBeInTheDocument();
    });
  });

  it("abandons the drop reservation and shows an error when the upload PUT itself fails", async () => {
    authState.user = { id: "u1", keyPair: { publicKey: new Uint8Array([1]), secretKey: new Uint8Array([2]) } };
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => LINK_RESPONSE }) // GET link
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ dropId: "drop1", uploadUrl: "https://example.com/upload" }),
      }) // upload-url
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // abandon
    vi.stubGlobal("fetch", fetchMock);
    encryptForSendMock.mockResolvedValue(ENVELOPES_RESULT);
    uploadWithProgressMock.mockRejectedValue(new Error("network error"));

    renderAt("abc123");
    await waitFor(() => {
      expect(screen.getByTestId("recipient-badge")).toBeInTheDocument();
    });

    await selectFile();
    clickSend();

    await waitFor(() => {
      expect(screen.getByText(/upload failed/i)).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/links/abc123/drops/drop1/abandon",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("disables the dropzone and ignores further selection while an upload is already in flight", async () => {
    authState.user = { id: "u1", keyPair: { publicKey: new Uint8Array([1]), secretKey: new Uint8Array([2]) } };
    let resolveEncrypt!: (value: typeof ENVELOPES_RESULT) => void;
    encryptForSendMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveEncrypt = resolve;
        })
    );
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => LINK_RESPONSE }) // GET link
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ dropId: "drop1", uploadUrl: "https://example.com/upload" }),
      }) // upload-url
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // complete
    vi.stubGlobal("fetch", fetchMock);

    renderAt("abc123");
    await waitFor(() => {
      expect(screen.getByTestId("recipient-badge")).toBeInTheDocument();
    });

    await selectFile();
    clickSend();

    // react-dropzone doesn't set the DOM `disabled` attribute on its hidden
    // input when `disabled: true` — it detaches the input's onChange handler
    // instead — so we assert the in-flight state via the encrypting progress
    // indicator rather than an input `disabled` check.
    await waitFor(() => {
      expect(screen.getByText(/encrypting/i)).toBeInTheDocument();
    });

    // Re-selecting while the first upload is still in flight must be a
    // no-op: the dropzone's onChange handler is detached while disabled, so
    // this new file must never reach the `files` list.
    const input = screen.getByTestId("file-input") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["x"], "second.txt")] } });
    expect(screen.queryByText("second.txt")).not.toBeInTheDocument();
    expect(encryptForSendMock).toHaveBeenCalledTimes(1);

    resolveEncrypt(ENVELOPES_RESULT);

    await waitFor(() => {
      expect(screen.getByText(/file sent successfully/i)).toBeInTheDocument();
    });
  });

  it("I3: detects a link-claimed SSE event while waiting for the recipient, and shows the normal send form afterward", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...LINK_RESPONSE, recipientPublicKey: null }) });
    vi.stubGlobal("fetch", fetchMock);

    renderAt("abc123");
    await waitFor(() => {
      expect(screen.getByText(/hasn't been claimed/i)).toBeInTheDocument();
    });
    expect(latestEventSource().url).toBe("/api/links/abc123/events");

    // Once claimed, the SSE handler re-fetches the plain status endpoint to
    // pick up the new recipientPublicKey.
    fetchMock.mockResolvedValue({ ok: true, json: async () => LINK_RESPONSE });
    act(() => {
      latestEventSource().emit({ type: "link-claimed", recipientPublicKey: LINK_RESPONSE.recipientPublicKey });
    });

    await waitFor(() => {
      expect(screen.getByTestId("recipient-badge")).toBeInTheDocument();
    });
    expect(screen.queryByText(/hasn't been claimed/i)).not.toBeInTheDocument();
  });

  it("I3: closes the claim-detection SSE connection once the link is no longer waiting for claim", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...LINK_RESPONSE, recipientPublicKey: null }) })
    );
    renderAt("abc123");
    await waitFor(() => {
      expect(screen.getByText(/hasn't been claimed/i)).toBeInTheDocument();
    });
    const source = latestEventSource();
    expect(source.closed).toBe(false);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => LINK_RESPONSE }));
    act(() => {
      source.emit({ type: "link-claimed", recipientPublicKey: LINK_RESPONSE.recipientPublicKey });
    });

    await waitFor(() => {
      expect(screen.getByTestId("recipient-badge")).toBeInTheDocument();
    });
    expect(source.closed).toBe(true);
  });

  it("I10: removes a single file from the dropzone list without touching the others", async () => {
    renderAt("abc123");
    await waitFor(() => {
      expect(screen.getByTestId("recipient-badge")).toBeInTheDocument();
    });

    await selectFile("first.txt");
    const input = screen.getByTestId("file-input") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["b"], "second.txt")] } });
    await waitFor(() => {
      expect(screen.getByText("second.txt")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /remove first\.txt/i }));

    expect(screen.queryByText("first.txt")).not.toBeInTheDocument();
    expect(screen.getByText("second.txt")).toBeInTheDocument();
  });

  it("I10: re-disables the send button after removing the only selected file", async () => {
    renderAt("abc123");
    await waitFor(() => {
      expect(screen.getByTestId("recipient-badge")).toBeInTheDocument();
    });

    await selectFile("only.txt");
    expect(screen.getByRole("button", { name: /^send$/i })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /remove only\.txt/i }));

    expect(screen.queryByText("only.txt")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^send$/i })).toBeDisabled();
  });
});
