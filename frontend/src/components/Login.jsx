import React, { useState } from 'react';

const API_URL = import.meta.env.VITE_API_URL;

export default function Login({ onLogin }) {
  // 初期値を「Aグループ」に設定
  const [groupId, setGroupId] = useState('Aグループ');
  const [discordId, setDiscordId] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const response = await fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          group_id: groupId, 
          discord_id: discordId.trim() // 空白が混じっても大丈夫なように除去
        })
      });

      const data = await response.json();

      if (data.success) {
        localStorage.setItem('reitaisai_app_user', JSON.stringify(data.user));
        onLogin(data.user);
      } else {
        setError(data.message || 'ログインに失敗しました');
      }
    } catch (err) {
      setError('サーバーとの通信に失敗しました。');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100 p-6">
      
      {/* 🌟 追加：丸いアイコン（白い枠の上に配置） */}
      {/* サイズを変更したい場合は、以下の「w-24 h-24」の数字を同じ値で変更してください */}
      {/* 例: 少し小さくするなら「w-20 h-20」、大きくするなら「w-32 h-32」 */}
      <img 
        src="/icon.png" 
        alt="例大祭オーダー アイコン" 
        className="w-24 h-24 rounded-full object-cover mb-6 shadow-md border-4 border-white"
      />

      {/* 👇 既存のログイン枠 */}
      <div className="w-full max-w-sm bg-white rounded-xl shadow-lg p-6">
        <h1 className="text-2xl font-black text-center text-red-600 mb-6">
          打ち上げオーダー
        </h1>
        
        {error && (
          <div className="bg-red-100 border-l-4 border-red-500 text-red-700 p-3 mb-4 text-sm font-bold">
            {error}
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-5">
          <div>
            <label className="block text-gray-700 font-bold mb-2 text-sm">自分のグループ</label>
            <select 
              className="w-full border border-gray-300 rounded-lg p-3 text-lg focus:ring-2 focus:ring-red-500 outline-none bg-gray-50 font-bold"
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
            >
              <option value="Aグループ">Aグループ</option>
              <option value="あグループ">あグループ</option>
              <option value="管理">管理</option>
            </select>
          </div>

          <div>
            <label className="block text-gray-700 font-bold mb-2 text-sm">Discord ID</label>
            <input 
              type="text" 
              className="w-full border border-gray-300 rounded-lg p-3 text-lg focus:ring-2 focus:ring-red-500 outline-none"
              placeholder="例: discord_ID"
              value={discordId}
              onChange={(e) => setDiscordId(e.target.value)}
              required
            />
            <p className="text-xs text-gray-500 mt-2">
              ※事前に申請したDiscordのアカウント名（ID）を入力してください。
            </p>
          </div>

          <button 
            type="submit" 
            disabled={isLoading}
            className={`w-full text-white font-bold py-4 rounded-lg shadow-md mt-2 transition-transform ${
              isLoading ? 'bg-gray-400' : 'bg-red-600 hover:bg-red-700 active:scale-95'
            }`}
          >
            {isLoading ? '通信中...' : 'ログインする'}
          </button>
        </form>
      </div>
    </div>
  );
}