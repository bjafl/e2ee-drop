import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import commonEn from "./locales/en/common.json";
import commonNb from "./locales/nb/common.json";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: "en",
    resources: {
      en: { common: commonEn },
      nb: { common: commonNb },
    },
    interpolation: { escapeValue: false },
  });

export default i18n;
