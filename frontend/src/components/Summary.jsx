import { useState } from 'react';
import useSWR from 'swr';
import { apiFetcher, getErrorMessage } from '../lib/api';
import { formatYen } from '../lib/format';
import { canViewAllAccounting } from '../lib/orderAccess';
import { accountingGroups, accountingTotal } from '../lib/accounting';
import { EmptyState, LoadingState, ScreenIntro, StatusNotice } from './States';
import CashReceiptAction from './CashReceiptAction';
import '../styles/accounting.css';

export default function Summary({ currentUser }) {
  const allGroups = canViewAllAccounting(currentUser);
  const [selectedGroup, setSelectedGroup] = useState('');
  const [busyReceiptId, setBusyReceiptId] = useState(null);
  const { data, error, isLoading, isValidating, mutate } = useSWR(
    ['/api/orders/summary', currentUser.id, currentUser.group_id, currentUser.role],
    apiFetcher,
    { refreshInterval: 15000, revalidateOnFocus: true },
  );
  const people = Array.isArray(data?.data) ? data.data : [];
  const groups = accountingGroups(people);
  const groupFilter = allGroups && groups.some((group) => group.name === selectedGroup) ? selectedGroup : '';
  const shownPeople = groupFilter ? people.filter((person) => person.group_id === groupFilter) : people;
  const groupTotal = accountingTotal(people);

  return (
    <section className="screen summary-screen">
      <ScreenIntro
        eyebrow={allGroups ? '全グループ 会計' : `${currentUser.group_id} 会計`}
        title={allGroups ? '全参加者の会計' : 'グループの会計'}
        description="確認中の注文を含み、取消済みは除いて集計します。注文がない参加者も表示します。"
        action={<button type="button" className="secondary-button compact-button" onClick={() => mutate()} disabled={isValidating || busyReceiptId !== null}>
          {isValidating ? '更新中…' : '今すぐ更新'}
        </button>}
      />
      <StatusNotice tone="warning" title="1人につき ＋テーブルチャージ495円（税込）">
        表示金額は注文分の合計です。テーブルチャージや深夜料金などは含みません。最終支払額は店舗の伝票で確認してください。
      </StatusNotice>
      {isLoading ? <LoadingState label="会計を集計しています" /> : error ? (
        <StatusNotice tone="danger" title="会計を読み込めませんでした" live>
          {getErrorMessage(error, '通信状態を確認して、もう一度お試しください。')}
        </StatusNotice>
      ) : people.length === 0 ? (
        <EmptyState title="表示できる参加者はいません" description="参加者が登録されると、ここに金額が表示されます。" />
      ) : <>
        <article className="summary-total-card" aria-label={allGroups ? '全グループの注文合計' : 'グループの注文合計'}>
          <div className="summary-total-heading">
            <div><span>{allGroups ? '全グループ' : currentUser.group_id}の注文合計</span>
              <small>追加料金は別途・取消済みは対象外</small></div>
            <strong>{formatYen(groupTotal)}</strong>
          </div>
          <dl><div><dt>参加者</dt><dd>{people.length}人</dd></div>
            <div><dt>現金受取確認済み</dt><dd>{people.filter((person) => person.cash_received && !person.cash_amount_changed).length}人</dd></div>
            <div><dt>受取後の金額変更</dt><dd>{people.filter((person) => person.cash_amount_changed).length}人</dd></div>
            <div><dt>自動更新</dt><dd>15秒ごと</dd></div></dl>
        </article>
        {allGroups && <section className="accounting-groups" aria-labelledby="accounting-groups-heading">
          <h2 id="accounting-groups-heading">グループごとの注文合計</h2>
          <ul>{groups.map((group) => <li key={group.name}>
            <span>{group.name}<small>{group.people}人</small></span><strong>{formatYen(group.total)}</strong>
          </li>)}</ul>
        </section>}
        <section className="summary-people" aria-labelledby="summary-people-heading">
          <div className="accounting-people-heading"><h2 id="summary-people-heading">参加者ごとの注文金額</h2>
            {allGroups && <label>グループ
              <select value={groupFilter} onChange={(event) => setSelectedGroup(event.target.value)} disabled={busyReceiptId !== null}>
                <option value="">すべて</option>
                {groups.map((group) => <option key={group.name} value={group.name}>{group.name}</option>)}
              </select>
            </label>}
          </div>
          {groupFilter && <p className="accounting-filter-total">{groupFilter}：{shownPeople.length}人・{formatYen(accountingTotal(shownPeople))}</p>}
          <ul className="summary-people-list">
            {shownPeople.map((person) => <li key={person.user_id} className="accounting-person">
              <span className="accounting-person-name">{person.name}{allGroups && <small className="summary-person-group">{person.group_id}</small>}</span>
              <div className="accounting-person-amount"><strong>{formatYen(person.total_price)}</strong>
                <small>＋テーブルチャージ495円（税込）</small></div>
              <CashReceiptAction person={person} currentUser={currentUser} disabled={busyReceiptId !== null}
                onBusyChange={(value) => setBusyReceiptId(value ? person.user_id : null)} />
            </li>)}
          </ul>
        </section>
      </>}
    </section>
  );
}
