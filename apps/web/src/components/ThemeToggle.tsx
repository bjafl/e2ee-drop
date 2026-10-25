// apps/web/src/components/ThemeToggle.tsx
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { useTranslation } from "react-i18next";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import i18n from "@/i18n";
import navEn from "@/locales/en/nav.json";
import navNb from "@/locales/nb/nav.json";

// Shares the "nav" namespace with NavBar.tsx (this component is always
// rendered inside it), but registers it independently so ThemeToggle also
// works if ever rendered standalone (e.g. in its own tests).
i18n.addResourceBundle("en", "nav", navEn, true, false);
i18n.addResourceBundle("nb", "nav", navNb, true, false);

const NEXT_THEME: Record<string, string> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const ICON_FOR_THEME: Record<string, typeof Sun> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

export function ThemeToggle() {
  const { t } = useTranslation("nav");
  const { theme, setTheme } = useTheme();

  // next-themes reports `theme` as undefined until its first effect runs, to
  // avoid a hydration mismatch. This app has no SSR step, but the same
  // one-tick gap still exists client-side, so render a stable placeholder
  // until then rather than flashing the wrong icon.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const current = mounted ? (theme ?? "system") : "system";
  const Icon = ICON_FOR_THEME[current] ?? Monitor;
  const label = t(`theme${current.charAt(0).toUpperCase()}${current.slice(1)}`);

  return (
    <Button
      variant="ghost"
      size="icon"
      className="text-muted-foreground"
      aria-label={label}
      title={label}
      onClick={() => setTheme(NEXT_THEME[current] ?? "system")}
    >
      <Icon />
    </Button>
  );
}
