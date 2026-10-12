const SUPPORTED = ['nl', 'en'];
let dict = {};
let lang = 'nl';

export function detectLang() {
  let saved = null;
  try { saved = localStorage.getItem('ml.lang'); } catch {}
  if (SUPPORTED.includes(saved)) return saved;
  const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return SUPPORTED.includes(nav) ? nav : 'en';
}

export async function setLang(code) {
  lang = SUPPORTED.includes(code) ? code : 'en';
  try { localStorage.setItem('ml.lang', lang); } catch {}
  const res = await fetch(`i18n/${lang}.json`);
  dict = await res.json();
  document.documentElement.lang = lang;
  document.title = dict['app.doctitle'] ?? document.title;
  applyI18n();
}

export function getLang() { return lang; }

export function t(key, vars = {}) {
  let s = dict[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  root.querySelectorAll('[data-i18n-aria-label]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel)); });
}
