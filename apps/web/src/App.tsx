import { Routes, Route } from "react-router-dom";
import { HomePage } from "@/components/HomePage";
import { CreateLinkPage } from "@/components/CreateLinkPage";
import { UploadPage } from "@/components/UploadPage";
import { DownloadPage } from "@/components/DownloadPage";
import { RegisterPage } from "@/components/RegisterPage";
import { LoginPage } from "@/components/LoginPage";
import { RequestPasswordResetPage } from "@/components/RequestPasswordResetPage";
import { ConfirmPasswordResetPage } from "@/components/ConfirmPasswordResetPage";
import { AuthProvider } from "@/hooks/useAuth";

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/create" element={<CreateLinkPage />} />
        <Route path="/send/:slug" element={<UploadPage />} />
        <Route path="/download/:slug" element={<DownloadPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/reset-password" element={<RequestPasswordResetPage />} />
        <Route path="/reset-password/confirm" element={<ConfirmPasswordResetPage />} />
      </Routes>
    </AuthProvider>
  );
}
