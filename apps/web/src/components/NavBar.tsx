// apps/web/src/components/NavBar.tsx
import { useEffect, useId, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useTheme } from "next-themes";
import { Dialog } from "@base-ui/react/dialog";
import {
  ChevronDown,
  Inbox,
  LayoutGrid,
  Lock,
  LogOut,
  Mail,
  Menu as MenuIcon,
  Plus,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useAuth } from "@/hooks/useAuth";
import i18n from "@/i18n";
import navEn from "@/locales/en/nav.json";
import navNb from "@/locales/nb/nav.json";

i18n.addResourceBundle("en", "nav", navEn, true, false);
i18n.addResourceBundle("nb", "nav", navNb, true, false);

// Client-side display only; the server enforces the real resend rate limit
// (15 min window, 3 requests) regardless of what this cooldown shows.
const RESEND_COOLDOWN_SECONDS = 60;

function Brand() {
  const { t } = useTranslation("nav");
  return (
    <Link to="/" className="flex items-center gap-2 text-base font-semibold text-foreground no-underline hover:text-foreground">
      <span className="inline-flex size-7 items-center justify-center rounded-sm bg-primary text-primary-foreground">
        <Lock className="size-4" aria-hidden="true" />
      </span>
      {t("brand")}
    </Link>
  );
}

function initialsOf(name: string | undefined) {
  return (name ?? "?").slice(0, 2).toUpperCase();
}

const desktopLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "inline-flex h-14 items-center px-3 text-sm font-medium no-underline transition-colors duration-150",
    isActive
      ? "text-foreground shadow-[inset_0_-2px_0_var(--primary)] hover:text-foreground"
      : "text-muted-foreground hover:text-foreground"
  );

/**
 * Account menu (desktop): a small disclosure rather than a full menu widget, so
 * its items stay ordinary links/buttons for keyboard and screen-reader users.
 * Closes on Escape, outside click and route change.
 */
function AccountMenu({ username, onLogout }: { username: string; onLogout: () => void }) {
  const { t } = useTranslation("nav");
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const location = useLocation();

  useEffect(() => setOpen(false), [location.pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointer = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative hidden md:block">
      <Button
        variant="ghost"
        className="gap-1 px-1"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t("accountMenu", { username })}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          aria-hidden="true"
          className="inline-flex size-7 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground"
        >
          {initialsOf(username)}
        </span>
        <ChevronDown aria-hidden="true" />
      </Button>
      {open && (
        <div
          id={panelId}
          className="absolute top-full right-0 z-50 mt-2 flex w-60 flex-col rounded-md border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          <div className="px-3 py-2">
            <p className="text-xs leading-4 text-muted-foreground">{t("signedInAs")}</p>
            <p className="truncate font-medium">{username}</p>
          </div>
          <div className="my-1 h-px bg-border" />
          <Link
            to="/account"
            className="flex h-9 items-center gap-2 rounded-sm px-3 text-sm text-foreground no-underline hover:bg-accent hover:text-accent-foreground"
          >
            <UserRound className="size-4" aria-hidden="true" />
            {t("account")}
          </Link>
          <button
            type="button"
            onClick={onLogout}
            className="flex h-9 items-center gap-2 rounded-sm px-3 text-left text-sm hover:bg-accent hover:text-accent-foreground"
          >
            <LogOut className="size-4" aria-hidden="true" />
            {t("logout")}
          </button>
        </div>
      )}
    </div>
  );
}

