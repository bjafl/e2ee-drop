import { Routes, Route } from "react-router-dom";
import { HomePage } from "@/components/HomePage";
import { CreateLinkPage } from "@/components/CreateLinkPage";
import { UploadPage } from "@/components/UploadPage";
import { ReceivePage } from "@/components/ReceivePage";
import { RegisterPage } from "@/components/RegisterPage";
import { LoginPage } from "@/components/LoginPage";
import { RequestPasswordResetPage } from "@/components/RequestPasswordResetPage";
import { ConfirmPasswordResetPage } from "@/components/ConfirmPasswordResetPage";
import { VerifyEmailPage } from "@/components/VerifyEmailPage";
import { ContactsPage } from "@/components/ContactsPage";
import { NewLinkPage } from "@/components/NewLinkPage";
import { RequestLinkPage } from "@/components/RequestLinkPage";
import { AccountPage } from "@/components/AccountPage";
import { InboxPage } from "@/components/InboxPage";
import { NavBar } from "@/components/NavBar";
import { AuthProvider } from "@/hooks/useAuth";

export default function App() {
  return (
    <AuthProvider>
      <NavBar />
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
    </AuthProvider>
  );
}
