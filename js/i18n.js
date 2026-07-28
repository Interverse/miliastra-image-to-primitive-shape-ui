/*
 * i18n.js — localization runtime.
 *
 * Locales register themselves on window.LOCALES (see js/locales/*.js).
 * English is the fallback for any missing key. Language choice persists in
 * the toolkit-wide "miliastra-lang" localStorage entry (shared by all
 * Miliastra Toolkit sites on this origin — see docs/language-sync.md) and
 * defaults from navigator.language.
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
  /* Toolkit-wide shared preference (docs/language-sync.md). The shared key
   * stores canonical codes (zhs/zht for Chinese); this site keeps its
   * internal zh-CN/zh-TW codes and translates at the storage boundary. */
  const SHARED_KEY = "miliastra-lang";
  const LEGACY_KEY = "shaper_lang"; // pre-toolkit key; migrated once, then unused
  const CANONICAL_LANGS = [
    "en", "zhs", "zht", "ja", "ko", "es", "fr", "ru",
    "th", "vi", "de", "id", "pt", "tr", "it",
  ];
  const CANONICAL_TO_INTERNAL = { zhs: "zh-CN", zht: "zh-TW" };
  const INTERNAL_TO_CANONICAL = { "zh-CN": "zhs", "zh-TW": "zht" };
  const toInternal = (code) => CANONICAL_TO_INTERNAL[code] || code;
  const toCanonical = (code) => INTERNAL_TO_CANONICAL[code] || code;
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
    try {
      // 1. Toolkit-wide preference; ignore (don't delete) invalid values.
      const shared = localStorage.getItem(SHARED_KEY);
      if (CANONICAL_LANGS.includes(shared)) {
        const internal = toInternal(shared);
        if (window.LOCALES[internal]) return internal;
      }
      // 2. One-time migration of this site's old key.
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy && window.LOCALES[legacy]) {
        localStorage.setItem(SHARED_KEY, toCanonical(legacy));
        localStorage.removeItem(LEGACY_KEY);
        return legacy;
      }
    } catch (e) { /* storage unavailable — fall back to detection */ }
    // 3. Browser language auto-detection (not persisted).
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

  function applyLang(code) {
    current = code;
    document.documentElement.lang = code;
    apply();
    listeners.forEach((fn) => fn(code));
  }

  function setLang(code) {
    if (!window.LOCALES[code]) code = FALLBACK;
    try { localStorage.setItem(SHARED_KEY, toCanonical(code)); } catch (e) {}
    applyLang(code);
  }

  function onChange(fn) { listeners.push(fn); }

  function init() {
    current = detectLanguage();
    document.documentElement.lang = current;
    apply();
    // Live sync: language picked on another toolkit site/tab applies here
    // without a reload. Must never write back to localStorage.
    window.addEventListener("storage", (e) => {
      if (e.key !== SHARED_KEY || !CANONICAL_LANGS.includes(e.newValue)) return;
      const internal = toInternal(e.newValue);
      if (window.LOCALES[internal] && internal !== current) applyLang(internal);
    });
  }

  return {
    t, apply, setLang, onChange, init,
    get lang() { return current; },
    LANGUAGES,
  };
})();
