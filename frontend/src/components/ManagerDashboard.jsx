import React, { useState, useEffect } from 'react';

const API_URL = import.meta.env.VITE_API_URL;

export default function ManagerDashboard({ currentUser }) {
  const [orders, setOrders] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  // フリー項目追加用の状態（State）
  const [groupUsers, setGroupUsers] = useState([]);
  const [customUserId, setCustomUserId] = useState('');
  const [customName, setCustomName] = useState('');
  const [customPrice, setCustomPrice] = useState('');
  const [isAddingCustom, setIsAddingCustom] = useState(false);

  // 🌟 追加：新規メンバー追加用の状態（State）
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberDiscordId, setNewMemberDiscordId] = useState('');
  const [isAddingMember, setIsAddingMember] = useState(false);

  const fetchOrders = async () => {
    try {
      const res = await fetch(`${API_URL}/api/orders?status=pending&group_id=${currentUser.group_id}`);
      const json = await res.json();
      if (json.success) setOrders(json.data || []);
    } catch (e) {
      console.error(e);
    }
  };

  // 同じグループのメンバー一覧を取得する処理
  const fetchGroupUsers = async () => {
    try {
      const res = await fetch(`${API_URL}/api/admin/users`);
      const json = await res.json();
      if (json.success) {
        // 自分の担当グループのメンバーだけに絞り込む
        const members = json.data.filter(u => u.group_id === currentUser.group_id);
        setGroupUsers(members);
        // 初期値が空、または選択中メンバーがリストにない場合は先頭をセット
        if (members.length > 0) {
          setCustomUserId(members[0].id);
        }
      }
    } catch (e) { console.error(e); }
  };

  useEffect(() => {
    setIsLoading(true);
    fetchOrders().finally(() => setIsLoading(false));
    fetchGroupUsers(); // メンバー一覧も最初に取得
    const interval = setInterval(fetchOrders, 5000); // 5秒ごとに自動更新
    return () => clearInterval(interval);
  }, [currentUser.group_id]);

  // 個数の変更（＋ / －）
  const handleUpdateQuantity = async (id, currentQty, delta) => {
    const newQty = currentQty + delta;
    if (newQty <= 0) return;

    setOrders(prev => prev.map(o => o.id === id ? { ...o, quantity: newQty } : o));
    try {
      await fetch(`${API_URL}/api/orders/${id}/quantity`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity: newQty })
      });
    } catch (e) {
      fetchOrders();
    }
  };

  // 注文の取消
  const handleDeleteOrder = async (id, userName, itemName) => {
    if (!window.confirm(`${userName}さんの「${itemName}」を取り消しますか？\n（会計からもマイナスされます）`)) return;
    try {
      const res = await fetch(`${API_URL}/api/orders/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setOrders(prev => prev.filter(o => o.id !== id));
      }
    } catch (e) {
      alert('取消に失敗しました');
    }
  };

  // 注文済みにする
  const handleMarkAsOrdered = async () => {
    if (orders.length === 0) return;
    if (!window.confirm('店員さんに注文を伝え終わりましたか？\n（このリストから消去されます）')) return;
    
    const orderIds = orders.map(o => o.id);
    try {
      const res = await fetch(`${API_URL}/api/orders/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_ids: orderIds, status: 'ordered' })
      });
      if (res.ok) setOrders([]);
    } catch (e) {
      alert('エラーが発生しました');
    }
  };

  // フリー項目を会計に追加する処理
  const handleAddCustomOrder = async () => {
    if (!customName || customPrice === '') return alert('項目名と金額を入力してください');
    
    const targetUser = groupUsers.find(u => String(u.id) === String(customUserId))?.name;

    if (!window.confirm(`${targetUser} さんの会計に\n「${customName}」 (¥${customPrice}) \nを追加しますか？`)) return;

    setIsAddingCustom(true);
    try {
      const res = await fetch(`${API_URL}/api/manager/custom-order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: customUserId,
          name: customName,
          price: parseInt(customPrice, 10)
        })
      });
      const data = await res.json();
      if (data.success) {
        alert('会計に追加しました！\n（※送信待ちリストには入らず、直接会計データに加算されます）');
        setCustomName('');
        setCustomPrice('');
        fetchGroupUsers(); // 金額更新を反映させるために再取得
      } else {
        alert('追加に失敗しました: ' + (data.message || ''));
      }
    } catch (e) {
      alert('通信エラーが発生しました');
    } finally {
      setIsAddingCustom(false);
    }
  };

  // 🌟 追加：自グループ限定のメンバー新規追加処理
  const handleAddGroupMember = async () => {
    if (!newMemberName || !newMemberDiscordId) return alert('名前とDiscord IDを入力してください');
    setIsAddingMember(true);
    try {
      const res = await fetch(`${API_URL}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newMemberName,
          group_id: currentUser.group_id, // 自分のグループに自動固定
          role: 'member',                // 一般メンバーとして登録
          discord_id: newMemberDiscordId.trim()
        })
      });
      const data = await res.json();
      if (res.ok) {
        alert(`🎉 ${newMemberName} さんを「${currentUser.group_id}」に追加しました！`);
        setNewMemberName('');
        setNewMemberDiscordId('');
        await fetchGroupUsers(); // リストを再読込して、上の特別会計のプルダウンに即時追加する
      } else {
        alert(`❌ 追加に失敗しました: ${data.message || 'すでにIDが登録されている可能性があります'}`);
      }
    } catch (e) {
      alert('❌ 通信エラーが発生しました');
    } finally {
      setIsAddingMember(false);
    }
  };

  const groupedOrders = orders.reduce((acc, order) => {
    const key = `${order.menu_name}_${order.size}`;
    if (!acc[key]) {
      acc[key] = { menu_name: order.menu_name, size: order.size, total: 0, items: [] };
    }
    acc[key].total += order.quantity;
    acc[key].items.push(order);
    return acc;
  }, {});

  return (
    <div className="space-y-6 pb-24 p-2 max-w-lg mx-auto">
      
      {/* 🛠️ 上部コントロールエリア（メンバー追加 & 特別会計） */}
      <div className="grid grid-cols-1 gap-4">
        
        {/* 🌟 新設：自グループ専用 メンバー追加カード */}
        <div className="bg-green-50 border-2 border-green-200 rounded-xl p-4 shadow-sm">
          <h2 className="text-sm font-black text-green-800 mb-1 flex items-center">
            <span className="text-lg mr-2">👤</span> 担当グループへのメンバー追加
          </h2>
          <p className="text-[10px] text-green-600 font-bold mb-3 leading-tight">
            あなたの担当している「<span className="underline decoration-2 font-black text-green-700">{currentUser.group_id}</span>」に、その場で参加者を追加できます。
          </p>
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <input 
                type="text" 
                placeholder="参加者の名前" 
                className="border border-green-200 p-2 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-green-400" 
                value={newMemberName} 
                onChange={e => setNewMemberName(e.target.value)} 
              />
              <input 
                type="text" 
                placeholder="Discord ID" 
                className="border border-green-200 p-2 rounded-lg text-sm bg-white outline-none focus:ring-2 focus:ring-green-400" 
                value={newMemberDiscordId} 
                onChange={e => setNewMemberDiscordId(e.target.value)} 
              />
            </div>
            <button 
              onClick={handleAddGroupMember} 
              disabled={isAddingMember} 
              className="w-full bg-green-600 text-white font-black py-2.5 rounded-lg text-xs shadow-sm active:scale-95 transition-all"
            >
              {isAddingMember ? '追加中...' : `このメンバーを ${currentUser.group_id} に追加`}
            </button>
          </div>
        </div>

        {/* 特別会計（フリー項目）の追加 */}
        <div className="bg-indigo-50 border-2 border-indigo-200 rounded-xl p-4 shadow-sm">
          <h2 className="text-sm font-black text-indigo-800 mb-2 flex items-center">
            <span className="text-lg mr-2">✍️</span> 特別会計（フリー項目）の追加
          </h2>
          <p className="text-[10px] text-indigo-600 font-bold mb-3 leading-tight">
            メニューにない備品代・特別注文などを、指定した人の会計に直接追加します。
          </p>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-indigo-700 whitespace-nowrap">対象者:</span>
              <select 
                className="flex-1 border border-indigo-200 p-2 rounded-lg text-sm font-bold bg-white focus:ring-indigo-500 outline-none" 
                value={customUserId} 
                onChange={e => setCustomUserId(e.target.value)}
              >
                {groupUsers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
            <div className="flex gap-2">
              <input 
                type="text" 
                placeholder="項目名 (例: 持ち込み料)" 
                className="flex-1 border p-2 rounded-lg text-sm outline-none bg-white" 
                value={customName} 
                onChange={e => setCustomName(e.target.value)} 
              />
              <div className="w-24 relative flex items-center">
                <span className="absolute left-2 text-gray-500 font-bold text-sm">¥</span>
                <input 
                  type="number" 
                  placeholder="金額" 
                  className="w-full border py-2 pr-2 pl-6 rounded-lg text-sm font-black text-red-600 bg-white" 
                  value={customPrice} 
                  onChange={e => setCustomPrice(e.target.value)} 
                />
              </div>
            </div>
            <button 
              onClick={handleAddCustomOrder} 
              disabled={isAddingCustom} 
              className="w-full bg-indigo-600 text-white font-black py-2.5 rounded-lg shadow-sm active:scale-95 transition-all text-xs"
            >
              {isAddingCustom ? '追加中...' : 'この人の会計に追加する'}
            </button>
          </div>
        </div>

      </div>

      {/* 送信待ちの注文リスト */}
      <div className="bg-white border rounded-xl p-4 shadow-sm">
        <h2 className="text-lg font-black text-gray-800 mb-2 flex items-center">
          <span className="text-xl mr-2">📋</span> 送信待ちの注文リスト
        </h2>
        <p className="text-xs text-gray-500 mb-4 font-bold border-b pb-3">
          店員さんに伝える前に、個数の変更や間違った注文の取消ができます。
        </p>

        {isLoading && orders.length === 0 ? (
          <p className="text-center text-gray-400 py-8 font-bold">読み込み中...</p>
        ) : orders.length === 0 ? (
          <div className="text-center py-10 bg-gray-50 rounded-lg border border-dashed border-gray-300">
            <span className="text-3xl opacity-30 block mb-2">🍻</span>
            <p className="text-gray-400 font-bold">現在、新しい注文はありません</p>
          </div>
        ) : (
          <div className="space-y-4">
            {Object.values(groupedOrders).map(group => (
              <div key={`${group.menu_name}_${group.size}`} className="border-2 border-gray-200 rounded-xl overflow-hidden shadow-sm">
                
                <div className="bg-gray-100 p-3 flex justify-between items-center border-b-2 border-gray-200">
                  <div className="font-bold text-gray-800 text-sm">
                    {group.menu_name} <span className="text-xs text-gray-500 font-normal">({group.size})</span>
                  </div>
                  <div className="text-sm font-black text-blue-700 bg-blue-100 px-3 py-1 rounded-full border border-blue-200">
                    計 {group.total}
                  </div>
                </div>

                <div className="bg-white divide-y divide-gray-100">
                  {group.items.map(item => (
                    <div key={item.id} className="p-3 flex justify-between items-center text-sm">
                      <span className="font-bold text-gray-600 truncate w-24">{item.user_name}</span>
                      
                      <div className="flex items-center space-x-1">
                        <button onClick={() => handleUpdateQuantity(item.id, item.quantity, -1)} className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 font-bold hover:bg-gray-200 active:scale-90">－</button>
                        <span className="w-6 text-center font-black text-gray-800">{item.quantity}</span>
                        <button onClick={() => handleUpdateQuantity(item.id, item.quantity, 1)} className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 font-bold hover:bg-gray-200 active:scale-90">＋</button>
                        <button onClick={() => handleDeleteOrder(item.id, item.user_name, item.menu_name)} className="ml-3 px-3 py-1.5 bg-red-50 text-red-600 text-xs font-bold rounded-lg border border-red-100 hover:bg-red-100 active:scale-95">取消</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            
            <div className="pt-6">
              <button onClick={handleMarkAsOrdered} className="w-full bg-red-600 text-white font-black py-4 rounded-xl shadow-md active:scale-95 transition-transform text-lg">
                店員さんに伝えたら押す
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}