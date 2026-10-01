import useSWR from 'swr';
import { apiFetcher, getErrorMessage } from '../lib/api';
import { formatYen } from '../lib/format';
import { EmptyState, LoadingState, ScreenIntro, StatusNotice } from './States';

export default function Summary({ currentUser }) {
  const { data, error, isLoading, isValidating, mutate } = useSWR(
    ['/api/orders/summary', currentUser.id, currentUser.group_id, currentUser.role],
    apiFetcher,
    { refreshInterval: 15000, revalidateOnFocus: true },
  );
  const people = Array.isArray(data?.data) ? data.data : [];
  const groupTotal = people.reduce((sum, person) => sum + Number(person.total_price || 0), 0);

  return (
    <section className="screen summary-screen">
      <ScreenIntro
        eyebrow={`${currentUser.group_id} 会計`}
        title="グループの注文合計（目安）"
        description="担当者が確認中の注文も含め、取消済みを除いて集計しています。店舗への最終支払額は、店員の伝票で確認してください。"
        action={(
          <button type="button" className="secondary-button compact-button" onClick={() => mutate()} disabled={isValidating}>
            {isValidating ? '更新中…' : '今すぐ更新'}
          </button>
        )}
      />

      <StatusNotice tone="warning" title="席料・深夜料金などは自動計算しません">
        公式案内にはテーブルチャージと22時以降の注文への深夜料金10%が掲載されています。今回は単品注文です。席料などの追加料金は、店舗の伝票で確認してください。
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
                <small>確認中を含む注文合計・追加料金は別途確認</small>
              </div>
              <strong>{formatYen(groupTotal)}</strong>
            </div>
            <dl>
              <div><dt>注文のある参加者</dt><dd>{people.length}人</dd></div>
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
