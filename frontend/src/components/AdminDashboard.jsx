import React, { useState, useEffect } from 'react';

const API_URL = import.meta.env.VITE_API_URL;

export default function AdminDashboard() {
  const [confirmText, setConfirmText] = useState('');
  const [isResetting, setIsResetting] = useState(false);
  const [orders, setOrders] = useState([]);
  const [users, setUsers] = useState([]); 
  const [adminMenu, setAdminMenu] = useState([]);
  const [logs, setLogs] = useState([]);
  const [stats, setStats] = useState({ total_users: 0, total_orders: 0, total_cancels: 0, total_sales: 0 });

  const [selectedCategory, setSelectedCategory] = useState('すべて');
  const [sortConfig, setSortConfig] = useState({ key: 'name', direction: 'asc' });
  const [isAdding, setIsAdding] = useState(false);

  // メンバー追加用
  const [newName, setNewName] = useState('');
  const [newGroup, setNewGroup] = useState('Aグループ');
  const [newRole, setNewRole] = useState('member');
  const [newDiscordId, setNewDiscordId] = useState('');

  // 🌟 リデザイン用に追加した状態（State）
  const [showAddForm, setShowAddForm] = useState(false); // 新規追加エリアの開閉スイッチ
  const [editingId, setEditingId] = useState(null);       // 現在どのメニューを編集しているか(ID)
  const [editForm, setEditForm] = useState({ name: '', category: '', price: 0, size: '' }); // 編集中の仮入力内容

  // 新規メニュー追加用
  const [newItemName, setNewItemName] = useState('');
  const [newItemCategory, setNewItemCategory] = useState('揚物');
  const [newItemPrice, setNewItemPrice] = useState('');
  const [newItemSize, setNewItemSize] = useState('普通');

  // 存在するグループのリストを自動抽出
  const existingGroups = users.length > 0 
    ? [...new Set(users.map(u => u.group_id))] 
    : ['Aグループ', 'あグループ'];

  const fetchData = async () => {
    const nocache = `?_t=${Date.now()}`;
    const fetchOptions = { cache: 'no-store' };

    try {
      const [ordersRes, statsRes, usersRes, logsRes, menuRes] = await Promise.all([
        fetch(`${API_URL}/api/admin/orders${nocache}`, fetchOptions),
        fetch(`${API_URL}/api/admin/stats${nocache}`, fetchOptions),
        fetch(`${API_URL}/api/admin/users${nocache}`, fetchOptions),
        fetch(`${API_URL}/api/admin/logs${nocache}`, fetchOptions),
        fetch(`${API_URL}/api/admin/menu${nocache}`, fetchOptions)
      ]);

      if (ordersRes.ok) setOrders((await ordersRes.json()).data || []);
      if (statsRes.ok) setStats((await statsRes.json()).data || {});
      
      if (usersRes.ok) {
        const userData = (await usersRes.json()).data || [];
        setUsers(userData);
        if (userData.length > 0) {
          const groups = [...new Set(userData.map(u => u.group_id))];
          setNewGroup(groups[0]);
        }
      }
      
      if (logsRes.ok) setLogs((await logsRes.json()).data || []);
      if (menuRes.ok) setAdminMenu((await menuRes.json()).data || []);
    } catch (e) { console.error(e); }
  };

  useEffect(() => { fetchData(); }, []);

  const handleUpdateUser = async (id, groupId, role) => {
    try {
      await fetch(`${API_URL}/api/admin/users/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_id: groupId, role: role })
      });
      fetchData();
    } catch (e) { alert('❌ ユーザー情報の更新に失敗しました'); }
  };

  const handleSort = (key) => {
    setSortConfig({ key, direction: sortConfig.key === key && sortConfig.direction === 'asc' ? 'desc' : 'asc' });
  };

  const sortedMenu = [...adminMenu].sort((a, b) => {
    if (a[sortConfig.key] < b[sortConfig.key]) return sortConfig.direction === 'asc' ? -1 : 1;
    if (a[sortConfig.key] > b[sortConfig.key]) return sortConfig.direction === 'asc' ? 1 : -1;
    return 0;
  });

  const filteredMenu = sortedMenu.filter(item => selectedCategory === 'すべて' || item.category === selectedCategory);

  const handleDeleteMember = async (id, name) => {
    if (!window.confirm(`${name}を削除しますか？`)) return;
    await fetch(`${API_URL}/api/admin/users/${id}`, { method: 'DELETE' });
    fetchData();
  };

  // 🌟 編集モード開始時の処理
  const startEdit = (item) => {
    setEditingId(item.id);
    setEditForm({ name: item.name, category: item.category, price: item.price, size: item.size });
  };

  // 🌟 編集内容の保存処理
  const saveEdit = async (id) => {
    if (!editForm.name || !editForm.price) return alert('名前と価格を入力してください');
    try {
      const res = await fetch(`${API_URL}/api/admin/menu/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editForm)
      });
      if (res.ok) {
        setEditingId(null);
        fetchData();
      }
    } catch (e) { alert('更新に失敗しました'); }
  };

  const handleDeleteMenu = async (id, name) => {
    if (!window.confirm(`「${name}」を完全に削除しますか？`)) return;
    try {
      const res = await fetch(`${API_URL}/api/admin/menu/${id}`, { method: "DELETE" });
      const result = await res.json();
      if (res.ok && result.success) {
        alert('削除しました');
        fetchData();
      } else { alert(`❌ 削除できませんでした: ${result.message || 'エラー'}`); }
    } catch (e) { alert('❌ 通信エラーが発生しました'); }
  };

  const handleAddMenu = async () => {
    if (!newItemName || !newItemPrice) return alert('入力してください');
    await fetch(`${API_URL}/api/admin/menu`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newItemName, category: newItemCategory, price: parseInt(newItemPrice), size: newItemSize })
    });
    setNewItemName(''); setNewItemPrice('');
    setShowAddForm(false); // 追加したら閉じる
    fetchData();
  };

  const handleAddUser = async () => {
    if (!newName || !newDiscordId || !newGroup) return alert('入力してください');
    setIsAdding(true);
    await fetch(`${API_URL}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName, group_id: newGroup, role: newRole, discord_id: newDiscordId })
    });
    setNewName(''); setNewDiscordId('');
    setIsAdding(false);
    fetchData();
  };

  const handleReset = async () => {
    if (confirmText !== 'リセット') return;
    setIsResetting(true);
    await fetch(`${API_URL}/api/orders/reset`, { method: 'POST' });
    window.location.reload();
  };

  return (
    <div className="pb-24 md:pb-8 p-2 space-y-8 max-w-5xl mx-auto">
      
      {/* 売上スタッツ */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white p-4 rounded-xl shadow-sm border-l-4 border-blue-500">
          <p className="text-xs text-gray-500 font-bold">登録ユーザー</p>
          <p className="text-2xl font-black">{stats.total_users || 0}人</p>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border-l-4 border-yellow-500">
          <p className="text-xs text-gray-500 font-bold">総売上合計</p>
          <p className="text-xl font-black text-red-600">¥{(stats.total_sales || 0).toLocaleString()}</p>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-8">
        {/* 👤 メンバー管理 */}
        <div className="bg-white border rounded-2xl p-6 shadow-sm">
          <h2 className="font-black text-lg mb-4 flex justify-between items-center">👤 メンバー管理・個別会計</h2>
          <div className="space-y-3 max-h-[350px] overflow-y-auto pr-2 custom-scrollbar">
            {users.map(u => (
              <div key={u.id} className="flex justify-between items-center p-3 bg-gray-50 rounded-xl border text-sm">
                <div className="flex-1 pr-2">
                  <p className="font-bold flex items-center gap-2">
                    {u.name} 
                    <span className="text-[10px] text-gray-400 font-normal">({u.discord_id})</span>
                  </p>
                  <div className="flex gap-2 mt-2">
                    <select className="border p-1 rounded text-xs bg-white text-gray-700" value={u.group_id} onChange={(e) => handleUpdateUser(u.id, e.target.value, u.role)}>
                      {existingGroups.map(g => <option key={g} value={g}>{g}</option>)}
                    </select>
                    <select className="border p-1 rounded text-xs bg-white text-gray-700" value={u.role} onChange={(e) => handleUpdateUser(u.id, u.group_id, e.target.value)}>
                      <option value="member">一般</option>
                      <option value="manager">担当者</option>
                      <option value="admin">管理者</option>
                    </select>
                  </div>
                  <p className="text-blue-600 font-black text-xs mt-2">累計: ¥{(u.total_spent || 0).toLocaleString()}</p>
                </div>
                <button onClick={() => handleDeleteMember(u.id, u.name)} className="text-gray-300 hover:text-red-500 font-bold p-3 text-lg transition-transform active:scale-90">✕</button>
              </div>
            ))}
          </div>

          <div className="mt-6 pt-6 border-t space-y-3">
            <h3 className="font-bold text-xs text-gray-400 uppercase tracking-widest mb-2">新規メンバー追加</h3>
            <div className="grid grid-cols-2 gap-2">
              <input type="text" placeholder="名前" className="border p-2 rounded-lg text-xs" value={newName} onChange={e => setNewName(e.target.value)} />
              <input type="text" placeholder="Discord ID" className="border p-2 rounded-lg text-xs" value={newDiscordId} onChange={e => setNewDiscordId(e.target.value)} />
              <select className="border p-2 rounded-lg text-xs bg-white text-gray-700" value={newGroup} onChange={e => setNewGroup(e.target.value)}>
                {existingGroups.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
              <select className="border p-2 rounded-lg text-xs bg-white" value={newRole} onChange={e => setNewRole(e.target.value)}>
                <option value="member">一般 (Member)</option>
                <option value="manager">担当者 (Manager)</option>
                <option value="admin">管理者 (Admin)</option>
              </select>
            </div>
            <button onClick={handleAddUser} disabled={isAdding} className="w-full bg-blue-600 text-white font-black py-3 rounded-lg text-xs mt-2 active:scale-95 transition-transform">{isAdding ? '追加中...' : '＋ メンバー追加'}</button>
          </div>
        </div>

        {/* 📦 注文の個別管理 */}
        <div className="bg-white border rounded-2xl p-6 shadow-sm">
          <h2 className="font-black text-lg mb-4">📦 注文の個別管理</h2>
          <div className="space-y-2 max-h-[450px] overflow-y-auto pr-2 custom-scrollbar">
            {orders.map(order => (
              <div key={order.id} className="p-3 bg-gray-50 rounded-xl border text-xs flex justify-between items-center">
                <div>
                  <p className="font-bold">{order.user_name} <span className="text-gray-400 font-normal">({order.group_id})</span></p>
                  <p className="text-gray-600">{order.item_name} ({order.size}) × {order.quantity}</p>
                  <p className="text-red-500 font-bold">¥{(order.price * order.quantity).toLocaleString()}</p>
                </div>
                <button className="text-red-500 font-bold px-3 py-1 bg-red-50 rounded border border-red-100">取消</button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 🌟 🍽️ メニュー一覧・編集（カード型大改造リデザイン） */}
      <div className="bg-white border rounded-2xl shadow-sm overflow-hidden">
        <div className="p-6 border-b bg-gray-50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="font-black text-lg flex items-center gap-2">🍽️ メニューマスタ管理</h2>
            <p className="text-xs text-gray-400 font-bold mt-0.5">登録数: {filteredMenu.length}件</p>
          </div>
          
          <div className="flex items-center gap-2 self-end sm:self-auto">
            <select className="border rounded-xl px-3 py-2 text-xs font-black bg-white shadow-sm" value={selectedCategory} onChange={e => setSelectedCategory(e.target.value)}>
              {['すべて', ...new Set(adminMenu.map(i => i.category))].map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            
            <button 
              onClick={() => setShowAddForm(!showAddForm)} 
              className={`px-4 py-2 rounded-xl text-xs font-black shadow-sm transition-all ${showAddForm ? 'bg-gray-500 text-white' : 'bg-blue-600 text-white active:scale-95'}`}
            >
              {showAddForm ? '✕ 閉じる' : '＋ 新規メニュー'}
            </button>
          </div>
        </div>

        {/* ➕ 新規メニュー追加エリア（アコーディオン式にシュッと開閉） */}
        {showAddForm && (
          <div className="p-6 bg-blue-50/50 border-b space-y-3 animate-fadeIn">
            <h3 className="font-black text-xs text-blue-800 uppercase tracking-widest">新しいメニューの追加</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <input placeholder="カテゴリ (例: 揚物)" className="border p-2 rounded-lg text-sm bg-white" value={newItemCategory} onChange={e => setNewItemCategory(e.target.value)} />
              <input placeholder="メニュー名" className="border p-2 rounded-lg text-sm bg-white" value={newItemName} onChange={e => setNewItemName(e.target.value)} />
              <input placeholder="サイズ (例: バカ)" className="border p-2 rounded-lg text-sm bg-white" value={newItemSize} onChange={e => setNewItemSize(e.target.value)} />
              <input type="number" placeholder="価格 (円)" className="border p-2 rounded-lg text-sm bg-white font-bold" value={newItemPrice} onChange={e => setNewItemPrice(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setShowAddForm(false)} className="px-4 py-2 bg-gray-200 text-gray-700 font-bold text-xs rounded-lg">キャンセル</button>
              <button onClick={handleAddMenu} className="px-5 py-2 bg-blue-600 text-white font-black text-xs rounded-lg shadow-md">この内容で追加する</button>
            </div>
          </div>
        )}

        {/* 📋 メニューのカード型リスト（スマホでも超見やすい！） */}
        <div className="divide-y max-h-[550px] overflow-y-auto pr-1 custom-scrollbar">
          {filteredMenu.map(item => (
            <div key={item.id} className="p-4 flex items-center justify-between hover:bg-gray-50/80 transition-colors">
              
              {/* 🔄 通常時と編集時で表示を切り替えるスイッチ構造 */}
              {editingId === item.id ? (
                /* ✏️ 編集フォームモード */
                <div className="flex-1 grid grid-cols-2 sm:grid-cols-4 gap-2 pr-4">
                  <input className="border p-1.5 rounded text-xs bg-white font-bold" value={editForm.category} onChange={e => setEditForm({...editForm, category: e.target.value})} />
                  <input className="border p-1.5 rounded text-xs bg-white font-bold" value={editForm.name} onChange={e => setEditForm({...editForm, name: e.target.value})} />
                  <input className="border p-1.5 rounded text-xs bg-white font-bold text-gray-500" value={editForm.size} onChange={e => setEditForm({...editForm, size: e.target.value})} />
                  <div className="relative flex items-center">
                    <span className="absolute left-2 text-xs text-gray-400">¥</span>
                    <input type="number" className="w-full border py-1.5 pl-5 pr-1 rounded text-xs bg-white font-black text-blue-600" value={editForm.price} onChange={e => setEditForm({...editForm, price: parseInt(e.target.value, 10) || 0})} />
                  </div>
                </div>
              ) : (
                /* 📄 通常テキストモード（スッキリ！） */
                <div className="flex-1 pr-4 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[9px] font-black px-1.5 py-0.5 bg-gray-200 text-gray-600 rounded-md uppercase tracking-wider">{item.category}</span>
                    <span className="text-xs text-gray-400 font-mono">ID: {item.id}</span>
                  </div>
                  <p className="font-bold text-gray-800 text-sm truncate">{item.name}</p>
                  <p className="text-xs text-gray-500 font-medium">サイズ: <span className="font-bold text-gray-700">{item.size}</span></p>
                </div>
              )}

              {/* 🛠️ 操作ボタンエリア */}
              <div className="flex items-center gap-1.5 shrink-0 border-l pl-4 border-gray-100">
                {editingId === item.id ? (
                  <>
                    <button onClick={() => setEditingId(null)} className="px-2.5 py-1.5 bg-gray-100 text-gray-600 text-xs font-bold rounded-lg border">取消</button>
                    <button onClick={() => saveEdit(item.id)} className="px-3 py-1.5 bg-green-600 text-white text-xs font-black rounded-lg shadow-sm">保存</button>
                  </>
                ) : (
                  <>
                    <button onClick={() => startEdit(item)} className="px-2.5 py-1.5 bg-gray-50 text-gray-600 hover:bg-blue-50 hover:text-blue-600 text-xs font-bold rounded-lg border border-gray-200 transition-colors">✏️ 編集</button>
                    <button onClick={() => handleDeleteMenu(item.id, item.name)} className="p-1.5 text-gray-300 hover:text-red-500 transition-colors text-lg font-bold">✕</button>
                  </>
                )}
              </div>

            </div>
          ))}
          {filteredMenu.length === 0 && (
            <p className="text-center text-gray-400 py-12 font-bold text-sm">該当するメニューはありません。</p>
          )}
        </div>
      </div>

      {/* 監査ログ */}
      <div className="bg-gray-900 rounded-2xl p-6 shadow-xl text-white">
        <h2 className="font-black text-lg mb-4 flex items-center gap-2"><span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>監査ログ</h2>
        <div className="space-y-2 max-h-40 overflow-y-auto pr-2 custom-scrollbar text-[10px]">
          {logs.map(log => (
            <div key={log.id} className="p-2 bg-white/5 rounded border border-white/10 flex justify-between">
              <span><span className="text-blue-400 font-black">[{log.action_type}]</span> {log.details}</span>
              <span className="text-gray-500">{new Date(log.created_at + "Z").toLocaleString("ja-JP")}</span>
            </div>
          ))}
        </div>
      </div>

      {/* データリセット */}
      <div className="bg-red-50 border-2 border-red-500 p-6 rounded-2xl text-center">
        <h2 className="text-red-700 font-black text-lg mb-2">⚠ 全データリセット</h2>
        <input type="text" placeholder="「リセット」と入力" className="border p-2 rounded-xl mb-3 text-center w-full max-w-xs font-bold" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
        <button onClick={handleReset} disabled={isResetting || confirmText !== "リセット"} className="w-full max-w-xs bg-red-600 text-white py-3 rounded-xl font-black shadow-md">実行</button>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar { width: 4px; } 
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.08); border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.15); }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } }
        .animate-fadeIn { animation: fadeIn 0.2s ease-out forwards; }
      `}} />
    </div>
  );
}