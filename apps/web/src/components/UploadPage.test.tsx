import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const { encryptFileMock } = vi.hoisted(() => ({
  encryptFileMock: vi.fn(),
}));

vi.mock("@/hooks/useFileEncryption", () => ({
  useFileEncryption: () => ({
    setKeyPair: vi.fn(),
    encryptFile: encryptFileMock,
    isProcessing: false,
    progress: 0,
  }),
}));

import { UploadPage } from "./UploadPage";

const LINK_RESPONSE = {
  recipientPublicKey: "cmVjaXBpZW50",
  isAnonymous: true,
  codewords: ["fox", "river", "lamp"],
};

const ENCRYPTED_RESULT = {
  encrypted: new Blob(["ciphertext"]),
  nonce: "bm9uY2U=",
  fileName: "test.txt",
  mimeType: "text/plain",
  fileSize: 3,
  senderPublicKey: "c2VuZGVy",
  contentMD5: "bWQ1",
};

function renderAt(slug: string) {
  return render(
    <MemoryRouter initialEntries={[`/send/${slug}`]}>
      <Routes>
        <Route path="/send/:slug" element={<UploadPage />} />
      </Routes>
    </MemoryRouter>
  );
}

function selectFile() {
  const input = screen.getByTestId("file-input") as HTMLInputElement;
  const file = new File(["hello"], "test.txt", { type: "text/plain" });
  fireEvent.change(input, { target: { files: [file] } });
}

describe("UploadPage", () => {
  beforeEach(() => {
    encryptFileMock.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => LINK_RESPONSE,
      })
    );
  });

  it("shows the verification codewords", async () => {
    renderAt("abc123");

    await waitFor(() => {
      expect(screen.getByText(/fox.*river.*lamp/i)).toBeInTheDocument();
    });
  });

  it("shows the anonymous-recipient indicator for an ownerless link", async () => {
    renderAt("abc123");

    await waitFor(() => {
      expect(screen.getByTestId("recipient-badge")).toHaveTextContent(/anonymous/i);
    });
  });

  it("shows the not-encrypted warning next to the message field", async () => {
    renderAt("abc123");

    await waitFor(() => {
      expect(screen.getByText(/not end-to-end encrypted/i)).toBeInTheDocument();
    });
  });

  it("keeps the form usable after an upload failure, and lets the sender retry", async () => {
    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => LINK_RESPONSE }) // GET link
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) }) // upload-url fails (attempt 1)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ dropId: "drop1", uploadUrl: "https://example.com/upload" }),
      }) // upload-url succeeds (attempt 2)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // PUT succeeds
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // complete succeeds
    vi.stubGlobal("fetch", fetchMock);
    encryptFileMock.mockResolvedValue(ENCRYPTED_RESULT);

    renderAt("abc123");
    await waitFor(() => {
      expect(screen.getByTestId("recipient-badge")).toBeInTheDocument();
    });

    selectFile();

    await waitFor(() => {
      expect(screen.getByText(/upload failed/i)).toBeInTheDocument();
    });

    // The form must still be present and interactive after a failure —
    // not replaced by a full-page dead end.
    expect(screen.getByTestId("recipient-badge")).toBeInTheDocument();
    const input = screen.getByTestId("file-input") as HTMLInputElement;
    expect(input).not.toBeDisabled();

    selectFile();

    await waitFor(() => {
      expect(screen.getByText(/file sent successfully/i)).toBeInTheDocument();
    });
  });

  it("disables the file input and ignores re-selection while an upload is already in flight", async () => {
    let resolveEncrypt!: (value: typeof ENCRYPTED_RESULT) => void;
    encryptFileMock.mockImplementation(
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
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }) // PUT
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // complete
    vi.stubGlobal("fetch", fetchMock);

    renderAt("abc123");
    await waitFor(() => {
      expect(screen.getByTestId("recipient-badge")).toBeInTheDocument();
    });

    selectFile();

    await waitFor(() => {
      expect(screen.getByTestId("file-input")).toBeDisabled();
    });

    // Selecting again while the first upload is still in flight must be a no-op.
    selectFile();
    expect(encryptFileMock).toHaveBeenCalledTimes(1);

    resolveEncrypt(ENCRYPTED_RESULT);

    await waitFor(() => {
      expect(screen.getByText(/file sent successfully/i)).toBeInTheDocument();
    });
  });

  it("shows the owner's name (unverified label) and email-verified badge for an owned link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          recipientPublicKey: "cmVjaXBpZW50",
          isAnonymous: false,
          recipientName: "Ada Lovelace",
          recipientEmailVerified: true,
          codewords: ["fox", "river", "lamp"],
        }),
      })
    );

    renderAt("ada");

    await waitFor(() => {
      expect(screen.getByTestId("recipient-badge")).toHaveTextContent("Ada Lovelace");
      expect(screen.getByTestId("recipient-badge")).toHaveTextContent(/not verified/i);
      expect(screen.getByTestId("recipient-badge")).toHaveTextContent(/verified/i);
    });
  });
});
