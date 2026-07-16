# 秘密情報・個人情報の境界

更新日: 2026-07-15

この文書には実値を記録しません。設定名、保存先、取扱いだけを定義します。

## Workers Secret

環境ごとにCloudflare Workers Secretへ保存します。

- `DISCORD_CLIENT_SECRET`
- `DISCORD_ID_HMAC_KEY`（ログイン許可の照合値を作る恒久鍵。stagingとproductionで別の32文字以上のランダム値）
- `BOOTSTRAP_ADMIN_DISCORD_USER_ID`（初回管理者連携時だけ。成功後すぐ削除）

ローカル開発ではGit対象外の`api/.dev.vars`だけへ保存します。Secretを`wrangler.deploy.toml`、SQL、GitHub、Pages環境変数、チャット、スクリーンショットへ書きません。

`DISCORD_ID_HMAC_KEY`は通常運用中も必要です。値を失う・変更する・別環境の値で上書きすると、保存済みの照合値と一致しなくなり、全利用者を管理画面から再登録するまで新規ログインできません。値本体ではなく「パスワード管理アプリに復旧可能な状態で保存済みか」だけをrelease記録へ残します。

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
- 管理者が確認したDiscord数値User IDは、管理画面から送信されたrequest内でだけ処理し、生値をD1へ保存しない。
- OAuth応答からは数値User IDだけを一時的に読み、表示名・username・avatar・email・messageを保存しない。
- D1へは`DISCORD_ID_HMAC_KEY`で導出したversion付きHMACだけをログイン許可の照合値として保存する。HMACから元のIDは復元できない。
- 未登録のDiscordアカウントは拒否し、未知のIDやプロフィールをD1へ残さない。
- sessionにはアプリ内の利用者IDと認証済み状態だけを結び付け、Discord情報を入れない。

## 個人情報

- Cloudflare Workers/Wrangler/ブラウザconsole等の運用ログ本文へ、氏名、所属グループ、Discord数値User ID、HMAC、注文内容、session情報を出さない。
- D1の`audit_logs`は運用ログとは別の管理者限定監査データである。操作種別、アプリ内ID、role・所属グループ・数量・価格等の必要最小限だけを保存し、Discord数値User ID、HMAC、氏名、session tokenは保存しない。
- admin APIもDiscord数値User ID本体をフロントへ返さず、連携済みかだけを返す。
- `update_login.sql`、`seed_users.sql`、`menu_list.txt`は追跡・共有・fixture利用を禁止する。
- productionの実参加者は`api/fixtures/production.local.sql`だけへ置き、Gitへ追加しない。
- stagingは架空データの`api/fixtures/staging.sql`だけを使う。
- D1 Time Travel bookmarkとrelease記録は`private-data/`へ置く。

## 旧D1とバックアップ

`0003`適用直前の旧D1、Time Travel復元点、SQL exportには、削除前の生Discord User IDや表示名snapshotが含まれる可能性があります。これらは新schemaのD1より機密度が高いバックアップとして扱います。

- Cloudflare accountと`private-data/`のアクセスを公開担当者だけに制限する。
- bookmark、export、旧D1の識別情報をGit・チャット・共有資料へ貼らない。
- Cloudflare planごとのTime Travel自動保持期間と、旧D1/exportの運営上必要な保管期限をrelease記録へ残す。
- 旧環境の保全解除を決めるまでは削除しないが、期限後は責任者承認のもとで安全に廃棄する。
- 古い復元点へrestoreした場合は外部公開を再開する前に`0003`を再適用し、生Discord情報の削除とsession失効を確認する。

## 廃止済みの秘密値

原本のVAPID鍵は漏えい済みとして扱い、再利用しません。現在はWeb Push機能と`web-push`依存を撤去しているため、新しいVAPID鍵も設定しません。

## 設定例

- frontend: `frontend/.env.example`
- API local secrets: `api/.dev.vars.example`
- Worker/D1: `api/wrangler.toml.example`
- production data: `api/fixtures/production.example.sql`
