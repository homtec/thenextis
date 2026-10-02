// Generates public/cuisines.json: searchable cuisines, food types and diets with labels in
// every UI language. Labels come from the iD editor's community translations
// (@openstreetmap/id-tagging-schema); `terms` adds everyday words iD doesn't have
// ("Grieche", "Döner"). Run with `npm run cuisines` after changing the list below.
import { writeFileSync } from 'node:fs';

const SCHEMA = 'https://cdn.jsdelivr.net/npm/@openstreetmap/id-tagging-schema@6.19.2/dist/translations';
const LANGS = ['en', 'de', 'es', 'fr', 'ru', 'it', 'pl', 'uk', 'nl', 'pt', 'tr'];

// id: iD option to take labels from (cuisine field, or diet field for diet entries)
// cuisine: OSM cuisine values to search for; diet: diet:<value>=yes|only
// amenity: extra amenity values that also match (e.g. amenity=ice_cream shops)
// terms: extra search words in any language, matched by word prefix
const ENTRIES = [
  // national and regional cuisines
  { id: 'chinese', cuisine: ['chinese'], terms: ['chinese', 'chinesen'] },
  { id: 'italian', cuisine: ['italian'], terms: ['italiener', 'pasta', 'trattoria'] },
  { id: 'mexican', cuisine: ['mexican', 'tex-mex'], terms: ['mexikaner', 'burrito', 'taco'] },
  { id: 'japanese', cuisine: ['japanese', 'sushi', 'ramen'], terms: ['japaner'] },
  { id: 'indian', cuisine: ['indian', 'curry'], terms: ['inder', 'curry'] },
  { id: 'american', cuisine: ['american', 'diner'] },
  { id: 'asian', cuisine: ['asian', 'chinese', 'thai', 'vietnamese', 'japanese', 'korean', 'sushi', 'indonesian', 'filipino', 'malaysian'], terms: ['asiate', 'asiaten', 'asia'] },
  { id: 'thai', cuisine: ['thai'], terms: ['thailänder'] },
  { id: 'korean', cuisine: ['korean'], terms: ['koreaner'] },
  { id: 'french', cuisine: ['french'], terms: ['franzose', 'franzosen', 'bistro'] },
  { id: 'greek', cuisine: ['greek'], terms: ['grieche', 'griechen', 'gyros', 'souvlaki'] },
  { id: 'vietnamese', cuisine: ['vietnamese'], terms: ['vietnamese', 'vietnamesen', 'pho'] },
  { id: 'german', cuisine: ['german', 'bavarian'], terms: ['deutsche küche', 'gutbürgerlich', 'currywurst'] },
  { id: 'turkish', cuisine: ['turkish', 'kebab'], terms: ['türke', 'türken'] },
  { id: 'spanish', cuisine: ['spanish', 'tapas'], terms: ['spanier'] },
  { id: 'mediterranean', cuisine: ['mediterranean'] },
  { id: 'lebanese', cuisine: ['lebanese'], terms: ['libanese', 'libanesen'] },
  { id: 'middle_eastern', cuisine: ['middle_eastern', 'lebanese', 'arab', 'persian', 'oriental', 'shawarma'], terms: ['orientalisch', 'falafel', 'hummus'] },
  { id: 'georgian', cuisine: ['georgian'] },
  { id: 'portuguese', cuisine: ['portuguese'], terms: ['portugiese'] },
  { id: 'indonesian', cuisine: ['indonesian'] },
  { id: 'filipino', cuisine: ['filipino'] },
  { id: 'african', cuisine: ['african', 'ethiopian', 'moroccan'], terms: ['afrikaner'] },
  { id: 'ethiopian', cuisine: ['ethiopian'] },
  { id: 'persian', cuisine: ['persian'], terms: ['perser', 'iranisch', 'iranian'] },
  { id: 'balkan', cuisine: ['balkan'], terms: ['jugoslawisch', 'ćevapi', 'cevapcici'] },
  { id: 'russian', cuisine: ['russian'] },
  { id: 'ukrainian', cuisine: ['ukrainian'] },
  { id: 'polish', cuisine: ['polish'], terms: ['pole', 'polen'] },
  { id: 'peruvian', cuisine: ['peruvian'] },
  { id: 'austrian', cuisine: ['austrian'], terms: ['österreicher', 'schnitzel'] },
  { id: 'british', cuisine: ['british', 'fish_and_chips'] },
  // food types
  { id: 'pizza', cuisine: ['pizza'], terms: ['pizzeria'] },
  { id: 'burger', cuisine: ['burger'], terms: ['hamburger'] },
  { id: 'sandwich', cuisine: ['sandwich'], terms: ['sub'] },
  { id: 'chicken', cuisine: ['chicken', 'wings'], terms: ['hähnchen', 'hühnchen', 'brathähnchen'] },
  { id: 'kebab', cuisine: ['kebab', 'shawarma'], terms: ['döner', 'doner', 'dürüm', 'durum', 'kebap'] },
  { id: 'sushi', cuisine: ['sushi'] },
  { id: 'seafood', cuisine: ['seafood', 'fish', 'fish_and_chips'], terms: ['fisch', 'meeresfrüchte'] },
  { id: 'ice_cream', cuisine: ['ice_cream', 'frozen_yogurt'], amenity: ['ice_cream'], terms: ['eis', 'eisdiele', 'eiscafé', 'gelato'] },
  { id: 'bubble_tea', cuisine: ['bubble_tea'] },
  { id: 'barbecue', cuisine: ['barbecue', 'grill'], terms: ['bbq', 'grill'] },
  { id: 'steak_house', cuisine: ['steak_house'], terms: ['steak'] },
  { id: 'noodle', cuisine: ['noodle', 'ramen', 'udon', 'soba'], terms: ['nudeln'] },
  { id: 'ramen', cuisine: ['ramen'] },
  { id: 'friture', cuisine: ['friture', 'fries'], terms: ['pommes', 'fritten', 'frietkot'] },
  { id: 'breakfast', cuisine: ['breakfast', 'brunch'], terms: ['frühstück', 'brunch'] },
  { id: 'crepe', cuisine: ['crepe', 'pancake'], terms: ['crêpes', 'pfannkuchen'] },
  { id: 'bagel', cuisine: ['bagel'] },
  { id: 'donut', cuisine: ['donut'], terms: ['doughnut'] },
  { id: 'cake', cuisine: ['cake', 'dessert', 'pastry'], terms: ['kuchen', 'torte', 'konditorei'] },
  // diets (diet:* tags, not cuisine)
  { id: 'vegan', diet: 'vegan', terms: ['vegan'] },
  { id: 'vegetarian', diet: 'vegetarian', terms: ['vegetarisch', 'veggie'] },
];

