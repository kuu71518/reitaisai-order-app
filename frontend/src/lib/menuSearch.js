// Search changes presentation only. Menu names, categories, prices and order IDs stay unchanged.
export function normalizeMenuSearch(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('ja-JP')
    .replace(/[ァ-ヶ]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0x60))
    .trim();
}

function searchTerms(query) {
  return normalizeMenuSearch(query).split(/\s+/u).filter(Boolean);
}

function matchesFields(fields, terms) {
  const normalizedFields = fields.map((field) => normalizeMenuSearch(field).replace(/\s+/gu, ''));
  return terms.every((term) => normalizedFields.some((field) => field.includes(term)));
}

export function menuGroupMatchesSearch(group, query) {
  return matchesFields([
    group.name,
    group.category,
    ...(group.variations || []).map((variation) => variation.size),
  ], searchTerms(query));
}

function nameRank(name, normalizedQuery) {
  const normalizedName = normalizeMenuSearch(name).replace(/\s+/gu, '');
  if (normalizedName === normalizedQuery) return 0;
  if (normalizedName.startsWith(normalizedQuery)) return 1;
  return 2;
}

export function getMenuSearchSuggestions(groups, query, { category = 'すべて', limit = 6 } = {}) {
  const terms = searchTerms(query);
  if (terms.length === 0 || limit <= 0) return [];
  const normalizedQuery = terms.join('');
  const categories = [...new Set(groups.map((group) => group.category).filter(Boolean))]
    .filter((name) => matchesFields([name], terms))
    .map((name) => ({ key: `category:${name}`, kind: 'category', label: name, category: name }));
  const seen = new Set();
  const products = groups
    .filter((group) => category === 'すべて' || group.category === category)
    .filter((group) => menuGroupMatchesSearch(group, query))
    .filter((group) => {
      const key = JSON.stringify([group.category, group.name]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((group) => ({
      key: `product:${JSON.stringify([group.category, group.name])}`,
      kind: 'product', label: group.name, category: group.category,
    }));
  const compare = (left, right) => nameRank(left.label, normalizedQuery) - nameRank(right.label, normalizedQuery)
    || left.label.localeCompare(right.label, 'ja-JP')
    || left.category.localeCompare(right.category, 'ja-JP');
  return [...categories.sort(compare), ...products.sort(compare)].slice(0, limit);
}
