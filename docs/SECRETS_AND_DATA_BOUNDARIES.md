# 秘密情報・個人情報の境界

更新日: 2026-07-14

この文書には実値を記録しません。設定名、保存先、取扱いだけを定義します。

## Workers Secret

環境ごとにCloudflare Workers Secretへ保存します。

- `DISCORD_CLIENT_SECRET`
- `BOOTSTRAP_ADMIN_DISCORD_USER_ID`（初回管理者連携時だけ。成功後すぐ削除）

ローカル開発ではGit対象外の`api/.dev.vars`だけへ保存します。Secretを`wrangler.deploy.toml`、SQL、GitHub、Pages環境変数、チャット、スクリーンショットへ書きません。

## 秘密ではないが環境別の値

- `APP_ENV`
- `ALLOWED_ORIGINS`
- `FRONTEND_URL`
- `SESSION_SITE_DOMAIN`
- `DISCORD_CLIENT_ID`
- `DISCORD_REDIRECT_URI`
- Worker名、D1 database名・database ID
- Pagesの`VITE_API_URL`

実値入り`api/wrangler.deploy.toml`はGit対象外です。tracked fileはplaceholderだけの`api/wrangler.toml.example`です。

## 認証データ

- Discord OAuth access token / refresh tokenは保存せず、session発行後に破棄する。
- ブラウザへはランダムなsession tokenをSecure・HttpOnly・SameSite=Lax Cookieで渡す。
- D1へはsession tokenのSHA-256 hashだけを保存する。
- CSRF tokenはsession tokenとドメイン分離して導出し、D1へ生値を保存しない。
- OAuth `state`は生値をHttpOnly Cookie、hashをD1へ短時間保存し、一度だけ消費する。
- 初回Discord連携コードは本人の画面にだけ表示し、D1へはhashだけ保存する。承認後はhashも消す。
- Discordの表示名・username一致だけで参加者へ自動連携しない。

## 個人情報

- 氏名、所属グループ、Discord数値User ID、注文、session情報をログ本文へ出さない。
- admin APIもDiscord数値User ID本体をフロントへ返さず、連携済みかだけを返す。
- `update_login.sql`、`seed_users.sql`、`menu_list.txt`は追跡・共有・fixture利用を禁止する。
- productionの実参加者は`api/fixtures/production.local.sql`だけへ置き、Gitへ追加しない。
- stagingは架空データの`api/fixtures/staging.sql`だけを使う。
- D1 Time Travel bookmarkとrelease記録は`private-data/`へ置く。

## 廃止済みの秘密値

原本のVAPID鍵は漏えい済みとして扱い、再利用しません。現在はWeb Push機能と`web-push`依存を撤去しているため、新しいVAPID鍵も設定しません。

## 設定例

- frontend: `frontend/.env.example`
- API local secrets: `api/.dev.vars.example`
- Worker/D1: `api/wrangler.toml.example`
- production data: `api/fixtures/production.example.sql`
