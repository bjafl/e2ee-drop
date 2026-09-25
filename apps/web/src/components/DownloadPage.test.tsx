import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const { decryptFileMock, setKeyPairMock, authState } = vi.hoisted(() => ({
  decryptFileMock: vi.fn(),
  setKeyPairMock: vi.fn(),
  // Mutable so each describe block can choose "logged out" vs "logged in".
  authState: { user: null as null | Record<string, unknown> },
}));

vi.mock("@/hooks/useLocalLinks", () => ({
  useLocalLinks: () => ({
    links: { abc123: { privateKey: "c2VjcmV0", createdAt: Date.now(), expiresAt: Date.now() + 60_000 } },
    saveLink: vi.fn(),
    removeLink: vi.fn(),
  }),
}));

vi.mock("@/hooks/useFileEncryption", () => ({
  useFileEncryption: () => ({
    setKeyPair: setKeyPairMock,
    decryptFile: decryptFileMock,
    isProcessing: false,
    progress: 0,
  }),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: authState.user,
    login: vi.fn(),
    logout: vi.fn(),
    register: vi.fn(),
  }),
}));

import { DownloadPage } from "./DownloadPage";

// Minimal controllable EventSource: tests push SSE messages with emit().
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

const UPLOADED_RESPONSE = {
  slug: "abc123",
  isAnonymous: true,
  recipientPublicKey: "YW5vbmtleQ==",
  drop: {
    id: "drop1",
    status: "uploaded",
    fileName: "report.pdf",
    message: "here's the file",
  },
  codewords: ["fox", "river", "lamp"],
};

const DOWNLOAD_URL_RESPONSE = {
  downloadUrl: "https://example.com/get",
  fileName: "report.pdf",
  fileSize: 3,
  mimeType: "application/pdf",
  nonce: "bm9uY2U=",
  senderPublicKey: "c2VuZGVy",
  contentMD5: "bWQ1",
};

const DECRYPTED_FILE = new File(["hello"], "report.pdf", { type: "application/pdf" });

const OWNER_PUBLIC_KEY = "b3duZXJrZXk=";
const OWNER_KEY_PAIR = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) };
const LOGGED_IN_USER = {
  id: "owner1",
  username: "ada",
  name: "Ada",
  email: "ada@example.com",
  emailVerified: true,
  publicKey: OWNER_PUBLIC_KEY,
  totpEnabled: false,
  keyPair: OWNER_KEY_PAIR,
};

function renderAt(slug: string) {
  return render(
    <MemoryRouter initialEntries={[`/download/${slug}`]}>
      <Routes>
        <Route path="/download/:slug" element={<DownloadPage />} />
      </Routes>
    </MemoryRouter>
  );
}

function clickDownload() {
  fireEvent.click(screen.getByText(/download and decrypt/i));
}

function calledUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  decryptFileMock.mockReset();
  setKeyPairMock.mockReset();
  authState.user = null;
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  // jsdom does not implement URL.createObjectURL/revokeObjectURL.
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:mock"),
    revokeObjectURL: vi.fn(),
  });
  // jsdom attempts (and logs a "Not implemented: navigation" error for) a
  // real navigation when an <a> with an href is clicked; the component
  // only uses the click to trigger a browser download, so stub it out.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

