// UI language, translations and locale-aware formatting.
// Translations live in /locales/<lang>.js; keys missing there fall back to English.
import en from '../locales/en.js';

export const SUPPORTED_LANGS = ['en', 'de', 'es', 'fr', 'ru', 'it', 'pl', 'uk', 'nl', 'pt', 'tr'];

// ?lang=de overrides the browser languages (handy for testing and sharing)
const override = new URLSearchParams(window.location.search).get('lang');
const browserLangs = [override, ...(navigator.languages || [navigator.language])].filter(Boolean);
const prefix = (l) => l.slice(0, 2).toLowerCase();

// The user's first language, even if the UI isn't translated into it. Content that has
// more translations than the UI (category names, Photon place names) prefers this one.
export const PREFERRED_LANG = prefix(browserLangs[0] || 'en');

export const LANG = browserLangs.map(prefix).find(l => SUPPORTED_LANGS.includes(l)) || 'en';

// Full locale for formatting, e.g. 'en-GB' (24h clock) rather than plain 'en' (12h)
export const LOCALE = browserLangs.find(l => prefix(l) === LANG) || LANG;

// Photon only knows a few languages and rejects others with HTTP 400
export const PHOTON_LANG = ['de', 'en', 'fr'].includes(PREFERRED_LANG) ? PREFERRED_LANG : 'default';

const messages = LANG === 'en' ? en : (await import(`../locales/${LANG}.js`)).default;
const pluralRules = new Intl.PluralRules(LOCALE);

// t('search.results', { count: 3 }) → "3 results". Plural messages are objects keyed by
// Intl.PluralRules categories ({ one, other, ... }); {name} placeholders are filled from params.
export function t(key, params = {}) {
  let msg = messages[key] ?? en[key] ?? key;
  if (typeof msg === 'object') {
    msg = msg[pluralRules.select(params.count)] ?? msg.other;
  }
  return msg.replace(/\{(\w+)\}/g, (match, name) => (name in params ? params[name] : match));
}

// Human label for an OSM value / map feature type ("pharmacy" → "Apotheke"),
// falling back to the value itself in title case
export function typeLabel(value) {
  if (!value) return t('place.fallbackType');
  return messages.types?.[value] ?? en.types[value]
    ?? value.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

const timeFormat = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' });
const weekdayFormat = new Intl.DateTimeFormat(LOCALE, { weekday: 'long' });
const dateFormat = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium' });

export const formatTime = (date) => timeFormat.format(date);
export const formatWeekday = (date) => weekdayFormat.format(date);
export const formatDate = (date) => dateFormat.format(date);
// 350 → "350 m", 1234 → "1.2 km" (localized number and unit)
export function formatDistance(meters) {
  if (meters < 1000) {
    return (Math.round(meters / 10) * 10).toLocaleString(LOCALE, { style: 'unit', unit: 'meter' });
  }
  const km = meters / 1000;
  return km.toLocaleString(LOCALE, { style: 'unit', unit: 'kilometer', maximumFractionDigits: km < 10 ? 1 : 0 });
}

export const formatNumber = (n, digits = 0) =>
  n.toLocaleString(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits });

// Fills elements marked with data-i18n (text), data-i18n-placeholder, data-i18n-title
// and data-i18n-aria-label in the static HTML
export function translateDocument(root = document) {
  document.documentElement.lang = LANG;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
}
