// apps/web/src/components/ThemeToggle.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const themeState: { theme: string | undefined } = { theme: "system" };
const setTheme = vi.fn((next: string) => {
  themeState.theme = next;
});

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: themeState.theme, setTheme }),
}));

import { ThemeToggle } from "./ThemeToggle";

describe("ThemeToggle", () => {
  beforeEach(() => {
    setTheme.mockClear();
    themeState.theme = "system";
  });

  it("cycles system -> light -> dark -> system on repeated clicks", async () => {
    // The mocked useTheme() isn't reactive state — mutating themeState alone
    // doesn't re-render the already-mounted component, exactly like a real
    // next-themes consumer whose theme changed via someone else's setTheme
    // call. Each step re-renders fresh, as if navigating to a page that
    // mounts a new ThemeToggle after the theme changed.
    for (const [current, expectedNext] of [
      ["system", "light"],
      ["light", "dark"],
      ["dark", "system"],
    ] as const) {
      themeState.theme = current;
      render(<ThemeToggle />);
      const button = await screen.findByRole("button", { name: new RegExp(`${current} theme`, "i") });
      await userEvent.click(button);
      expect(setTheme).toHaveBeenLastCalledWith(expectedNext);
      cleanup();
    }
  });

  it("labels the button with the current theme, in sync with the resolved icon", async () => {
    themeState.theme = "dark";
    render(<ThemeToggle />);
    await waitFor(() => expect(screen.getByRole("button", { name: /dark theme/i })).toBeInTheDocument());
  });

  it("falls back to system when next-themes reports no theme yet", async () => {
    themeState.theme = undefined;
    render(<ThemeToggle />);
    await waitFor(() => expect(screen.getByRole("button", { name: /system theme/i })).toBeInTheDocument());
  });
});
