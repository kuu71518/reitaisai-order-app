import React from 'react';
import useSWR from 'swr';

const API_URL = import.meta.env.VITE_API_URL;
const fetcher = (url) => fetch(url).then(res => res.json());

export default function Summary() {
  // 1. 通常の注文集計
  const { data: summaryData } = useSWR(`${API_URL}/api/orders/summary`, fetcher, { refreshInterval: 5000 });
  // 2. 取消履歴（マイナス分）
  const { data: cancelledData } = useSWR(`${API_URL}/api/cancelled-orders`, fetcher, { refreshInterval: 5000 });

  const summary = summaryData?.data || [];
  const cancelled = cancelledData?.data || [];

  const totalAmount = summary.reduce((sum, item) => sum + item.total_price, 0);
  const cancelledTotal = cancelled.reduce((sum, item) => sum + item.price, 0);
  const netTotal = totalAmount - cancelledTotal;

  return (
    <div className="space-y-6 pb-24 p-2">
      <h2 className="text-xl font-black text-gray-800">現在の会計状況</h2>

      {/* 合計金額カード */}
      <div className="bg-white border-2 border-blue-500 rounded-2xl p-6 shadow-sm">
        <div className="flex justify-between text-sm text-gray-500 mb-1">
          <span>注文合計額</span>
          <span>¥{totalAmount.toLocaleString()}</span>
        </div>
        <div className="flex justify-between text-sm text-red-500 mb-3 font-bold italic">
          <span>誤注文取消分</span>
          <span>- ¥{cancelledTotal.toLocaleString()}</span>
        </div>
        <div className="border-t pt-3 flex justify-between items-center">
          <span className="font-bold text-gray-700">実支払い合計</span>
          <span className="text-3xl font-black text-blue-600">¥{netTotal.toLocaleString()}</span>
        </div>
      </div>

      {/* 取消履歴（なぜ金額が減ったかの証拠） */}
      {cancelled.length > 0 && (
        <div className="bg-red-50 border border-red-100 rounded-xl p-4">
          <h3 className="text-xs font-bold text-red-600 mb-2 uppercase tracking-wider">取消履歴（マイナス内訳）</h3>
          <div className="space-y-1">
            {cancelled.map(c => (
              <div key={c.id} className="text-[11px] text-red-500 flex justify-between border-b border-red-100 pb-1">
                <span>{c.user_name}: {c.item_name}</span>
                <span className="font-bold">-¥{c.price.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )} {/* ← ここの閉じカッコ `)}` が `</div>` になってしまっていたのが原因です！ */}

      {/* 個人別の支払い目安 */}
      <div className="bg-white border rounded-xl p-4 shadow-sm">
        <h3 className="font-bold text-gray-700 mb-4 border-b pb-2">個人別集計（取消反映済）</h3>
        <div className="space-y-3">
          {summary.map(user => {
            // その人の取消分を計算
            const userCancelled = cancelled
              .filter(c => c.user_name === user.name)
              .reduce((sum, c) => sum + c.price, 0);
            
            return (
              <div key={user.name} className="flex justify-between items-center">
                <span className="font-medium text-gray-600">{user.name}</span>
                <span className="font-black text-gray-800">¥{(user.total_price - userCancelled).toLocaleString()}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}