# 例大祭打ち上げ かんたん注文

スマートフォンから料理・飲み物を注文し、グループ担当者が取りまとめるWebアプリです。20〜30歳を主対象に、スマートフォン操作に慣れていない人でも「選ぶ → 確認 → 送る」の順で使えるUIにしています。

## 現在の構成

| 項目 | 構成 |
|---|---|
| 画面 | React + Vite + Cloudflare Pages |
| API | Hono + Cloudflare Workers |
| DB | Cloudflare D1 |
| ログイン | Discord OAuth2 authorization code flow |
| セッション | D1にハッシュ保存、Secure・HttpOnly Cookie |
| Node.js | 22.17.0 |
| Wrangler | 4.110.0 |

権限はAPI側で`member / manager / admin`を毎回確認します。ブラウザから送られた利用者ID・role・groupは認可に使用しません。CORSは環境ごとの画面originへ完全一致で制限し、書込みAPIはCSRFトークンも確認します。

## 先に読む文書

- [公開手順](docs/DEPLOYMENT.md)
- [データ移行](docs/DATA_MIGRATION.md)
- [公開前チェック](docs/RELEASE_CHECKLIST.md)
- [公開記録テンプレート](docs/RELEASE_RECORD_TEMPLATE.md)
- [秘密情報・個人情報の境界](docs/SECRETS_AND_DATA_BOUNDARIES.md)
- [UI方針](docs/UI_REDESIGN.md)

既存の本番D1へ`api/migrations/0001_initial.sql`を直接適用してはいけません。本番は新しいD1へ構築して切り替える手順を採用します。

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
- 注文取消の実行UI
- 全データリセット
- 参加者の物理削除

反応しないボタンや未完成の通信は表示していません。取消用のDB列は将来の監査付き実装に備えて残しています。
