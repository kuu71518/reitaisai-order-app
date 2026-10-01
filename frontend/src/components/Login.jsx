import { useEffect, useState } from 'react';
import { getDiscordLoginUrl } from '../lib/api';
import { StatusNotice } from './States';
import VenueGuide from './VenueGuide';

const AUTH_MESSAGES = {
  not_registered: {
    tone: 'warning',
    title: 'このアカウントは利用登録されていません',
    message: '管理者へDiscordのユーザーIDを登録してもらってから、もう一度ログインしてください。',
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

export default function Login({ notice = '', sessionError = '', onRetrySession }) {
  const [authResult] = useState(readAuthResult);
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

        <VenueGuide compact />

        <div className="login-message">
          <strong>初回はDiscordで本人確認</strong>
          <span>同じブラウザでは、初回認証から最長30日間、自動でログインします。</span>
        </div>

        {notice && <StatusNotice tone="success" title={notice} />}
        {sessionError && <StatusNotice tone="danger" title="ログイン状態を確認できませんでした" live action={(
          <button type="button" className="small-button" onClick={onRetrySession}>もう一度確認する</button>
        )}>{sessionError}</StatusNotice>}
        {authMessage && (
          <StatusNotice tone={authMessage.tone} title={authMessage.title} live>
            {authMessage.message}
          </StatusNotice>
        )}
        <a
          className={isLeaving ? 'discord-login-button is-loading' : 'discord-login-button'}
          href={getDiscordLoginUrl()}
          onClick={() => setIsLeaving(true)}
          aria-busy={isLeaving}
        >
          <span className="discord-button-mark" aria-hidden="true">●●</span>
          <span>{isLeaving ? 'Discordを開いています…' : 'Discordでログイン'}</span>
        </a>

        <ol className="discord-login-steps" aria-label="ログインの流れ">
          <li>
            <span aria-hidden="true">1</span>
            <div>
              <strong>Discordを開く</strong>
              <small>ログインボタンを押します。</small>
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

        <details className="login-details">
          <summary>ログインについて・困ったとき</summary>
          <p>アカウントIDを一時的に照合します。IDそのもの・表示名・メッセージは保存しません。</p>
          <p>共用端末では、利用後にログアウトしてください。期限切れ・別のブラウザ・Cookie削除後は再度ログインが必要です。</p>
          <p>ログインできないときは、管理者に利用登録済みか確認してください。</p>
        </details>
      </main>
    </div>
  );
}