// iD labels that need a fix (missing or untranslated in iD)
const LABEL_OVERRIDES = {
  de: { vegetarian: 'Vegetarisch' },
};

const capitalize = (s) => s.charAt(0).toLocaleUpperCase() + s.slice(1);
// "Греческая кухня" → "Греческая": the search UI already says it's about food
const tidy = (s) => capitalize(s.replace(/\s+(кухня|кухні|страви|диета|дієта)$/i, ''));

const labels = {};
for (const lang of LANGS) {
  const res = await fetch(`${SCHEMA}/${lang}.min.json`);
  if (!res.ok) throw new Error(`${lang}: HTTP ${res.status}`);
  const fields = Object.values(await res.json())[0].presets.fields;
  for (const entry of ENTRIES) {
    const options = entry.diet ? fields.diet_multi?.options : fields.cuisine?.options;
    const label = LABEL_OVERRIDES[lang]?.[entry.id] ?? options?.[entry.id];
    if (label) (labels[entry.id] ??= {})[lang] = tidy(label);
  }
}

const out = {};
for (const { id, ...entry } of ENTRIES) {
  if (!labels[id]?.en) throw new Error(`no English label for ${id}`);
  out[id] = { ...entry, labels: labels[id] };
}
writeFileSync('public/cuisines.json', JSON.stringify(out, null, 1) + '\n');
const missing = ENTRIES.flatMap(e => LANGS.filter(l => !labels[e.id][l]).map(l => `${e.id}:${l}`));
console.log(`public/cuisines.json: ${ENTRIES.length} entries; labels falling back to English: ${missing.join(', ') || 'none'}`);
