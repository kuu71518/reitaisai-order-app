// 店舗情報の出典・確認日と予約条件の扱いは docs/EVENT_VENUE.md に記録する。
export const EVENT = Object.freeze({
  date: '2026-10-04',
  dateLabel: '2026年10月4日（日）',
  orderStyle: '単品注文（コース・飲み放題なし）',
});

export const VENUE = Object.freeze({
  name: 'チバちゃん秋葉原電気街口店',
  address: '東京都千代田区外神田1-18-19',
  building: 'BiTO AKIBA 10F',
  access: 'JR秋葉原駅アトレ口より徒歩約2分',
  officialUrl: 'https://chibachan-akihabara2.owst.jp/',
});

export const VENUE_MAP_URL = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${VENUE.name} ${VENUE.address} ${VENUE.building}`)}`;
