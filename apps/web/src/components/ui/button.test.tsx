import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./button";

describe("Button asChild", () => {
  it("renders the child element as the root instead of wrapping it in a button", () => {
    render(
      <Button asChild>
        <a href="#test">Link button</a>
      </Button>
    );

    const link = screen.getByRole("link", { name: "Link button" });
    expect(link.tagName).toBe("A");
    expect(link.closest("button")).toBeNull();
  });

  it("renders a native button when asChild is not set", () => {
    render(<Button>Click me</Button>);

    expect(
      screen.getByRole("button", { name: "Click me" })
    ).toBeInTheDocument();
  });
});
