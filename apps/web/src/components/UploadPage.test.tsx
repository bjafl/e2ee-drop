import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

vi.mock("@/hooks/useFileEncryption", () => ({
  useFileEncryption: () => ({
    setKeyPair: vi.fn(),
    encryptFile: vi.fn(),
    isProcessing: false,
    progress: 0,
  }),
}));

import { UploadPage } from "./UploadPage";

function renderAt(slug: string) {
  return render(
    <MemoryRouter initialEntries={[`/send/${slug}`]}>
      <Routes>
        <Route path="/send/:slug" element={<UploadPage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("UploadPage", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          recipientPublicKey: "cmVjaXBpZW50",
          isAnonymous: true,
          codewords: ["fox", "river", "lamp"],
        }),
      })
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
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
});
