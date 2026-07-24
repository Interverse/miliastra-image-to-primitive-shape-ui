/*
 * i18n.js — localization runtime.
 *
 * Locales register themselves on window.LOCALES (see js/locales/*.js).
 * English is the fallback for any missing key. Language choice persists in
 * localStorage and defaults from navigator.language.
 *
 * Usage:
 *   I18N.t("upload.title")                  → translated string
 *   I18N.t("batch.jobCount", {n: 3})        → params via {name}
 *   <span data-i18n="upload.title"></span>  → auto-applied on setLang
 *   <input data-i18n-placeholder="k">, <el data-i18n-title="k">
 */
"use strict";

window.LOCALES = window.LOCALES || {};

const I18N = (() => {
  const STORAGE_KEY = "shaper_lang";
  const FALLBACK = "en";

  /* Order matches Genshin Impact's official language list. */
  const LANGUAGES = [
    { code: "en", name: "English" },
    { code: "zh-CN", name: "简体中文" },
    { code: "zh-TW", name: "繁體中文" },
    { code: "ja", name: "日本語" },
    { code: "ko", name: "한국어" },
    { code: "fr", name: "Français" },
    { code: "de", name: "Deutsch" },
    { code: "es", name: "Español" },
    { code: "pt", name: "Português" },
    { code: "ru", name: "Русский" },
    { code: "th", name: "ภาษาไทย" },
    { code: "vi", name: "Tiếng Việt" },
    { code: "id", name: "Bahasa Indonesia" },
    { code: "tr", name: "Türkçe" },
    { code: "it", name: "Italiano" },
  ];

  let current = FALLBACK;
  const listeners = [];

  function detectLanguage() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && window.LOCALES[stored]) return stored;
    const navLangs = navigator.languages || [navigator.language || "en"];
    for (const raw of navLangs) {
      const lang = String(raw);
      // exact match first (zh-CN, zh-TW, pt-BR→pt...)
      if (window.LOCALES[lang]) return lang;
      const lower = lang.toLowerCase();
      if (lower.startsWith("zh")) {
        // Traditional for TW/HK/MO/Hant, Simplified otherwise
        if (/tw|hk|mo|hant/.test(lower)) return "zh-TW";
        return "zh-CN";
      }
      const base = lang.split("-")[0];
      if (window.LOCALES[base]) return base;
    }
    return FALLBACK;
  }

  function t(key, params) {
    const table = window.LOCALES[current] || {};
    const fallbackTable = window.LOCALES[FALLBACK] || {};
    let value = table[key];
    if (value === undefined) value = fallbackTable[key];
    if (value === undefined) return key;
    if (params) {
      for (const name of Object.keys(params)) {
        value = value.split("{" + name + "}").join(String(params[name]));
      }
    }
    return value;
  }

  function apply(root) {
    const scope = root || document;
    scope.querySelectorAll("[data-i18n]").forEach((node) => {
      node.textContent = t(node.getAttribute("data-i18n"));
    });
    scope.querySelectorAll("[data-i18n-html]").forEach((node) => {
      node.innerHTML = t(node.getAttribute("data-i18n-html"));
    });
    scope.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
      node.placeholder = t(node.getAttribute("data-i18n-placeholder"));
    });
    scope.querySelectorAll("[data-i18n-title]").forEach((node) => {
      node.title = t(node.getAttribute("data-i18n-title"));
    });
    scope.querySelectorAll("[data-i18n-aria-label]").forEach((node) => {
      node.setAttribute("aria-label", t(node.getAttribute("data-i18n-aria-label")));
    });
  }

  function setLang(code) {
    if (!window.LOCALES[code]) code = FALLBACK;
    current = code;
    localStorage.setItem(STORAGE_KEY, code);
    document.documentElement.lang = code;
    apply();
    listeners.forEach((fn) => fn(code));
  }

  function onChange(fn) { listeners.push(fn); }

  function init() {
    current = detectLanguage();
    document.documentElement.lang = current;
    apply();
  }

  return {
    t, apply, setLang, onChange, init,
    get lang() { return current; },
    LANGUAGES,
  };
})();
