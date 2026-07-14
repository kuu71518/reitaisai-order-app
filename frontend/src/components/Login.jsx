import { useEffect, useState } from 'react';
import { getDiscordLoginUrl } from '../lib/api';
import { StatusNotice } from './States';

const AUTH_MESSAGES = {
  pending: {
    tone: 'info',
    title: '管理者の連携待ちです',
    message: '本人確認は完了しました。下の確認コードをスタッフへ直接見せてください。',
  },
  cancelled: {
    tone: 'warning',
    title: 'Discordでの確認を中止しました',
    message: '注文するときは、下のボタンからもう一度進めてください。',
  },
  state_error: {
    tone: 'danger',
    title: '安全確認の期限が切れました',
    message: 'この画面から、もう一度Discordでログインしてください。',
  },
  failed: {
    tone: 'danger',
    title: 'Discordで確認できませんでした',
    message: '通信状態を確認して、もう一度お試しください。続く場合はグループ担当者へ画面を見せてください。',
  },
};

function readAuthResult() {
  try {
    return new URLSearchParams(window.location.search).get('auth') || '';
  } catch {
    return '';
  }
}

function readVerificationCode() {
  try {
    const code = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('code') || '';
    return /^[A-HJ-NP-Z2-9]{8}$/.test(code) ? code : '';
  } catch {
    return '';
  }
}

function formatVerificationCode(code) {
  return code ? `${code.slice(0, 4)}-${code.slice(4)}` : '';
}

export default function Login({ notice = '', sessionError = '' }) {
  const [authResult] = useState(readAuthResult);
  const [verificationCode] = useState(readVerificationCode);
  const [isLeaving, setIsLeaving] = useState(false);
  const authMessage = AUTH_MESSAGES[authResult];

  useEffect(() => {
    if (!authResult) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('auth');
    url.hash = '';
    window.history.replaceState({}, '', `${url.pathname}${url.search}`);
  }, [authResult]);

  return (
    <div className="login-shell">
      <div className="festival-ribbon ribbon-one" aria-hidden="true" />
      <div className="festival-ribbon ribbon-two" aria-hidden="true" />
      <main className="login-card">
        <header className="login-heading">
          <img src="/icon-192.png" alt="" className="login-stamp" />
          <div>
            <p className="eyebrow">例大祭 打ち上げ</p>
            <h1>かんたん注文</h1>
          </div>
        </header>

        <div className="login-message">
          <strong>Discordで本人確認して始めます</strong>
          <span>文字入力はありません。確認後、この注文画面へ自動で戻ります。</span>
        </div>

        {notice && <StatusNotice tone="success" title={notice} />}
        {sessionError && <StatusNotice tone="danger" title="ログイン状態を確認できませんでした" live>{sessionError}</StatusNotice>}
        {authMessage && (
          <StatusNotice tone={authMessage.tone} title={authMessage.title} live>
            {authMessage.message}
          </StatusNotice>
        )}
        {authResult === 'pending' && verificationCode && (
          <div className="discord-verification-code" role="status" aria-label="スタッフへ見せる確認コード">
            <span>スタッフへ見せる番号</span>
            <strong>{formatVerificationCode(verificationCode)}</strong>
            <small>スタッフが連携を終えたら、下のボタンをもう一度押します。</small>
          </div>
        )}

        <ol className="discord-login-steps" aria-label="ログインの流れ">
          <li>
            <span aria-hidden="true">1</span>
            <div>
              <strong>Discordを開く</strong>
              <small>下のボタンを押します。</small>
            </div>
          </li>
          <li>
            <span aria-hidden="true">2</span>
            <div>
              <strong>確認して戻る</strong>
              <small>Discordの画面で「認証」を押します。</small>
            </div>
          </li>
        </ol>

        <a
          className={isLeaving ? 'discord-login-button is-loading' : 'discord-login-button'}
          href={getDiscordLoginUrl()}
          onClick={() => setIsLeaving(true)}
          aria-busy={isLeaving}
        >
          <span className="discord-button-mark" aria-hidden="true">●●</span>
          <span>{isLeaving ? 'Discordを開いています…' : authResult === 'pending' ? '連携後にもう一度ログイン' : 'Discordでログイン'}</span>
        </a>

        <div className="discord-privacy-note">
          <strong>確認する情報</strong>
          <span>DiscordのアカウントIDと表示名だけを確認します。メッセージは取得しません。</span>
        </div>

        <p className="login-help">初回だけ管理者の連携が必要です。うまく入れないときは、この画面をグループ担当者へ見せてください。</p>
      </main>
    </div>
  );
}
