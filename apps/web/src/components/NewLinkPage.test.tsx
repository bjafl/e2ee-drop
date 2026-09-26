import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NewLinkPage } from "./NewLinkPage";

describe("NewLinkPage", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ linkId: "l1", slug: "team-drop" }) })
    );
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
    fireEvent.change(screen.getByLabelText(/link expires after/i), { target: { value: "5" } });
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

  it("omits owner note and retention days when left blank", async () => {
    render(<NewLinkPage />);

    fireEvent.change(screen.getByLabelText(/link name/i), { target: { value: "team-drop" } });
    fireEvent.click(screen.getByText(/create link/i));

    await waitFor(() => {
      expect(window.fetch).toHaveBeenCalled();
    });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(body.ownerNote).toBeUndefined();
    expect(body.retentionDays).toBeUndefined();
  });
});
