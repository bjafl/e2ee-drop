import { Routes, Route } from "react-router-dom";
import { HomePage } from "@/components/HomePage";
import { CreateLinkPage } from "@/components/CreateLinkPage";
import { UploadPage } from "@/components/UploadPage";
import { DownloadPage } from "@/components/DownloadPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/create" element={<CreateLinkPage />} />
      <Route path="/send/:slug" element={<UploadPage />} />
      <Route path="/download/:slug" element={<DownloadPage />} />
    </Routes>
  );
}