describe("DownloadPage", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => UPLOADED_RESPONSE,
      })
    );
  });

  it("shows the verification codewords", async () => {
    renderAt("abc123");

    await waitFor(() => {
      expect(screen.getByText(/fox.*river.*lamp/i)).toBeInTheDocument();
    });
  });

  it("shows the download button once the drop is uploaded", async () => {
    renderAt("abc123");

    await waitFor(() => {
      expect(screen.getByText("report.pdf")).toBeInTheDocument();
    });
  });

  it.each(["downloading", "downloaded"])(
    "shows the download button (not the waiting message) for a drop already in %s status, e.g. after a reload",
    async (status) => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ...UPLOADED_RESPONSE, drop: { ...UPLOADED_RESPONSE.drop, status } }),
      });
      vi.stubGlobal("fetch", fetchMock);

      renderAt("abc123");

      await waitFor(() => {
        expect(screen.getByText(/download and decrypt/i)).toBeInTheDocument();
      });
      expect(screen.queryByText(/waiting/i)).not.toBeInTheDocument();
      // No polling any more: a single snapshot fetch, then SSE only.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it("keeps showing the waiting message while the drop is still uploading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ...UPLOADED_RESPONSE, drop: { ...UPLOADED_RESPONSE.drop, status: "uploading" } }),
      })
    );

    renderAt("abc123");

    await waitFor(() => {
      expect(screen.getByText(/waiting/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/download and decrypt/i)).not.toBeInTheDocument();
  });

  it("subscribes to the link's SSE stream and shows the download button when the upload finishes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...UPLOADED_RESPONSE, drop: null }) })
    );

    renderAt("abc123");
    await waitFor(() => {
      expect(screen.getByText(/waiting/i)).toBeInTheDocument();
    });
    expect(latestEventSource().url).toBe("/api/links/abc123/events");

    act(() => {
      latestEventSource().emit({
        type: "drop-created",
        drop: { ...UPLOADED_RESPONSE.drop, status: "uploading" },
      });
    });
    expect(screen.getByText(/waiting/i)).toBeInTheDocument();

    act(() => {
      latestEventSource().emit({ type: "drop-updated", drop: UPLOADED_RESPONSE.drop });
    });
    expect(screen.getByText(/download and decrypt/i)).toBeInTheDocument();
    expect(screen.queryByText(/waiting/i)).not.toBeInTheDocument();
  });

  it("does not let a snapshot that resolves after a newer SSE event regress the drop's status", async () => {
    let resolveSnapshot!: (value: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveSnapshot = resolve;
          })
      )
    );

    renderAt("abc123");
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    act(() => {
      latestEventSource().emit({ type: "drop-updated", drop: UPLOADED_RESPONSE.drop });
    });
    await act(async () => {
      resolveSnapshot({
        ok: true,
        json: async () => ({ ...UPLOADED_RESPONSE, drop: { ...UPLOADED_RESPONSE.drop, status: "uploading" } }),
      });
    });

    expect(screen.getByText(/download and decrypt/i)).toBeInTheDocument();
    expect(screen.queryByText(/waiting/i)).not.toBeInTheDocument();
  });

  it("closes the SSE connection on unmount", async () => {
    const { unmount } = renderAt("abc123");
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));

    unmount();

    expect(latestEventSource().closed).toBe(true);
  });

  it("keeps the download button usable after a failed download, and lets the recipient retry", async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => UPLOADED_RESPONSE }) // GET link (snapshot)
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) }) // download-url fails (attempt 1)
      .mockResolvedValueOnce({ ok: true, json: async () => DOWNLOAD_URL_RESPONSE }) // download-url succeeds (attempt 2)
      .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["ciphertext"]) }) // encrypted GET
      .mockResolvedValueOnce({ ok: true, json: async () => ({ updated: true }) }); // downloaded POST
    vi.stubGlobal("fetch", fetchMock);
    decryptFileMock.mockResolvedValue(DECRYPTED_FILE);

    renderAt("abc123");
    await waitFor(() => {
      expect(screen.getByText("report.pdf")).toBeInTheDocument();
    });

    clickDownload();

    await waitFor(() => {
      expect(screen.getByText(/download failed/i)).toBeInTheDocument();
    });

    // The download button must still be present and interactive after a
    // failure — not replaced by a full-page dead end.
    const button = screen.getByText(/download and decrypt/i);
    expect(button).not.toBeDisabled();

    clickDownload();

    await waitFor(() => {
      expect(screen.getByText(/downloaded and decrypted/i)).toBeInTheDocument();
    });
    // The anonymous/one-time flow still asks for the link's single drop, as in Plan 1.
    expect(calledUrls(fetchMock)[2]).toBe("/api/links/abc123/download-url");
  });

  it("disables the download button and ignores extra clicks while a download is already in flight", async () => {
    let resolveDecrypt!: (value: File) => void;
    decryptFileMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDecrypt = resolve;
        })
    );
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => UPLOADED_RESPONSE }) // GET link (snapshot)
      .mockResolvedValueOnce({ ok: true, json: async () => DOWNLOAD_URL_RESPONSE }) // download-url
      .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["ciphertext"]) }) // encrypted GET
      .mockResolvedValueOnce({ ok: true, json: async () => ({ updated: true }) }); // downloaded POST
    vi.stubGlobal("fetch", fetchMock);

    renderAt("abc123");
    await waitFor(() => {
      expect(screen.getByText("report.pdf")).toBeInTheDocument();
    });

    clickDownload();

    await waitFor(() => {
      expect(screen.getByText(/download and decrypt/i)).toBeDisabled();
    });

    // Clicking again while the first download is still in flight must be a no-op.
    clickDownload();
    expect(decryptFileMock).toHaveBeenCalledTimes(1);

    resolveDecrypt(DECRYPTED_FILE);

    await waitFor(() => {
      expect(screen.getByText(/downloaded and decrypted/i)).toBeInTheDocument();
    });
  });

  it("shows the no-local-key message when there is no stored private key for the slug", async () => {
    renderAt("unknown-slug");

    await waitFor(() => {
      expect(screen.getByText(/no private key found/i)).toBeInTheDocument();
    });
  });
});

