// apps/web/src/components/auth/AuthLayout.tsx
//
// Shared frame for the small single-purpose account forms (log in, register,
// password reset, email verification): a narrow centred column with one card.
import * as React from "react";
import { CircleAlert, CircleCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageContainer } from "@/components/common/Page";

export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <PageContainer width="form">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl leading-7 tracking-[-0.01em]">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
      {footer && <div className="mt-4 text-center text-sm text-muted-foreground">{footer}</div>}
    </PageContainer>
  );
}

/** Terminal status message (success / error / neutral) in the same frame. */
export function StatusCard({
  tone = "neutral",
  title,
  children,
  role,
}: {
  tone?: "success" | "error" | "neutral";
  title: React.ReactNode;
  children?: React.ReactNode;
  role?: "alert" | "status";
}) {
  const Icon = tone === "error" ? CircleAlert : CircleCheck;
  return (
    <PageContainer width="form">
      <Card role={role}>
        <CardContent className="flex flex-col items-center gap-3 py-4 text-center">
          {tone !== "neutral" && (
            <span
              className={
                tone === "success"
                  ? "inline-flex size-12 items-center justify-center rounded-full bg-brand-tint text-success"
                  : "inline-flex size-12 items-center justify-center rounded-full bg-muted text-destructive"
              }
            >
              <Icon className="size-6" aria-hidden="true" />
            </span>
          )}
          <p className="text-base leading-6 font-semibold">{title}</p>
          {children && <div className="flex flex-col items-center gap-3 text-muted-foreground">{children}</div>}
        </CardContent>
      </Card>
    </PageContainer>
  );
}

export function FormError({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm text-destructive">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {children}
    </p>
  );
}
