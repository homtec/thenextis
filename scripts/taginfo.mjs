// Generates public/taginfo.json (https://wiki.openstreetmap.org/wiki/Taginfo/Projects)
// from the categories in public/content.json and the cuisine search in public/cuisines.json.
// Run with `npm run taginfo`.
import { readFileSync, writeFileSync } from 'node:fs';

const content = JSON.parse(readFileSync('public/content.json', 'utf8'));
const cuisines = JSON.parse(readFileSync('public/cuisines.json', 'utf8'));

// loadPOIs() queries every tag as both node[...] and way[...]
const OBJECT_TYPES = ['node', 'way'];

const tags = new Map();
for (const category of Object.values(content)) {
  for (const raw of category.osm.split(';')) {
    const [key, value] = raw.trim().split('=');
    if (!key) continue;
    const id = value ? `${key}=${value}` : key;
    if (!tags.has(id)) tags.set(id, { key, value, labels: [] });
    tags.get(id).labels.push(category['lang-en']);
  }
}

// searchCuisine() queries cuisine=*, diet:*=yes|only and extra amenity values
const addTag = (key, value, label) => {
  const id = value ? `${key}=${value}` : key;
  if (!tags.has(id)) tags.set(id, { key, value, labels: [] });
  if (!tags.get(id).labels.includes(label)) tags.get(id).labels.push(label);
};
for (const entry of Object.values(cuisines)) {
  const label = entry.labels.en;
  for (const value of entry.cuisine || []) addTag('cuisine', value, label);
  for (const value of entry.amenity || []) addTag('amenity', value, label);
  if (entry.diet) {
    addTag(`diet:${entry.diet}`, 'yes', label);
    addTag(`diet:${entry.diet}`, 'only', label);
  }
}

const taginfo = {
  data_format: 1,
  data_url: 'https://thenextis.com/taginfo.json',
  project: {
    name: 'TheNextIs',
    description: 'Finds the nearest points of interest of a chosen category on a map.',
    project_url: 'https://thenextis.com',
    icon_url: 'https://thenextis.com/favicon.ico',
    contact_name: 'Thomas Hecker',
    contact_email: 'hello@thomashecker.net',
  },
  tags: [...tags.values()]
    .sort((a, b) => a.key.localeCompare(b.key) || (a.value || '').localeCompare(b.value || ''))
    .map(({ key, value, labels }) => ({
      key,
      ...(value && { value }),
      object_types: OBJECT_TYPES,
      description: `Shown when searching for: ${labels.join(', ')}`,
    })),
};

writeFileSync('public/taginfo.json', JSON.stringify(taginfo, null, 2) + '\n');
console.log(`public/taginfo.json: ${taginfo.tags.length} tags`);