describe("DownloadPage — logged-in user on a link they do not own", () => {
  beforeEach(() => {
    authState.user = LOGGED_IN_USER;
  });

  it("gives a logged-in user the normal anonymous single-drop view for an anonymous link created in this browser", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => UPLOADED_RESPONSE });
    vi.stubGlobal("fetch", fetchMock);

    renderAt("abc123");

    await waitFor(() => {
      expect(screen.getByText("report.pdf")).toBeInTheDocument();
    });
    expect(screen.getByText(/fox.*river.*lamp/i)).toBeInTheDocument();
    expect(screen.getByText(/receive a file/i)).toBeInTheDocument();
    expect(calledUrls(fetchMock).some((url) => url.includes("/drops"))).toBe(false);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("never calls the owner-only /drops route for someone else's anonymous link, and shows the normal no-local-key message", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...UPLOADED_RESPONSE, slug: "zzz999" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAt("zzz999");

    await waitFor(() => {
      expect(screen.getByText(/no private key found/i)).toBeInTheDocument();
    });
    expect(calledUrls(fetchMock).some((url) => url.includes("/drops"))).toBe(false);
    expect(screen.queryByText(/invalid or has expired/i)).not.toBeInTheDocument();
    expect(FakeEventSource.instances.length).toBe(0);
  });

  it("does not treat someone else's owned link as the logged-in user's queue", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ...UPLOADED_RESPONSE,
        slug: "bob",
        isAnonymous: false,
        recipientPublicKey: "c29tZW9uZWVsc2U=",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAt("bob");

    await waitFor(() => {
      expect(screen.getByText(/no private key found/i)).toBeInTheDocument();
    });
    expect(calledUrls(fetchMock).some((url) => url.includes("/drops"))).toBe(false);
  });
});

