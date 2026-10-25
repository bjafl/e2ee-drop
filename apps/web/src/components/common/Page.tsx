// apps/web/src/components/common/Page.tsx
//
// Page scaffolding per Flode layout rules: content max 1120px, 16px side margin
// on mobile / 24px from md, 48px top/bottom breathing room on desktop.
import * as React from "react";
import { cn } from "cn";

export function PageContainer({
  className,
  width = "wide",
  ...props
}: React.ComponentProps<"main"> & { width?: "wide" | "narrow" | "form" }) {
  return (
    <main
      className={cn(
        "mx-auto w-full px-4 py-6 md:px-6 md:py-12",
        width === "wide" && "max-w-[1168px]",
        width === "narrow" && "max-w-[768px]",
        width === "form" && "max-w-[496px]",
        className
      )}
      {...props}
    />
  );
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  className,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  eyebrow?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={cn("mb-6 flex flex-wrap items-end justify-between gap-4 md:mb-8", className)}>
      <div className="flex min-w-0 flex-col gap-1">
        {eyebrow}
        <h1 className="text-[28px] leading-[34px] font-semibold tracking-[-0.02em]">{title}</h1>
        {description && <p className="text-muted-foreground">{description}</p>}
        {children}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Calm empty state on brand-tint (Flode: brand-tint for large quiet surfaces only). */
export function EmptyState({
  icon,
  title,
  children,
  className,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center gap-2 rounded-lg bg-brand-tint px-6 py-8 text-center", className)}>
      {icon && (
        <span className="mb-1 inline-flex size-10 items-center justify-center rounded-full bg-card text-primary [&_svg]:size-5">
          {icon}
        </span>
      )}
      <p className="text-base leading-6 font-semibold">{title}</p>
      {children && <div className="max-w-md text-foreground">{children}</div>}
    </div>
  );
}

/** h2 section title (20/28, semibold, -0.01em). */
export function SectionTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return <h2 className={cn("text-xl leading-7 font-semibold tracking-[-0.01em]", className)} {...props} />;
}
