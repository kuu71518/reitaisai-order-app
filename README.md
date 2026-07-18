# 例大祭打ち上げ かんたん注文

スマートフォンから料理・飲み物を注文し、グループ担当者が取りまとめるWebアプリです。20〜30歳を主対象に、スマートフォン操作に慣れていない人でも「選ぶ → 確認 → 送る」の順で使えるUIにしています。

## 現在の構成

| 項目 | 構成 |
|---|---|
| 画面 | React + Vite + Cloudflare Pages |
| API | Hono + Cloudflare Workers |
| DB | Cloudflare D1 |
| ログイン | 管理者が事前登録したDiscordアカウントだけを許可するOAuth2 |
| セッション | D1にハッシュ保存、Secure・HttpOnly Cookie |
| Node.js | 22.17.0 |
| Wrangler | 4.110.0 |

権限はAPI側で`member / manager / admin`を毎回確認します。ブラウザから送られた利用者ID・role・groupは認可に使用しません。CORSは環境ごとの画面originへ完全一致で制限し、書込みAPIはCSRFトークンも確認します。

Discordの数値User ID・表示名・プロフィールはD1へ保存しません。IDはOAuth callbackと管理者の事前登録時だけ一時的に処理し、環境別Secretで作った復元不能なHMAC（照合値）だけを保存します。未登録アカウントはログインできません。管理者は1アカウントだけで、宴会コースは管理者だけが閲覧・代理追加できます。代理追加された注文は、利用者の注文履歴にその旨を表示します。

## 先に読む文書

- [公開手順](docs/DEPLOYMENT.md)
- [データ移行](docs/DATA_MIGRATION.md)
- [公開前チェック](docs/RELEASE_CHECKLIST.md)
- [公開記録テンプレート](docs/RELEASE_RECORD_TEMPLATE.md)
- [秘密情報・個人情報の境界](docs/SECRETS_AND_DATA_BOUNDARIES.md)
- [UI方針](docs/UI_REDESIGN.md)
- [管理者向けデータ操作](docs/ADMIN_DATA_OPERATIONS.md)

既存の本番D1へ`api/migrations/0001_initial.sql`を直接適用してはいけません。本番は新しいD1へ構築して切り替える手順を採用します。`0003_discord_allowlist_and_admin_orders.sql`は旧Discord情報と全ログインsessionを削除する非互換migrationなので、既存環境へ適用する場合は受付停止・復元地点の記録・staging先行確認が必須です。

## ローカル確認

```powershell
cd api
npm ci
npm run db:migrate:local
npm test
npm run typecheck
npm run dry-run

cd ..\frontend
npm ci
npm test
npm run lint
npm run build
```

Discord OAuthをローカルで確認する場合だけ、`api/.dev.vars.example`を`api/.dev.vars`へコピーし、ローカル用Discord Applicationの値を入れます。秘密値をGitへ追加しないでください。

## 現在停止している機能

- Web Push通知
- 利用者本人が送った注文の取消UI（管理者が事前追加した注文の訂正だけ利用可）
- 参加者の物理削除

参加者の「利用停止」は、ログイン許可とsessionを無効にして一覧から外す安全な操作です。参加者データを物理削除せず、過去の注文・会計・操作履歴は残します。

管理画面の「開催データをリセット」は、全注文と管理者以外の参加者データを初期化します。唯一の管理者、メニュー、操作履歴、migration情報は消しません。ただし、削除された参加者・担当者と過去の操作履歴との紐づけは解除されます。実行には直近5分以内の管理者ログイン、削除件数の確認、D1復元地点の記録確認、確認文の入力が必要です。詳しい範囲と手順は[管理者向けデータ操作](docs/ADMIN_DATA_OPERATIONS.md)を参照してください。

反応しないボタンや未完成の通信は表示していません。取消用のDB列は将来の監査付き実装に備えて残しています。
