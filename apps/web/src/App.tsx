import { lazy, Suspense, type ComponentType } from "react";
import { Routes, Route } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { HomePage } from "@/components/HomePage";
import { Skeleton } from "@/components/ui/skeleton";
import { NavBar } from "@/components/NavBar";
import { AuthProvider } from "@/hooks/useAuth";

// Issue #6: every route except the landing/dashboard is its own chunk, so the
// first load only ships what "/" needs. Pages are named exports, hence the
// small adapter.
const page = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) =>
  lazy(() => load().then((module) => ({ default: module[name] })));

const CreateLinkPage = page(() => import("@/components/CreateLinkPage"), "CreateLinkPage");
const UploadPage = page(() => import("@/components/UploadPage"), "UploadPage");
const ReceivePage = page(() => import("@/components/ReceivePage"), "ReceivePage");
const RegisterPage = page(() => import("@/components/RegisterPage"), "RegisterPage");
const LoginPage = page(() => import("@/components/LoginPage"), "LoginPage");
const RequestPasswordResetPage = page(() => import("@/components/RequestPasswordResetPage"), "RequestPasswordResetPage");
const ConfirmPasswordResetPage = page(() => import("@/components/ConfirmPasswordResetPage"), "ConfirmPasswordResetPage");
const VerifyEmailPage = page(() => import("@/components/VerifyEmailPage"), "VerifyEmailPage");
const ContactsPage = page(() => import("@/components/ContactsPage"), "ContactsPage");
const NewLinkPage = page(() => import("@/components/NewLinkPage"), "NewLinkPage");
const RequestLinkPage = page(() => import("@/components/RequestLinkPage"), "RequestLinkPage");
const AccountPage = page(() => import("@/components/AccountPage"), "AccountPage");
const InboxPage = page(() => import("@/components/InboxPage"), "InboxPage");

/** Flode: skeletons in `muted` while a page chunk loads, never a full-page spinner. */
function PageSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-[1168px] flex-col gap-4 px-4 py-6 md:px-6 md:py-12" role="status" aria-busy="true">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-80 max-w-full" />
      <Skeleton className="mt-4 h-48 w-full rounded-lg" />
    </div>
  );
}

function Footer() {
  const { t } = useTranslation("common");
  return (
    <footer className="border-t">
      <div className="mx-auto flex max-w-[1168px] flex-wrap justify-between gap-4 px-4 py-4 text-xs leading-4 text-muted-foreground md:px-6">
        <span>{t("footer.selfHosted")}</span>
        <a href="https://github.com/bjafl/e2ee-drop" rel="noreferrer" target="_blank">
          {t("footer.source")}
        </a>
      </div>
    </footer>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <div className="flex min-h-svh flex-col">
        <NavBar />
        <div className="flex-1">
          <Suspense fallback={<PageSkeleton />}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/create" element={<CreateLinkPage />} />
            <Route path="/send/:slug" element={<UploadPage />} />
            <Route path="/receive/:slug" element={<ReceivePage />} />
            <Route path="/contacts" element={<ContactsPage />} />
            <Route path="/links/new" element={<NewLinkPage />} />
            <Route path="/links/request" element={<RequestLinkPage />} />
            <Route path="/account" element={<AccountPage />} />
            <Route path="/inbox" element={<InboxPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/reset-password" element={<RequestPasswordResetPage />} />
            <Route path="/reset-password/confirm" element={<ConfirmPasswordResetPage />} />
            <Route path="/verify-email/confirm" element={<VerifyEmailPage />} />
          </Routes>
          </Suspense>
        </div>
        <Footer />
      </div>
    </AuthProvider>
  );
}
