import nodemailer from "nodemailer";
import { env } from "../env";

export function isMailerConfigured(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_FROM);
}

function getTransport() {
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  if (!isMailerConfigured()) throw new Error("SMTP is not configured");
  const transport = getTransport();
  await transport.sendMail({
    to,
    from: env.SMTP_FROM,
    subject: "Reset your e2ee-drop password",
    text: `Reset your password: ${resetUrl}\n\nIf you did not request this, ignore this email.`,
    html: `<p>Reset your password: <a href="${resetUrl}">${resetUrl}</a></p><p>If you did not request this, ignore this email.</p>`,
  });
}

export async function sendVerificationEmail(to: string, verifyUrl: string): Promise<void> {
  if (!isMailerConfigured()) throw new Error("SMTP is not configured");
  const transport = getTransport();
  await transport.sendMail({
    to,
    from: env.SMTP_FROM,
    subject: "Verify your e2ee-drop email address",
    text: `Verify your email: ${verifyUrl}\n\nIf you did not create this account, ignore this email.`,
    html: `<p>Verify your email: <a href="${verifyUrl}">${verifyUrl}</a></p><p>If you did not create this account, ignore this email.</p>`,
  });
}
