// apps/web/src/components/common/LinkBadges.tsx
//
// One vocabulary for where a link's private key lives and how long the link
// lives, shown identically everywhere a link appears (dashboard, landing list,
// receive page). Two independent axes:
//   storage:  "account" (key wrapped on the account) | "browser" (key only in
//             this browser's localStorage — lost with browser data)
//   lifetime: "permanent" | "one-time"
// The two storage badges differ in shape (filled vs outlined) and icon as well
// as text, so they never rely on colour alone.
import { useTranslation } from "react-i18next";
import { Monitor, UserRound } from "lucide-react";
import type { LinkMode } from "@e2ee-drop/shared";
import { Badge } from "@/components/ui/badge";

export type LinkStorage = "account" | "browser";

export function StorageBadge({ storage, className }: { storage: LinkStorage; className?: string }) {
  const { t } = useTranslation("common");
  if (storage === "account") {
    return (
      <Badge variant="default" className={className} data-storage="account">
        <UserRound aria-hidden="true" />
        {t("storage.account")}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className={className} data-storage="browser">
      <Monitor aria-hidden="true" />
      {t("storage.browser")}
    </Badge>
  );
}

export function LifetimeBadge({ mode, className }: { mode: LinkMode; className?: string }) {
  const { t } = useTranslation("common");
  return (
    <Badge variant="muted" className={className}>
      {mode === "permanent" ? t("lifetime.permanent") : t("lifetime.oneTime")}
    </Badge>
  );
}