/** Theme picker as a segmented control (used in the mobile sheet). */
function ThemeSegmented() {
  const { t } = useTranslation("nav");
  const { theme, setTheme } = useTheme();
  const current = theme ?? "system";
  const labelId = useId();
  const options = [
    ["system", t("themeOptionSystem")],
    ["light", t("themeOptionLight")],
    ["dark", t("themeOptionDark")],
  ] as const;
  return (
    <div className="flex flex-col gap-2">
      <span id={labelId} className="px-3 text-xs leading-4 font-medium text-muted-foreground">
        {t("theme")}
      </span>
      <div role="radiogroup" aria-labelledby={labelId} className="mx-3 grid grid-cols-3 gap-1 rounded-md bg-muted p-1">
        {options.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={current === value}
            onClick={() => setTheme(value)}
            className={cn(
              "h-9 rounded-sm text-sm font-medium transition-colors duration-150",
              current === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function MobileMenu({
  username,
  showInbox,
  onLogout,
}: {
  username: string;
  showInbox: boolean;
  onLogout: () => void;
}) {
  const { t } = useTranslation(["nav", "common"]);
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);

  const itemClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "flex h-11 items-center gap-3 rounded-md px-3 font-medium no-underline transition-colors duration-150 [&_svg]:size-5",
      isActive
        ? "bg-sidebar-accent text-sidebar-accent-foreground hover:text-sidebar-accent-foreground"
        : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
    );

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        render={
          <Button variant="ghost" size="icon-lg" className="md:hidden" aria-label={t("common:openMenu")}>
            <MenuIcon aria-hidden="true" />
          </Button>
        }
      />
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/50 duration-200 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <Dialog.Popup className="fixed inset-y-0 right-0 z-50 flex w-80 max-w-[85vw] flex-col border-l border-sidebar-border bg-sidebar text-sidebar-foreground shadow-lg outline-none duration-200 data-open:animate-in data-open:slide-in-from-right data-closed:animate-out data-closed:slide-out-to-right">
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-sidebar-border pr-1 pl-4">
            <div className="flex min-w-0 items-center gap-3">
              <span
                aria-hidden="true"
                className="inline-flex size-8 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground"
              >
                {initialsOf(username)}
              </span>
              <div className="flex min-w-0 flex-col">
                <Dialog.Title className="truncate leading-5 font-semibold">{username}</Dialog.Title>
                <span className="text-xs leading-4 text-muted-foreground">{t("signedInAs")}</span>
              </div>
            </div>
            <Dialog.Close
              render={
                <Button variant="ghost" size="icon-lg" aria-label={t("common:closeMenu")}>
                  <X aria-hidden="true" />
                </Button>
              }
            />
          </div>
          <nav aria-label={t("mainMenu")} className="flex flex-1 flex-col gap-4 overflow-y-auto px-3 py-4">
            <Button asChild size="lg" className="w-full">
              <Link to="/links/new" onClick={() => setOpen(false)}>
                <Plus aria-hidden="true" />
                {t("newLink")}
              </Link>
            </Button>
            <ul className="flex flex-col gap-0.5">
              <li>
                <NavLink to="/" end className={itemClass} onClick={() => setOpen(false)}>
                  <LayoutGrid aria-hidden="true" />
                  {t("overview")}
                </NavLink>
              </li>
              {showInbox && (
                <li>
                  <NavLink to="/inbox" className={itemClass} onClick={() => setOpen(false)}>
                    <Inbox aria-hidden="true" />
                    {t("inbox")}
                  </NavLink>
                </li>
              )}
              <li>
                <NavLink to="/contacts" className={itemClass} onClick={() => setOpen(false)}>
                  <Users aria-hidden="true" />
                  {t("contacts")}
                </NavLink>
              </li>
              <li>
                <NavLink to="/account" className={itemClass} onClick={() => setOpen(false)}>
                  <UserRound aria-hidden="true" />
                  {t("accountSecurity")}
                </NavLink>
              </li>
            </ul>
            <div className="border-t border-sidebar-border pt-4">
              <ThemeSegmented />
            </div>
          </nav>
          <div className="shrink-0 border-t border-sidebar-border p-3">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onLogout();
              }}
              className="flex h-11 w-full items-center gap-3 rounded-md px-3 text-left font-medium hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <LogOut className="size-5" aria-hidden="true" />
              {t("logout")}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function NavBar() {
  const { t } = useTranslation("nav");
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [resendMessage, setResendMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!cooldownUntil) return;
    const interval = setInterval(() => {
      const remaining = Math.ceil((cooldownUntil - Date.now()) / 1000);
      if (remaining <= 0) {
        setCooldownUntil(null);
        setSecondsLeft(0);
        clearInterval(interval);
      } else {
        setSecondsLeft(remaining);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [cooldownUntil]);

  // logout() itself only clears the cookie and the in-memory user (including
  // the decrypted private key) — it doesn't navigate anywhere. Since the
  // nav bar is mounted on every route, including ones that require a
  // session, send the visitor somewhere unguarded afterward.
  const handleLogout = async () => {
    await logout();
    navigate("/");
  };

  const handleResend = async () => {
    setResendMessage(null);
    try {
      const res = await fetch("/api/auth/verify-email/resend", { method: "POST" });
      if (res.status === 429) {
        // The user IS presently rate-limited server-side, so the cooldown
        // display is accurate here — just make clear why, rather than
        // implying this click itself queued a send.
        setCooldownUntil(Date.now() + RESEND_COOLDOWN_SECONDS * 1000);
        setSecondsLeft(RESEND_COOLDOWN_SECONDS);
        setResendMessage(t("resendFailed"));
        return;
      }
      if (!res.ok) {
        setResendMessage(t("resendFailed"));
        return;
      }
      const body = await res.json().catch(() => null);
      if (body && body.emailDeliveryAvailable === false) {
        // No point rate-limiting a client that can never succeed.
        setResendMessage(t("resendUnavailable"));
        return;
      }
      setCooldownUntil(Date.now() + RESEND_COOLDOWN_SECONDS * 1000);
      setSecondsLeft(RESEND_COOLDOWN_SECONDS);
    } catch {
      setResendMessage(t("resendFailed"));
    }
  };

  return (
    <>
      <header className="border-b bg-card">
        <nav
          aria-label={t("mainMenu")}
          className="mx-auto flex min-h-14 max-w-[1168px] items-center justify-between gap-4 pr-2 pl-4 md:px-6"
        >
          <div className="flex items-center gap-6">
            <Brand />
            {user && (
              <div className="hidden items-center gap-1 md:flex">
                <NavLink to="/" end className={desktopLinkClass}>
                  {t("overview")}
                </NavLink>
                {user.emailVerified && (
                  <NavLink to="/inbox" className={desktopLinkClass}>
                    {t("inbox")}
                  </NavLink>
                )}
                <NavLink to="/contacts" className={desktopLinkClass}>
                  {t("contacts")}
                </NavLink>
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 md:gap-2">
            {user ? (
              <>
                <span className="hidden md:inline-flex">
                  <ThemeToggle />
                </span>
                {/* One element for both breakpoints: icon-only on phones, icon + text from md. */}
                <Button
                  asChild
                  variant="ghost"
                  className="size-11 px-0 text-primary md:size-auto md:bg-primary md:px-3 md:text-primary-foreground md:shadow-sm md:hover:bg-primary-hover md:hover:text-primary-foreground"
                >
                  <Link to="/links/new">
                    <Plus className="size-5 md:size-4" aria-hidden="true" />
                    <span className="sr-only md:not-sr-only">{t("newLink")}</span>
                  </Link>
                </Button>
                <AccountMenu username={user.username} onLogout={handleLogout} />
                <MobileMenu username={user.username} showInbox={Boolean(user.emailVerified)} onLogout={handleLogout} />
              </>
            ) : (
              <>
                <ThemeToggle />
                <Button asChild variant="ghost">
                  <Link to="/login">{t("login")}</Link>
                </Button>
                <Button asChild variant="secondary">
                  <Link to="/register">{t("register")}</Link>
                </Button>
              </>
            )}
          </div>
        </nav>
      </header>
      {user && !user.emailVerified && (
        <div data-testid="verify-email-banner" role="status" className="border-b bg-card">
          <div className="mx-auto flex max-w-[1168px] flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-6">
            <span className="flex items-start gap-2">
              <Mail className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
              {resendMessage ? <span data-testid="resend-message">{resendMessage}</span> : t("verifyEmailBanner")}
            </span>
            <Button
              data-testid="resend-verification-button"
              variant="outline"
              disabled={cooldownUntil !== null}
              onClick={handleResend}
              className="tabular-nums"
            >
              {cooldownUntil !== null
                ? t("resendVerificationCooldown", { seconds: secondsLeft })
                : t("resendVerification")}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
