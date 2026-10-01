// Lists translation keys that are missing from (or unknown to) each locale compared to
// English. Run with `npm run i18n:check`; exits non-zero if anything is missing.
import { readdirSync } from 'node:fs';

const dir = new URL('../public/locales/', import.meta.url);
const flatten = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) =>
  // types.* and plural objects ({ one, other }) are compared key by key
  v && typeof v === 'object' ? flatten(v, `${prefix}${k}.`) : [`${prefix}${k}`]);

const en = new Set(flatten((await import(new URL('en.js', dir))).default));
let problems = 0;
for (const file of readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'en.js')) {
  const keys = new Set(flatten((await import(new URL(file, dir))).default));
  // Plural categories legitimately differ between languages (e.g. 'few' in Russian)
  const isPlural = (k) => /\.(zero|one|two|few|many|other)$/.test(k);
  const missing = [...en].filter(k => !keys.has(k) && !isPlural(k));
  const unknown = [...keys].filter(k => !en.has(k) && !isPlural(k));
  console.log(`${file}: ${missing.length} missing, ${unknown.length} unknown`);
  missing.forEach(k => console.log(`  missing  ${k}`));
  unknown.forEach(k => console.log(`  unknown  ${k}`));
  problems += missing.length;
}
process.exit(problems ? 1 : 0);
