import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const { decryptFileMock } = vi.hoisted(() => ({
  decryptFileMock: vi.fn(),
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
    setKeyPair: vi.fn(),
    decryptFile: decryptFileMock,
    isProcessing: false,
    progress: 0,
  }),
}));

import { DownloadPage } from "./DownloadPage";

const UPLOADED_RESPONSE = {
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

describe("DownloadPage", () => {
  beforeEach(() => {
    decryptFileMock.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => UPLOADED_RESPONSE,
      })
    );
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

  it("keeps the download button usable after a failed download, and lets the recipient retry", async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => UPLOADED_RESPONSE }) // GET link (poll)
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
      .mockResolvedValueOnce({ ok: true, json: async () => UPLOADED_RESPONSE }) // GET link (poll)
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
