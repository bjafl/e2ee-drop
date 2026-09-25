import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMailMock = vi.fn().mockResolvedValue(undefined);
vi.mock("nodemailer", () => ({
  default: { createTransport: () => ({ sendMail: sendMailMock }) },
}));

describe("mailer", () => {
  beforeEach(() => {
    vi.resetModules();
    sendMailMock.mockClear();
  });

  it("reports unconfigured when SMTP_HOST is unset", async () => {
    vi.doMock("../env", () => ({ env: { SMTP_HOST: undefined } }));
    const { isMailerConfigured } = await import("./mailer");
    expect(isMailerConfigured()).toBe(false);
  });

  it("sends a password reset email when configured", async () => {
    vi.doMock("../env", () => ({
      env: {
        SMTP_HOST: "smtp.example.com",
        SMTP_PORT: 587,
        SMTP_USER: "user",
        SMTP_PASS: "pass",
        SMTP_FROM: "e2ee-drop <no-reply@example.com>",
      },
    }));
    const { isMailerConfigured, sendPasswordResetEmail } = await import("./mailer");
    expect(isMailerConfigured()).toBe(true);

    await sendPasswordResetEmail("someone@example.com", "https://app.example.com/reset?token=abc");

    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "someone@example.com", from: "e2ee-drop <no-reply@example.com>" })
    );
  });
});
