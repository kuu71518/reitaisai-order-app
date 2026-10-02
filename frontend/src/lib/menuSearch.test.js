import assert from 'node:assert/strict';
import test from 'node:test';
import { getMenuSearchSuggestions, menuGroupMatchesSearch, normalizeMenuSearch } from './menuSearch.js';

const beer = {
  name: 'キリン一番搾り（生）', category: 'ビール',
  variations: [{ size: '通常' }, { size: 'バカ' }],
};
const nonAlcohol = {
  name: 'グリーンズフリー（小瓶）', category: 'ビール', variations: [{ size: 'ノンアルコール' }],
};
const groups = [
  beer, nonAlcohol,
  { name: '生レモンサワー', category: 'サワー', variations: [{ size: '通常' }, { size: 'バカ' }] },
  { name: 'バカ盛り唐揚げ', category: '名物', variations: [{ size: '大' }] },
  { name: 'コーラ', category: 'ソフトドリンク', variations: [{ size: '通常' }] },
];

test('beer category finds products whose names do not contain beer', () => {
  assert.deepEqual(groups.filter((group) => menuGroupMatchesSearch(group, 'ビール')), [beer, nonAlcohol]);
});

test('full-width, half-width and hiragana queries match the same menu category', () => {
  for (const query of ['ﾋﾞｰﾙ', 'びーる', ' ビール　']) {
    assert.equal(menuGroupMatchesSearch(beer, query), true, query);
  }
  assert.equal(normalizeMenuSearch('ＡＢＣ　ﾊﾞｶ'), 'abc ばか');
});

test('spaces combine category, name and size using AND without altering original data', () => {
  const before = structuredClone(beer);
  assert.equal(menuGroupMatchesSearch(beer, 'ビール　キリン バカ'), true);
  assert.equal(menuGroupMatchesSearch(nonAlcohol, 'ビール バカ'), false);
  assert.equal(menuGroupMatchesSearch(beer, 'ビール サワー'), false);
  assert.deepEqual(beer, before);
});

test('search tolerates spaces inside menu labels and empty queries keep all groups', () => {
  assert.equal(menuGroupMatchesSearch({ name: 'レモン ハイボール', category: '飲み物' }, 'れもんはいぼーる'), true);
  assert.deepEqual(groups.filter((group) => menuGroupMatchesSearch(group, '　 ')), groups);
  assert.equal(menuGroupMatchesSearch(beer, '架空不存在商品'), false);
});

test('predictive results put categories first and include matching products', () => {
  const suggestions = getMenuSearchSuggestions(groups, 'びー');
  assert.equal(suggestions[0].kind, 'category');
  assert.equal(suggestions[0].label, 'ビール');
  assert.deepEqual(new Set(suggestions.slice(1).map((item) => item.label)), new Set([beer.name, nonAlcohol.name]));
});

test('product prefix comes before a longer product containing the query', () => {
  const suggestions = getMenuSearchSuggestions([
    { name: '生レモンサワー', category: 'サワー' },
    { name: 'レモンサワー', category: 'サワー' },
  ], 'れもん');
  assert.deepEqual(suggestions.map((item) => item.label), ['レモンサワー', '生レモンサワー']);
});

test('duplicate size rows produce one product suggestion but different categories stay distinct', () => {
  const suggestions = getMenuSearchSuggestions([beer, { ...beer }, { ...beer, category: '限定' }], 'キリン');
  assert.equal(suggestions.length, 2);
  assert.equal(new Set(suggestions.map((item) => item.key)).size, 2);
});

test('selected category restricts products while a category suggestion can switch the filter', () => {
  const suggestions = getMenuSearchSuggestions(groups, 'ビール', { category: '名物' });
  assert.deepEqual(suggestions.map((item) => [item.kind, item.category]), [['category', 'ビール']]);
});

test('multiple terms and size produce applicable product suggestions without false category options', () => {
  const suggestions = getMenuSearchSuggestions(groups, 'ビール ばか');
  assert.deepEqual(suggestions.map((item) => [item.kind, item.label]), [['product', beer.name]]);
});

test('blank, unmatched and empty menus have no predictive suggestions', () => {
  for (const query of ['', '　 ', '存在しない']) assert.deepEqual(getMenuSearchSuggestions(groups, query), []);
  assert.deepEqual(getMenuSearchSuggestions([], 'ビール'), []);
});

test('suggestions are bounded and only use visible menu groups supplied by the caller', () => {
  assert.equal(getMenuSearchSuggestions(groups, 'ー', { limit: 2 }).length, 2);
  assert.deepEqual(getMenuSearchSuggestions(groups, 'ー', { limit: 0 }), []);
  assert.deepEqual(getMenuSearchSuggestions(groups, '宴会'), []);
});
