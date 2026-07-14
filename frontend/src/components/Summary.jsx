import useSWR from 'swr';
import { apiFetcher, getErrorMessage } from '../lib/api';
import { formatYen } from '../lib/format';
import { EmptyState, LoadingState, ScreenIntro, StatusNotice } from './States';

export default function Summary({ currentUser }) {
  const { data, error, isLoading, isValidating, mutate } = useSWR(
    '/api/orders/summary',
    apiFetcher,
    { refreshInterval: 15000, revalidateOnFocus: true },
  );
  const people = Array.isArray(data?.data) ? data.data : [];
  const groupTotal = people.reduce((sum, person) => sum + Number(person.total_price || 0), 0);

  return (
    <section className="screen summary-screen">
      <ScreenIntro
        eyebrow={`${currentUser.group_id} 会計`}
        title="グループの支払い額"
        description="取消済みを除いた注文を、参加者ごとに集計しています。会計前に最新の金額を確認してください。"
        action={(
          <button type="button" className="secondary-button compact-button" onClick={() => mutate()} disabled={isValidating}>
            {isValidating ? '更新中…' : '今すぐ更新'}
          </button>
        )}
      />

      <StatusNotice tone="warning" title="22時以降の深夜料金は合計に含まれません">
        22時以降の注文には、店舗で10%が加算されます。最後の支払額は店員の伝票でも確認してください。
      </StatusNotice>

      {isLoading ? (
        <LoadingState label="会計を集計しています" />
      ) : error ? (
        <StatusNotice tone="danger" title="会計を読み込めませんでした" live>
          {getErrorMessage(error, '通信状態を確認して、もう一度お試しください。')}
        </StatusNotice>
      ) : people.length === 0 ? (
        <EmptyState title="まだ注文はありません" description="注文すると、ここに参加者ごとの金額が表示されます。" />
      ) : (
        <>
          <article className="summary-total-card" aria-label="グループ会計の合計">
            <div className="summary-total-heading">
              <div>
                <span>{currentUser.group_id}の合計</span>
                <small>取消済みの注文は含みません</small>
              </div>
              <strong>{formatYen(groupTotal)}</strong>
            </div>
            <dl>
              <div><dt>支払い対象</dt><dd>{people.length}人</dd></div>
              <div><dt>自動更新</dt><dd>15秒ごと</dd></div>
            </dl>
          </article>

          <section className="summary-people" aria-labelledby="summary-people-heading">
            <h2 id="summary-people-heading">参加者ごとの金額</h2>
            <ul className="summary-people-list">
              {people.map((person) => (
                <li key={person.name}>
                  <span>{person.name}</span>
                  <strong>{formatYen(person.total_price)}</strong>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </section>
  );
}
