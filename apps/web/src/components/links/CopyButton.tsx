// apps/web/src/components/links/CopyButton.tsx
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Copies `value`; label flips to `copiedLabel` for 2 s. Icon-only when `iconOnly`. */
export function CopyButton({
  value,
  label,
  copiedLabel,
  iconOnly = false,
  variant = "default",
  size,
  className,
}: {
  value: string;
  label: string;
  copiedLabel: string;
  iconOnly?: boolean;
  variant?: "default" | "secondary" | "ghost" | "outline";
  size?: "default" | "sm" | "lg" | "xl" | "icon" | "icon-sm" | "icon-lg";
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard unavailable (insecure context / permission) — the value is
      // still visible and selectable next to the button.
    }
  };

  const Icon = copied ? Check : Copy;
  if (iconOnly) {
    return (
      <Button
        type="button"
        variant={variant}
        size={size ?? "icon-sm"}
        aria-label={copied ? copiedLabel : label}
        title={label}
        onClick={copy}
        className={className}
      >
        <Icon />
      </Button>
    );
  }
  return (
    <Button type="button" variant={variant} size={size} onClick={copy} className={className}>
      <Icon />
      {copied ? copiedLabel : label}
    </Button>
  );
}
