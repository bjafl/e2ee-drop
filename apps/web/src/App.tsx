import { useTranslation } from "react-i18next";

export default function App() {
  const { t } = useTranslation("common");
  return <div className="p-4">{t("appName")}</div>;
}