describe("DownloadPage — owned permanent link queue", () => {
  function stubOwnedFetch(drops: unknown[], extra?: (url: string) => unknown) {
    const fetchMock = vi.fn((url: string) => {
      const custom = extra?.(url.toString());
      if (custom) return Promise.resolve(custom);
      if (url.toString().endsWith("/drops")) {
        return Promise.resolve({ ok: true, json: async () => ({ drops }) });
      }
      if (url.toString() === "/api/links/ada") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            slug: "ada",
            mode: "permanent",
            isAnonymous: false,
            recipientPublicKey: OWNER_PUBLIC_KEY,
            drop: null,
            codewords: ["a", "b", "c"],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  beforeEach(() => {
    authState.user = LOGGED_IN_USER;
  });

  it("lists every queued drop for an owned permanent link", async () => {
    stubOwnedFetch([
      { id: "d1", status: "uploaded", fileName: "first.pdf", message: null },
      { id: "d2", status: "uploaded", fileName: "second.pdf", message: "hi" },
    ]);

    renderAt("ada");

    await waitFor(() => {
      expect(screen.getByText("first.pdf")).toBeInTheDocument();
      expect(screen.getByText("second.pdf")).toBeInTheDocument();
    });
    expect(screen.getByText(/incoming files/i)).toBeInTheDocument();
    expect(screen.getAllByText(/download and decrypt/i)).toHaveLength(2);
    expect(latestEventSource().url).toBe("/api/links/ada/events");
    // The owner's account key pair is the decryption key for an owned link.
    expect(setKeyPairMock).toHaveBeenCalledWith(OWNER_KEY_PAIR);
  });

  it.each(["downloading"])(
    "still shows the download button for a queued drop already in %s status, e.g. after a reload",
    async (status) => {
      stubOwnedFetch([{ id: "d1", status, fileName: "first.pdf", message: null }]);

      renderAt("ada");

      await waitFor(() => {
        expect(screen.getByText("first.pdf")).toBeInTheDocument();
      });
      expect(screen.getByText(/download and decrypt/i)).toBeInTheDocument();
      expect(screen.queryByText(/no files waiting/i)).not.toBeInTheDocument();
    }
  );

  it("shows a still-uploading queued drop without a download button", async () => {
    stubOwnedFetch([{ id: "d1", status: "uploading", fileName: "first.pdf", message: null }]);

    renderAt("ada");

    await waitFor(() => {
      expect(screen.getByText("first.pdf")).toBeInTheDocument();
    });
    expect(screen.queryByText(/download and decrypt/i)).not.toBeInTheDocument();
    expect(screen.getByText(/waiting/i)).toBeInTheDocument();
  });

  it("shows the empty-queue message when nothing is queued", async () => {
    stubOwnedFetch([]);

    renderAt("ada");

    await waitFor(() => {
      expect(screen.getByText(/no files waiting/i)).toBeInTheDocument();
    });
  });

  it("appends new drops from SSE and updates existing ones in place without reordering the queue", async () => {
    stubOwnedFetch([
      { id: "d1", status: "uploading", fileName: "first.pdf", message: null },
      { id: "d2", status: "uploaded", fileName: "second.pdf", message: null },
    ]);

    renderAt("ada");
    await waitFor(() => {
      expect(screen.getByText("second.pdf")).toBeInTheDocument();
    });

    act(() => {
      latestEventSource().emit({
        type: "drop-created",
        drop: { id: "d3", status: "uploading", fileName: "third.pdf", message: null },
      });
      latestEventSource().emit({
        type: "drop-updated",
        drop: { id: "d1", status: "uploaded", fileName: "first.pdf", message: null },
      });
    });

    const names = screen.getAllByText(/^(first|second|third)\.pdf$/).map((node) => node.textContent);
    expect(names).toEqual(["first.pdf", "second.pdf", "third.pdf"]);
    expect(screen.getAllByText(/download and decrypt/i)).toHaveLength(2);
  });

  it("removes a queued drop once an SSE event reports it downloaded", async () => {
    stubOwnedFetch([
      { id: "d1", status: "uploaded", fileName: "first.pdf", message: null },
      { id: "d2", status: "uploaded", fileName: "second.pdf", message: null },
    ]);

    renderAt("ada");
    await waitFor(() => {
      expect(screen.getByText("first.pdf")).toBeInTheDocument();
    });

    act(() => {
      latestEventSource().emit({
        type: "drop-updated",
        drop: { id: "d1", status: "downloaded", fileName: "first.pdf", message: null },
      });
    });

    expect(screen.queryByText("first.pdf")).not.toBeInTheDocument();
    expect(screen.getByText("second.pdf")).toBeInTheDocument();
  });

  it("downloads the specific queued drop by id and drops it from the queue afterwards", async () => {
    const fetchMock = stubOwnedFetch(
      [
        { id: "d1", status: "uploaded", fileName: "first.pdf", message: null },
        { id: "d2", status: "uploaded", fileName: "second.pdf", message: null },
      ],
      (url) => {
        if (url.includes("/download-url")) return { ok: true, json: async () => DOWNLOAD_URL_RESPONSE };
        if (url === DOWNLOAD_URL_RESPONSE.downloadUrl) return { ok: true, blob: async () => new Blob(["x"]) };
        return undefined;
      }
    );
    decryptFileMock.mockResolvedValue(DECRYPTED_FILE);

    renderAt("ada");
    await waitFor(() => {
      expect(screen.getByText("second.pdf")).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByText(/download and decrypt/i)[1]);

    await waitFor(() => {
      expect(screen.queryByText("second.pdf")).not.toBeInTheDocument();
    });
    expect(screen.getByText("first.pdf")).toBeInTheDocument();
    const urls = calledUrls(fetchMock);
    expect(urls).toContain("/api/links/ada/download-url?dropId=d2");
    expect(urls).toContain("/api/links/ada/drops/d2/downloaded");
  });
});

describe("DownloadPage — owned link, owner's decryption key missing after a reload", () => {
  // Plan 2 restores `user` from GET /api/auth/me on a bare reload but never
  // restores `user.keyPair` (it's only populated by login()/register() within
  // the same page load). This mirrors that exact post-reload shape: logged
  // in, owns the link (matching publicKey), but keyPair is null.
  const RELOADED_OWNER_NO_KEYPAIR = { ...LOGGED_IN_USER, keyPair: null };

  function stubOwnedFetch(drops: unknown[]) {
    const fetchMock = vi.fn((url: string) => {
      if (url.toString().endsWith("/drops")) {
        return Promise.resolve({ ok: true, json: async () => ({ drops }) });
      }
      if (url.toString() === "/api/links/ada") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            slug: "ada",
            mode: "permanent",
            isAnonymous: false,
            recipientPublicKey: OWNER_PUBLIC_KEY,
            drop: null,
            codewords: ["a", "b", "c"],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  beforeEach(() => {
    authState.user = RELOADED_OWNER_NO_KEYPAIR;
  });

  it("shows a re-login prompt instead of a working download button, while still listing queued file names", async () => {
    stubOwnedFetch([
      { id: "d1", status: "uploaded", fileName: "first.pdf", message: null },
      { id: "d2", status: "uploaded", fileName: "second.pdf", message: null },
    ]);

    renderAt("ada");

    await waitFor(() => {
      expect(screen.getByText("first.pdf")).toBeInTheDocument();
    });
    // Harmless metadata (file names) still renders...
    expect(screen.getByText("second.pdf")).toBeInTheDocument();
    // ...but no working download button is offered, and the reason + fix are explicit.
    expect(screen.queryByText(/download and decrypt/i)).not.toBeInTheDocument();
    expect(screen.getByText(/decryption key isn't available/i)).toBeInTheDocument();
    const loginLink = screen.getByRole("link", { name: /log in again/i });
    expect(loginLink).toHaveAttribute("href", "/login");
    // The owner's (unavailable) key pair must never be handed to useFileEncryption.
    expect(setKeyPairMock).not.toHaveBeenCalled();
  });

  it("does not silently fail — no generic download-failed alert appears since there's nothing to click", async () => {
    stubOwnedFetch([{ id: "d1", status: "uploaded", fileName: "first.pdf", message: null }]);

    renderAt("ada");

    await waitFor(() => {
      expect(screen.getByText(/log in again/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/download failed/i)).not.toBeInTheDocument();
  });
});
