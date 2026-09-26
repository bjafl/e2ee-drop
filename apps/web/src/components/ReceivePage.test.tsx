import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const {
  decryptMetadataMock,
  decryptMessageMock,
  decryptArchiveMock,
  setKeyPairMock,
  downloadWithProgressMock,
  unlockLinkMock,
  saveLinkMock,
  authState,
  localLinksState,
} = vi.hoisted(() => ({
  decryptMetadataMock: vi.fn(),
  decryptMessageMock: vi.fn(),
  decryptArchiveMock: vi.fn(),
  setKeyPairMock: vi.fn(),
  downloadWithProgressMock: vi.fn(),
  unlockLinkMock: vi.fn(),
  saveLinkMock: vi.fn(),
  // Mutable so each describe block can choose "logged out" vs "logged in".
  authState: { user: null as null | Record<string, unknown> },
  // Mutable so each describe block can choose which slugs this browser holds a local key for.
  localLinksState: { links: {} as Record<string, { pinProtected: boolean }> },
}));

vi.mock("@/hooks/useLocalLinks", () => ({
  useLocalLinks: () => ({
    links: localLinksState.links,
    saveLink: saveLinkMock,
    unlockLink: unlockLinkMock,
    removeLink: vi.fn(),
  }),
}));

vi.mock("@/hooks/useFileEncryption", () => ({
  useFileEncryption: () => ({
    setKeyPair: setKeyPairMock,
    decryptMetadata: decryptMetadataMock,
    decryptMessage: decryptMessageMock,
    decryptArchive: decryptArchiveMock,
    encryptForSend: vi.fn(),
    keyPair: null,
    isProcessing: false,
    progress: 0,
  }),
}));

vi.mock("@/hooks/useStreamedDownload", () => ({
  downloadWithProgress: downloadWithProgressMock,
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: authState.user,
    login: vi.fn(),
    logout: vi.fn(),
    register: vi.fn(),
  }),
}));

import { ReceivePage, STATUS_POLL_INTERVAL_MS } from "./ReceivePage";

// Minimal controllable EventSource: tests push SSE messages with emit().
// Like a real browser EventSource, it opens asynchronously some time after
// construction (never synchronously inside the constructor). Tests that need
// to control *when* it opens set `FakeEventSource.autoOpen = false` and call
// open() / fail() themselves.
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  static autoOpen = true;
  url: string;
  readyState = FakeEventSource.CONNECTING;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
    if (FakeEventSource.autoOpen) setTimeout(() => this.open(), 0);
  }
  open() {
    if (this.closed) return;
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.(new Event("open"));
  }
  fail({ permanently }: { permanently: boolean }) {
    this.readyState = permanently ? FakeEventSource.CLOSED : FakeEventSource.CONNECTING;
    this.onerror?.(new Event("error"));
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
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

const UPLOADED_DROP = {
  id: "drop1",
  fileUploadStatus: "complete",
  deliveryStatus: "sent",
  messageEnvelopeStatus: "sealed",
  fileEnvelopeStatus: "sealed",
  senderPublicKey: "c2VuZGVy",
  archiveNonce: "bm9uY2U=",
  contentMD5: "bWQ1",
  encryptedMetadata: "ZW5jbWV0YQ==",
  metadataNonce: "bWV0YW5vbmNl",
  hasMessage: true,
  contentExpiresAt: Date.now() + 1000 * 60 * 60 * 24,
};

const UPLOADING_DROP = { ...UPLOADED_DROP, fileUploadStatus: "uploading" };

const CLAIMED_LINK_RESPONSE = {
  slug: "abc123",
  mode: "one-time",
  recipientPublicKey: "YW5vbmtleQ==",
  drop: UPLOADED_DROP,
  isAnonymous: true,
  codewords: ["fox", "river", "lamp", "otter"],
  retentionDays: 7,
};

const UNCLAIMED_LINK_RESPONSE = {
  slug: "req123",
  mode: "permanent",
  recipientPublicKey: null,
  drop: null,
  isAnonymous: false,
  codewords: [],
  retentionDays: 30,
};

const DOWNLOAD_URL_RESPONSE = {
  downloadUrl: "https://example.com/get",
  archiveNonce: "bm9uY2U=",
  senderPublicKey: "c2VuZGVy",
  contentMD5: "bWQ1",
};

const DECRYPTED_METADATA = { files: [{ name: "report.pdf", size: 3 }], mimeType: "application/pdf" };

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
    <MemoryRouter initialEntries={[`/receive/${slug}`]}>
      <Routes>
        <Route path="/receive/:slug" element={<ReceivePage />} />
      </Routes>
    </MemoryRouter>
  );
}

function calledUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  decryptMetadataMock.mockReset().mockResolvedValue(DECRYPTED_METADATA);
  decryptMessageMock.mockReset();
  decryptArchiveMock.mockReset();
  setKeyPairMock.mockReset();
  downloadWithProgressMock.mockReset();
  unlockLinkMock.mockReset().mockResolvedValue("c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0MTI=");
  saveLinkMock.mockReset().mockResolvedValue(undefined);
  authState.user = null;
  localLinksState.links = {};
  FakeEventSource.instances = [];
  FakeEventSource.autoOpen = true;
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

describe("ReceivePage — anonymous single-drop view", () => {
  beforeEach(() => {
    localLinksState.links = { abc123: { pinProtected: false, privateKey: "c2VjcmV0", createdAt: Date.now(), expiresAt: Date.now() + 60_000 } as never };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => CLAIMED_LINK_RESPONSE })
    );
  });

  it("shows every verification codeword the server returned, not just the first few", async () => {
    renderAt("abc123");
    await waitFor(() => {
      expect(screen.getByText(/fox.*river.*lamp.*otter/i)).toBeInTheDocument();
    });
  });

  it("unlocks with the unprotected local key and decrypts metadata automatically", async () => {
    renderAt("abc123");
    await waitFor(() => {
      expect(setKeyPairMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByText(/report\.pdf/)).toBeInTheDocument();
    });
    expect(decryptMetadataMock).toHaveBeenCalledWith(
      UPLOADED_DROP.encryptedMetadata,
      UPLOADED_DROP.metadataNonce,
      UPLOADED_DROP.senderPublicKey
    );
  });

  it("keeps showing the waiting message while the drop is still uploading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...CLAIMED_LINK_RESPONSE, drop: UPLOADING_DROP }) })
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
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...CLAIMED_LINK_RESPONSE, drop: UPLOADING_DROP }) })
    );
    renderAt("abc123");
    await waitFor(() => {
      expect(screen.getByText(/waiting/i)).toBeInTheDocument();
    });
    expect(latestEventSource().url).toBe("/api/links/abc123/events");

    act(() => {
      latestEventSource().emit({ type: "drop-updated", drop: UPLOADED_DROP });
    });

    await waitFor(() => {
      expect(screen.getByText(/download and decrypt/i)).toBeInTheDocument();
    });
  });

  it("I2: falls back to polling the plain status endpoint once the SSE connection closes for good, and picks up the new drop", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      let dropReady = false;
      const fetchMock = vi.fn((url: string) => {
        if (url.toString() === "/api/links/abc123") {
          return Promise.resolve({
            ok: true,
            json: async () => ({ ...CLAIMED_LINK_RESPONSE, drop: dropReady ? UPLOADED_DROP : UPLOADING_DROP }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      });
      vi.stubGlobal("fetch", fetchMock);

      renderAt("abc123");
      await waitFor(() => {
        expect(screen.getByText(/waiting/i)).toBeInTheDocument();
      });

      // The events route 403s for a claimed sender-initiated link's real
      // claimant (a known, out-of-scope backend gap) and the connection
      // closes for good — never reconnecting on its own.
      act(() => {
        latestEventSource().fail({ permanently: true });
      });
      await waitFor(() => {
        expect(screen.getByText(/waiting/i)).toBeInTheDocument();
      });

      // The sender's upload only finishes well after the connection closed —
      // without a repeating poll, this recipient would be stuck here forever.
      dropReady = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STATUS_POLL_INTERVAL_MS);
      });

      await waitFor(() => {
        expect(screen.getByText(/download and decrypt/i)).toBeInTheDocument();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the SSE connection on unmount", async () => {
    const { unmount } = renderAt("abc123");
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    unmount();
    expect(latestEventSource().closed).toBe(true);
  });

  it("I6: does not show the reveal-message button until metadata has successfully decrypted", async () => {
    let resolveMetadata!: (value: typeof DECRYPTED_METADATA) => void;
    decryptMetadataMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMetadata = resolve;
        })
    );
    renderAt("abc123");

    await waitFor(() => {
      expect(screen.getByText(/fox.*river.*lamp.*otter/i)).toBeInTheDocument();
    });
    // hasMessage is true on UPLOADED_DROP, but metadata hasn't resolved yet —
    // metadata decrypting successfully is the first proof the loaded key
    // actually works, so the reveal button must not appear before then.
    expect(screen.queryByText(/reveal message/i)).not.toBeInTheDocument();

    resolveMetadata(DECRYPTED_METADATA);
    await waitFor(() => {
      expect(screen.getByText(/reveal message/i)).toBeInTheDocument();
    });
  });

  it("I6: shows an 'already revealed' error when the server reveal-message call 404s or 409s", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.toString().includes("/reveal-message")) {
        return Promise.resolve({ ok: false, status: 409, json: async () => ({ error: "conflict" }) });
      }
      return Promise.resolve({ ok: true, json: async () => CLAIMED_LINK_RESPONSE });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAt("abc123");
    await waitFor(() => {
      expect(screen.getByText(/reveal message/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/reveal message/i));
    await waitFor(() => {
      expect(screen.getByText(/can only be revealed once/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /^reveal$/i }));

    await waitFor(() => {
      expect(screen.getByText(/already been revealed/i)).toBeInTheDocument();
    });
    expect(decryptMessageMock).not.toHaveBeenCalled();
  });

  it("I6: shows an honest 'permanently gone' error when decrypting the revealed message fails after the server already deleted it", async () => {
    decryptMessageMock.mockRejectedValue(new Error("bad key"));
    const fetchMock = vi.fn((url: string) => {
      if (url.toString().includes("/reveal-message")) {
        return Promise.resolve({ ok: true, json: async () => ({ encryptedMessage: "ZW5j", messageNonce: "bm9uY2U=" }) });
      }
      return Promise.resolve({ ok: true, json: async () => CLAIMED_LINK_RESPONSE });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAt("abc123");
    await waitFor(() => {
      expect(screen.getByText(/reveal message/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/reveal message/i));
    await waitFor(() => {
      expect(screen.getByText(/can only be revealed once/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /^reveal$/i }));

    await waitFor(() => {
      expect(screen.getByText(/permanently deleted from the server/i)).toBeInTheDocument();
    });
  });

  it("I6: does not crash when unlocking a corrupted local key throws outside the PIN flow", async () => {
    localLinksState.links = {
      abc123: { pinProtected: false, privateKey: "corrupt", createdAt: Date.now(), expiresAt: Date.now() + 60_000 } as never,
    };
    unlockLinkMock.mockReset().mockRejectedValue(new Error("corrupted key"));

    renderAt("abc123");

    await waitFor(() => {
      expect(screen.getByText(/fox.*river.*lamp.*otter/i)).toBeInTheDocument();
    });
    // The old pre-rewrite behavior this restores: leave the key pair unset
    // and let the page render normally instead of crashing / rejecting
    // unhandled.
    expect(setKeyPairMock).not.toHaveBeenCalled();
  });

  it("reveals the message only after the confirmation dialog is accepted, and shows it once decrypted", async () => {
    decryptMessageMock.mockResolvedValue("here's the file");
    const fetchMock = vi.fn((url: string) => {
      if (url.toString().includes("/reveal-message")) {
        return Promise.resolve({ ok: true, json: async () => ({ encryptedMessage: "ZW5j", messageNonce: "bm9uY2U=" }) });
      }
      return Promise.resolve({ ok: true, json: async () => CLAIMED_LINK_RESPONSE });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAt("abc123");
    await waitFor(() => {
      expect(screen.getByText(/reveal message/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/reveal message/i));
    await waitFor(() => {
      expect(screen.getByText(/can only be revealed once/i)).toBeInTheDocument();
    });
    expect(decryptMessageMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^reveal$/i }));

    await waitFor(() => {
      expect(screen.getByText(/here's the file/i)).toBeInTheDocument();
    });
    expect(calledUrls(fetchMock)).toContain("/api/links/abc123/drops/drop1/reveal-message");
  });

  it("downloads, verifies integrity and decrypts the archive, then offers a save link when auto-save is off", async () => {
    window.localStorage.setItem("e2ee-drop:auto-save-zip", "false");
    const fetchMock = vi.fn((url: string) => {
      if (url.toString().includes("/download-url")) return Promise.resolve({ ok: true, json: async () => DOWNLOAD_URL_RESPONSE });
      if (url.toString().includes("/complete-download")) return Promise.resolve({ ok: true, json: async () => ({ completed: true }) });
      return Promise.resolve({ ok: true, json: async () => CLAIMED_LINK_RESPONSE });
    });
    vi.stubGlobal("fetch", fetchMock);
    downloadWithProgressMock.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), integrityOk: true });
    decryptArchiveMock.mockResolvedValue(new Uint8Array([9, 9, 9]));

    renderAt("abc123");
    await waitFor(() => {
      expect(screen.getByText(/download and decrypt/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/download and decrypt/i));

    await waitFor(() => {
      expect(screen.getByText(/save file/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/downloaded and decrypted/i)).toBeInTheDocument();
    expect(calledUrls(fetchMock)).toContain("/api/links/abc123/download-url?dropId=drop1");
    expect(calledUrls(fetchMock)).toContain("/api/links/abc123/drops/drop1/complete-download");
  });

  it("reports a failed download when the integrity check fails, and lets the recipient retry", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.toString().includes("/download-url")) return Promise.resolve({ ok: true, json: async () => DOWNLOAD_URL_RESPONSE });
      if (url.toString().includes("/download-failed")) return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      return Promise.resolve({ ok: true, json: async () => CLAIMED_LINK_RESPONSE });
    });
    vi.stubGlobal("fetch", fetchMock);
    downloadWithProgressMock.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), integrityOk: false });

    renderAt("abc123");
    await waitFor(() => {
      expect(screen.getByText(/download and decrypt/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/download and decrypt/i));

    await waitFor(() => {
      expect(screen.getByText(/download failed/i)).toBeInTheDocument();
    });
    expect(calledUrls(fetchMock)).toContain("/api/links/abc123/drops/drop1/download-failed");
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("prompts for a PIN before unlocking a PIN-protected local key, and rejects a wrong PIN", async () => {
    localLinksState.links = { abc123: { pinProtected: true } as never };
    unlockLinkMock.mockImplementation((_slug: string, pin?: string) => {
      if (pin === "1234") return Promise.resolve("c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0MTI=");
      return Promise.reject(new Error("wrong pin"));
    });

    renderAt("abc123");
    await waitFor(() => {
      expect(screen.getByText(/protected with a pin/i)).toBeInTheDocument();
    });
    expect(setKeyPairMock).not.toHaveBeenCalled();

    fireEvent.change(document.querySelector("input[type=password]")!, { target: { value: "0000" } });
    fireEvent.click(screen.getByText(/^unlock$/i));

    await waitFor(() => {
      expect(screen.getByText(/wrong pin/i)).toBeInTheDocument();
    });
    expect(setKeyPairMock).not.toHaveBeenCalled();

    fireEvent.change(document.querySelector("input[type=password]")!, { target: { value: "1234" } });
    fireEvent.click(screen.getByText(/^unlock$/i));

    await waitFor(() => {
      expect(setKeyPairMock).toHaveBeenCalled();
    });
  });

  it("shows the no-local-key message for an unknown slug when logged out", async () => {
    localLinksState.links = {};
    renderAt("unknown-slug");
    await waitFor(() => {
      expect(screen.getByText(/no private key found/i)).toBeInTheDocument();
    });
  });

  it("shows the link-not-found message when the status fetch fails", async () => {
    localLinksState.links = {};
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "Link not found" }) }));
    renderAt("gone");
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });
});

describe("ReceivePage — claim flow", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => UNCLAIMED_LINK_RESPONSE }));
  });

  it("shows the claim view for an unclaimed link, with a login prompt when logged out", async () => {
    renderAt("req123");
    await waitFor(() => {
      expect(screen.getByText(/^claim this link$/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("link", { name: /log in/i })).toHaveAttribute("href", "/login");
    expect(screen.queryByRole("button", { name: /claim with my account/i })).not.toBeInTheDocument();
  });

  it("claims anonymously, stores a local key with the optional PIN, and moves to the normal view", async () => {
    let claimed = false;
    const fetchMock = vi.fn((url: string) => {
      if (url.toString().includes("/claim")) {
        claimed = true;
        return Promise.resolve({ ok: true, json: async () => ({ claimed: true }) });
      }
      if (url.toString().includes("/mark-receiver-opened")) return Promise.resolve({ ok: true, json: async () => ({}) });
      return Promise.resolve({
        ok: true,
        json: async () => (claimed ? { ...UNCLAIMED_LINK_RESPONSE, recipientPublicKey: "bmV3a2V5", drop: null } : UNCLAIMED_LINK_RESPONSE),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAt("req123");
    await waitFor(() => {
      expect(screen.getByText(/claim anonymously/i)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(/pin/i), { target: { value: "4242" } });
    fireEvent.click(screen.getByText(/^claim anonymously$/i));

    await waitFor(() => {
      expect(saveLinkMock).toHaveBeenCalledWith(
        "req123",
        expect.any(String),
        expect.any(Number),
        "4242"
      );
    });
    expect(calledUrls(fetchMock)).toContain("/api/links/req123/claim");
  });

  it("shows an error and does not save a local key when the claim request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.toString().includes("/claim")) return Promise.resolve({ ok: false, json: async () => ({ error: "conflict" }) });
        return Promise.resolve({ ok: true, json: async () => UNCLAIMED_LINK_RESPONSE });
      })
    );

    renderAt("req123");
    await waitFor(() => {
      expect(screen.getByText(/claim anonymously/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/^claim anonymously$/i));

    await waitFor(() => {
      expect(screen.getByText(/could not claim/i)).toBeInTheDocument();
    });
    expect(saveLinkMock).not.toHaveBeenCalled();
  });

  it("claims with the logged-in user's account public key, not a freshly generated one", async () => {
    authState.user = LOGGED_IN_USER;
    let claimed = false;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.toString().includes("/claim")) {
        expect(JSON.parse(String(init?.body)).recipientPublicKey).toBe(OWNER_PUBLIC_KEY);
        claimed = true;
        return Promise.resolve({ ok: true, json: async () => ({ claimed: true }) });
      }
      if (url.toString().includes("/mark-receiver-opened")) return Promise.resolve({ ok: true, json: async () => ({}) });
      // C1 (final review): the real backend 403s here — `link.ownerId` is
      // always the request link's initiator, never its claimant. Stubbing
      // this as 200 (as an earlier version of this test did) hid the exact
      // bug this test now guards against.
      if (url.toString().endsWith("/drops")) return Promise.resolve({ ok: false, status: 403, json: async () => ({ error: "Forbidden" }) });
      return Promise.resolve({
        ok: true,
        json: async () => (claimed ? { ...UNCLAIMED_LINK_RESPONSE, recipientPublicKey: OWNER_PUBLIC_KEY, drop: null } : UNCLAIMED_LINK_RESPONSE),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAt("req123");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /claim with my account/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /claim with my account/i }));

    await waitFor(() => {
      expect(calledUrls(fetchMock)).toContain("/api/links/req123/claim");
    });
  });

  it("C1: a logged-in user claiming a request link with their account sees and can download the single drop, not link-not-found or a 403'd queue", async () => {
    authState.user = LOGGED_IN_USER;
    let claimed = false;
    const fetchMock = vi.fn((url: string) => {
      const u = url.toString();
      if (u.includes("/claim")) {
        claimed = true;
        return Promise.resolve({ ok: true, json: async () => ({ claimed: true }) });
      }
      if (u.includes("/mark-receiver-opened")) return Promise.resolve({ ok: true, json: async () => ({}) });
      // The real backend 403s here for this account: it claimed the link, but
      // `link.ownerId` stays the request link's initiator (design spec
      // §4.1/§4.2) — never the claimant. This is deliberately NOT mocked as a
      // 200 (see the review finding this guards against).
      if (u.endsWith("/drops")) return Promise.resolve({ ok: false, status: 403, json: async () => ({ error: "Forbidden" }) });
      return Promise.resolve({
        ok: true,
        json: async () =>
          claimed
            ? { ...UNCLAIMED_LINK_RESPONSE, recipientPublicKey: OWNER_PUBLIC_KEY, drop: UPLOADED_DROP }
            : UNCLAIMED_LINK_RESPONSE,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAt("req123");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /claim with my account/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /claim with my account/i }));

    // Falls back to the single-drop claimant view, using the account's key
    // pair — not "link not found", and not the (403'd) owner queue.
    await waitFor(() => {
      expect(screen.getByText(/report\.pdf/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/link is invalid or has expired/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no private key found/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/incoming files/i)).not.toBeInTheDocument();
    expect(setKeyPairMock).toHaveBeenCalledWith(OWNER_KEY_PAIR);
  });
});

describe("ReceivePage — logged-in user on a link they do not own", () => {
  beforeEach(() => {
    authState.user = LOGGED_IN_USER;
  });

  it("gives a logged-in user the normal anonymous single-drop view for a link claimed in this browser", async () => {
    localLinksState.links = { abc123: { pinProtected: false, privateKey: "c2VjcmV0", createdAt: Date.now(), expiresAt: Date.now() + 60_000 } as never };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => CLAIMED_LINK_RESPONSE });
    vi.stubGlobal("fetch", fetchMock);

    renderAt("abc123");

    await waitFor(() => {
      expect(screen.getByText(/report\.pdf/)).toBeInTheDocument();
    });
    expect(calledUrls(fetchMock).some((url) => url.includes("/drops"))).toBe(false);
  });

  it("never calls the owner-only /drops route for someone else's link, and shows the no-local-key message", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...CLAIMED_LINK_RESPONSE, slug: "zzz999", recipientPublicKey: "c29tZW9uZWVsc2U=", isAnonymous: false }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAt("zzz999");

    await waitFor(() => {
      expect(screen.getByText(/no private key found/i)).toBeInTheDocument();
    });
    expect(calledUrls(fetchMock).some((url) => url.includes("/drops"))).toBe(false);
    expect(FakeEventSource.instances.length).toBe(0);
  });
});

describe("ReceivePage — owned link queue", () => {
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
            codewords: [],
            retentionDays: 30,
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

  it("lists every queued drop and decrypts each one's metadata independently", async () => {
    stubOwnedFetch([
      { ...UPLOADED_DROP, id: "d1", encryptedMetadata: "bWV0YTE=" },
      { ...UPLOADED_DROP, id: "d2", encryptedMetadata: "bWV0YTI=" },
    ]);
    decryptMetadataMock.mockImplementation(async (metadata: string) =>
      metadata === "bWV0YTE=" ? { files: [{ name: "first.pdf", size: 1 }], mimeType: "x" } : { files: [{ name: "second.pdf", size: 2 }], mimeType: "x" }
    );

    renderAt("ada");

    await waitFor(() => {
      expect(screen.getByText(/first\.pdf/)).toBeInTheDocument();
      expect(screen.getByText(/second\.pdf/)).toBeInTheDocument();
    });
    expect(screen.getByText(/incoming files/i)).toBeInTheDocument();
    expect(screen.getAllByText(/download and decrypt/i)).toHaveLength(2);
    expect(latestEventSource().url).toBe("/api/links/ada/events");
    expect(setKeyPairMock).toHaveBeenCalledWith(OWNER_KEY_PAIR);
  });

  it("shows the empty-queue message when nothing is queued", async () => {
    stubOwnedFetch([]);
    renderAt("ada");
    await waitFor(() => {
      expect(screen.getByText(/no files waiting/i)).toBeInTheDocument();
    });
  });

  it("shows a still-uploading queued drop without a download button", async () => {
    stubOwnedFetch([{ ...UPLOADING_DROP, id: "d1" }]);
    renderAt("ada");
    await waitFor(() => {
      expect(screen.getByText(/waiting/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/download and decrypt/i)).not.toBeInTheDocument();
  });

  it("appends new drops from SSE without reordering the queue", async () => {
    stubOwnedFetch([{ ...UPLOADING_DROP, id: "d1" }]);
    renderAt("ada");
    await waitFor(() => expect(screen.getByText(/waiting/i)).toBeInTheDocument());

    act(() => {
      latestEventSource().emit({ type: "drop-created", drop: { ...UPLOADING_DROP, id: "d2" } });
      latestEventSource().emit({ type: "drop-updated", drop: { ...UPLOADED_DROP, id: "d1" } });
    });

    await waitFor(() => {
      expect(screen.getAllByText(/download and decrypt/i)).toHaveLength(1);
    });
  });

  it("downloads the specific queued drop by id and removes it from the queue afterwards", async () => {
    const fetchMock = stubOwnedFetch(
      [
        { ...UPLOADED_DROP, id: "d1" },
        { ...UPLOADED_DROP, id: "d2" },
      ],
      (url) => {
        if (url.includes("/download-url")) return { ok: true, json: async () => DOWNLOAD_URL_RESPONSE };
        if (url.includes("/complete-download")) return { ok: true, json: async () => ({ completed: true }) };
        return undefined;
      }
    );
    downloadWithProgressMock.mockResolvedValue({ bytes: new Uint8Array([1]), integrityOk: true });
    decryptArchiveMock.mockResolvedValue(new Uint8Array([1]));

    renderAt("ada");
    await waitFor(() => {
      expect(screen.getAllByText(/download and decrypt/i)).toHaveLength(2);
    });

    fireEvent.click(screen.getAllByText(/download and decrypt/i)[1]);

    await waitFor(() => {
      expect(screen.getAllByText(/download and decrypt/i)).toHaveLength(1);
    });
    const urls = calledUrls(fetchMock);
    expect(urls).toContain("/api/links/ada/download-url?dropId=d2");
    expect(urls).toContain("/api/links/ada/drops/d2/complete-download");
  });

  it("does not treat someone else's owned link as the logged-in user's queue", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        slug: "bob",
        mode: "permanent",
        isAnonymous: false,
        recipientPublicKey: "c29tZW9uZWVsc2U=",
        drop: null,
        codewords: [],
        retentionDays: 30,
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

describe("ReceivePage — owned link, owner's decryption key missing after a reload", () => {
  // A bare reload restores `user` from GET /api/auth/me but never restores
  // `user.keyPair` (it's only populated by login()/register() within the
  // same page load — see useAuth.tsx).
  const RELOADED_OWNER_NO_KEYPAIR = { ...LOGGED_IN_USER, keyPair: null };

  beforeEach(() => {
    authState.user = RELOADED_OWNER_NO_KEYPAIR;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.toString().endsWith("/drops")) {
          return Promise.resolve({ ok: true, json: async () => ({ drops: [{ ...UPLOADED_DROP, id: "d1" }] }) });
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
              codewords: [],
              retentionDays: 30,
            }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      })
    );
  });

  it("shows a re-login prompt instead of the queue, and never attempts to decrypt anything", async () => {
    renderAt("ada");

    await waitFor(() => {
      expect(screen.getByText(/decryption key isn't available/i)).toBeInTheDocument();
    });
    const loginLink = screen.getByRole("link", { name: /log in again/i });
    expect(loginLink).toHaveAttribute("href", "/login");
    // No file names, no download button — nothing can be shown without the key.
    expect(screen.queryByText(/download and decrypt/i)).not.toBeInTheDocument();
    // The owner's (unavailable) key pair must never be handed to useFileEncryption,
    // and no per-drop decrypt must ever be attempted with a missing/wrong key.
    expect(setKeyPairMock).not.toHaveBeenCalled();
    expect(decryptMetadataMock).not.toHaveBeenCalled();
  });
});
