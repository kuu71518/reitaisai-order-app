import React, { useState, useMemo, useEffect } from "react";
import useSWR from "swr";

const API_URL = import.meta.env.VITE_API_URL;
const fetcher = (url) => fetch(url).then((res) => res.json());

export default function Menu({ currentUser }) {
  const { data, error, isLoading } = useSWR(`${API_URL}/api/menu`, fetcher);

  const [cart, setCart] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("すべて");
  const [selectedSizes, setSelectedSizes] = useState({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [activeTab, setActiveTab] = useState('menu');
  const [history, setHistory] = useState([]);

  const menuItems = data?.data || [];

  const categories = useMemo(() => {
    if (!menuItems.length) return ["すべて"];
    const rawCats = [...new Set(menuItems.map((item) => item.category))];
    const priority = ["ビール", "サワー", "ハイボール", "名物", "串焼", "おやじ応援団", "揚物", "一品", "食事"];
    return [
      "すべて",
      ...priority.filter((p) => rawCats.includes(p)),
      ...rawCats.filter((c) => !priority.includes(c)),
    ];
  }, [menuItems]);

  const groupedItems = useMemo(() => {
    const groups = {};
    menuItems.forEach((item) => {
      if (!groups[item.name]) {
        groups[item.name] = { name: item.name, category: item.category, variations: [] };
      }
      groups[item.name].variations.push(item);
    });

    let result = Object.values(groups);
    if (selectedCategory !== "すべて") result = result.filter((g) => g.category === selectedCategory);
    if (searchQuery) result = result.filter((g) => g.name.includes(searchQuery));

    result.sort((a, b) => {
      if (a.name === "キリン一番搾り（生）") return -1;
      if (b.name === "キリン一番搾り（生）") return 1;
      return 0;
    });

    return result;
  }, [menuItems, searchQuery, selectedCategory]);

  useMemo(() => {
    const initialSizes = {};
    groupedItems.forEach((group) => {
      if (!selectedSizes[group.name]) {
        initialSizes[group.name] = group.variations[0].id;
      }
    });
    if (Object.keys(initialSizes).length > 0) {
      setSelectedSizes((prev) => ({ ...prev, ...initialSizes }));
    }
  }, [groupedItems]);

  useEffect(() => {
    if (activeTab === 'history') fetchHistory();
  }, [activeTab]);

  const fetchHistory = async () => {
    try {
      const res = await fetch(`${API_URL}/api/users/${currentUser.id}/orders`);
      const json = await res.json();
      if (json.success) setHistory(json.data);
    } catch (e) {
      console.error("履歴取得エラー:", e);
    }
  };

  const formatTime = (dateString) => {
    if (!dateString) return '';
    const d = new Date(dateString + 'Z');
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // 🌟 追加：履歴から「合計金額」を計算する処理
  const totalSpent = useMemo(() => {
    return history.reduce((sum, order) => sum + (order.price * order.quantity), 0);
  }, [history]);

  const handleSizeChange = (groupName, sizeId) => {
    setSelectedSizes((prev) => ({ ...prev, [groupName]: sizeId }));
  };

  const addToCart = (group) => {
    const selectedId = selectedSizes[group.name];
    const selectedItem = group.variations.find((v) => v.id === parseInt(selectedId));

    setCart((prev) => {
      const existing = prev.find((item) => item.menu_item_id === selectedItem.id);
      if (existing) {
        return prev.map((item) => item.menu_item_id === selectedItem.id ? { ...item, quantity: item.quantity + 1 } : item);
      }
      return [...prev, { ...selectedItem, menu_item_id: selectedItem.id, quantity: 1 }];
    });
  };

  const updateQuantity = (id, delta) => {
    setCart((prev) =>
      prev.map((item) => {
        if (item.menu_item_id === id) {
          const newQ = item.quantity + delta;
          return newQ > 0 ? { ...item, quantity: newQ } : item;
        }
        return item;
      })
    );
  };

  const removeFromCart = (id) => setCart((prev) => prev.filter((item) => item.menu_item_id !== id));

  const submitOrder = async () => {
    if (!cart.length) return;
    setIsSubmitting(true);
    try {
      await Promise.all(
        cart.map((item) =>
          fetch(`${API_URL}/api/orders`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              user_id: currentUser.id,
              menu_item_id: item.menu_item_id,
              quantity: item.quantity,
            }),
          })
        )
      );
      alert("注文を送信しました！");
      setCart([]);
      setActiveTab('history'); 
    } catch (err) {
      alert("送信に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (error) return <div className="p-4 text-center text-red-600 font-bold">エラーが発生しました。</div>;
  if (isLoading) return <div className="p-4 text-center text-gray-500 font-bold">読み込み中...</div>;

  return (
    <div className="space-y-4 pb-24 md:pb-8">
      
      <div className="flex bg-gray-200 p-1 rounded-xl shadow-inner mb-4">
        <button 
          onClick={() => setActiveTab('menu')} 
          className={`flex-1 py-3 font-black text-sm rounded-lg transition-all ${activeTab === 'menu' ? 'bg-white text-red-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
        >
          🍽️ 注文する
        </button>
        <button 
          onClick={() => setActiveTab('history')} 
          className={`flex-1 py-3 font-black text-sm rounded-lg transition-all ${activeTab === 'history' ? 'bg-white text-red-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
        >
          📜 自分の履歴
        </button>
      </div>

      {activeTab === 'menu' && (
        <>
          {cart.length > 0 && (
            <div className="bg-white border-2 border-red-500 rounded-xl p-4 shadow-sm">
              <div className="flex justify-between items-center mb-2 border-b pb-2">
                <span className="font-bold text-red-600">カート ({cart.length})</span>
                <span className="font-black text-lg">
                  ¥{cart.reduce((s, i) => s + i.price * i.quantity, 0).toLocaleString()}
                </span>
              </div>
              <ul className="space-y-3 max-h-48 overflow-y-auto mb-4">
                {cart.map((item) => (
                  <li key={item.menu_item_id} className="flex justify-between items-center text-sm border-b border-dashed border-gray-200 pb-2">
                    <div className="flex-1 truncate pr-2">
                      <div className="font-bold text-gray-800">{item.name}</div>
                      <div className="text-gray-500 text-xs">({item.size}) ¥{item.price}</div>
                    </div>
                    <div className="flex items-center space-x-1">
                      <button onClick={() => updateQuantity(item.menu_item_id, -1)} className="bg-gray-200 hover:bg-gray-300 w-8 h-8 rounded-full font-bold text-lg flex items-center justify-center">-</button>
                      <span className="w-6 text-center font-bold">{item.quantity}</span>
                      <button onClick={() => updateQuantity(item.menu_item_id, 1)} className="bg-gray-200 hover:bg-gray-300 w-8 h-8 rounded-full font-bold text-lg flex items-center justify-center">+</button>
                      <button onClick={() => removeFromCart(item.menu_item_id)} className="text-red-400 hover:text-red-600 px-2 py-1 rounded ml-2 text-xl font-bold">✕</button>
                    </div>
                  </li>
                ))}
              </ul>
              <button onClick={submitOrder} disabled={isSubmitting} className="w-full bg-red-600 hover:bg-red-700 text-white font-black py-4 rounded-xl shadow-md active:scale-95 transition-transform flex items-center justify-center">
                {isSubmitting ? "送信中..." : "📱 担当者へ注文を送信する"}
              </button>
            </div>
          )}

          <div className="bg-white p-3 rounded-xl shadow-sm border border-gray-100 space-y-3">
            <input type="text" placeholder="🔍 メニュー名で検索..." className="w-full border border-gray-300 rounded-lg p-3 text-sm outline-none focus:ring-2 focus:ring-red-500" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
            <div className="text-[10px] font-bold text-gray-400 mb-2 px-1 mt-2">カテゴリーから選ぶ</div>
            <div className="flex flex-wrap gap-2">
              {categories.map((cat) => (
                <button key={cat} onClick={() => setSelectedCategory(cat)} className={`px-3 py-2 rounded-lg text-xs font-bold transition-all shadow-sm flex-1 min-w-[80px] text-center border ${selectedCategory === cat ? "bg-red-600 text-white border-red-600 ring-2 ring-red-100" : "bg-gray-50 text-gray-700 border-gray-100 hover:bg-gray-100"}`}>
                  {cat}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3">
            {groupedItems.map((group) => (
              <div key={group.name} className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
                <div className="flex items-center gap-2 mb-3">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${group.category === "お酒" ? "bg-orange-100 text-orange-700" : group.category === "ソフトドリンク" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600"}`}>
                    {group.category}
                  </span>
                  <h3 className="font-bold text-gray-800">{group.name}</h3>
                </div>
                <div className="flex items-center">
                  <select className="border border-gray-300 rounded-lg p-2 text-sm bg-gray-50 flex-1 mr-4 font-medium" value={selectedSizes[group.name] || ""} onChange={(e) => handleSizeChange(group.name, e.target.value)}>
                    {group.variations.map((v) => (
                      <option key={v.id} value={v.id}>{v.size} - ¥{v.price}</option>
                    ))}
                  </select>
                  <button onClick={() => addToCart(group)} className="bg-blue-600 hover:bg-blue-700 text-white font-black text-xl w-12 h-12 rounded-full shadow-md active:scale-90 transition-transform">
                    ＋
                  </button>
                </div>
              </div>
            ))}
            {groupedItems.length === 0 && <p className="text-center text-gray-500 py-8 font-bold">メニューが見つかりませんでした。</p>}
          </div>
        </>
      )}

      {/* --- 📜 自分の注文履歴タブ --- */}
      {activeTab === 'history' && (
        <div className="bg-white p-4 rounded-xl shadow-sm border">
          <div className="flex justify-between items-center mb-4">
            <h2 className="font-black text-lg text-gray-800">📜 自分の注文履歴</h2>
            <button onClick={fetchHistory} className="text-xs bg-gray-100 px-3 py-2 rounded font-bold hover:bg-gray-200">↻ 更新</button>
          </div>

          {/* 🌟 追加：ドドンと表示される合計金額エリア */}
          <div className="bg-red-50 border-2 border-red-200 rounded-xl p-4 mb-6 flex justify-between items-center shadow-sm">
            <div>
              <p className="text-xs font-bold text-red-800 mb-1">現在のあなたの合計利用額</p>
              <p className="text-[10px] text-red-500 font-bold">※取消された注文は含まれません</p>
            </div>
            <p className="text-2xl font-black text-red-600">¥{totalSpent.toLocaleString()}</p>
          </div>
          
          {history.length === 0 ? (
            <div className="text-center py-12 bg-gray-50 rounded-lg border border-dashed border-gray-300">
              <p className="text-4xl mb-2">🍽️</p>
              <p className="text-gray-500 font-bold text-sm">まだ注文はありません。</p>
              <button onClick={() => setActiveTab('menu')} className="mt-4 text-red-600 text-sm font-bold hover:underline">メニューを見る</button>
            </div>
          ) : (
            <div className="space-y-3">
              {history.map((order) => (
                <div key={order.id} className="flex justify-between items-center p-3 bg-gray-50 rounded-lg border shadow-sm">
                  <div className="flex-1 pr-2">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs text-gray-500 font-black">{formatTime(order.created_at)}</span>
                      {order.status === 'pending' ? (
                        <span className="text-[10px] px-2 py-0.5 rounded font-bold bg-yellow-100 text-yellow-800 border border-yellow-200">担当者確認中</span>
                      ) : (
                        <span className="text-[10px] px-2 py-0.5 rounded font-bold bg-green-100 text-green-800 border border-green-200">受付済み</span>
                      )}
                    </div>
                    <p className="font-bold text-gray-800 leading-tight mb-1">{order.item_name}</p>
                    {/* 🌟 追加：単価×個数の内訳 */}
                    <p className="text-[11px] font-bold text-gray-500">
                      {order.size} (¥{order.price} × {order.quantity})
                    </p>
                  </div>
                  <div className="text-right pl-2 border-l border-gray-200">
                    {/* 🌟 変更：大きく小計を表示 */}
                    <p className="text-[10px] text-gray-400 font-bold">小計</p>
                    <p className="font-black text-lg text-red-600">¥{(order.price * order.quantity).toLocaleString()}</p>
                  </div>
                </div>
              ))}
              <p className="text-[10px] text-center text-gray-400 mt-6 font-bold">※間違えて注文した場合は、担当者に直接お伝えください。</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}