# D1データ移行手順

更新日: 2026-07-15

## 採用方針

- `api/migrations/`を唯一の正式schema履歴とする。
- `0001_initial.sql`は新規D1専用とする。
- 既存production D1はそのまま保全し、新しいproduction D1へ切り替える。
- migrationへ参加者名・Discord ID・本番メニューを入れない。
- stagingは`api/fixtures/staging.sql`の架空データだけを使う。

Cloudflare D1 migrationは適用済みファイルを`d1_migrations`へ記録し、未適用分を順番に適用します。[Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)

## 正式migration

1. `0001_initial.sql`
   - users
   - menu_items
   - orders（注文時の名称・サイズ・単価snapshot、冪等request IDを含む）
   - auth_sessions
   - oauth_states
   - discord_link_requests
   - audit_logs
2. `0002_security_constraints.sql`
   - 旧Discord初回連携コードのハッシュ列
   - 旧参加者連携の一意制約
   - 最後のactive adminをDB側で保護するtrigger
3. `0003_discord_allowlist_and_admin_orders.sql`
   - 全sessionと未使用OAuth stateを削除
   - 生Discord ID列と旧連携申請tableを削除
   - 環境別Secretから作るversion付きHMAC照合列と一意制約
   - activeかつ唯一のadminが1人であることを検査し、admin追加をDB側でも禁止
   - `宴会コース`を管理者限定にし、後から直接SQL投入しても限定扱いにするtrigger
   - 注文の追加元（本人または管理者）と操作した管理者を記録

`0001`と`0002`に旧Discord列・旧連携tableが残るのはmigration履歴として必要なためです。fresh DBでは`0001`→`0002`→`0003`の順に適用され、最終schemaから旧情報は消えます。

取消関連列は取消理由・実行者・時刻を監査付きで残します。現在は、管理者が事前追加した注文の入力訂正だけを管理者UIから取消可能です。利用者本人の注文を取り消す通信は行いません。

## production投入ファイル

```powershell
cd api
Copy-Item fixtures\production.example.sql fixtures\production.local.sql
```

`production.local.sql`だけへ実参加者と本番メニューを書きます。このファイルはGit対象外です。

テンプレート内の`置換`を含む行は、使うなら実値へ置き換え、使わないなら行ごと削除してください。安全検査はコメント内も確認するため、例示の`置換`が1つでも残っていると本番投入を止めます。コメントではない`menu_items`のINSERTを最低1件用意したうえで、remoteへ送る前に次を実行します。

```powershell
npm run db:seed:production:check
```

この検査は、有効な初期adminアカウントがちょうど1人、メニューが1件以上、宴会コースが`is_admin_only = 1`、許可したINSERT以外のSQLがないことも確認します。氏名やメニュー内容は出力しません。

ルール:

- 最初はactiveかつ未登録のadminをちょうど1人だけ作る。inactiveを含め、2人目のadminは作らない。
- Discordの表示名・旧usernameを認証キーとして入れない。
- Discordの数値User IDやHMACをSQLへ入れない。
- 初回adminは一時的なbootstrap Secretで登録し、成功直後にそのSecretを削除する。
- 参加者とmanagerは、管理者が本人確認済みのDiscord User IDを管理画面へ事前登録する。未登録アカウントはログインできない。
- roleは`member / manager / admin`だけ。
- 同じ`category + name + size`のメニューを重複させない。
- `宴会コース`のINSERTには`is_admin_only`列を含め、必ず`1`にする。
- priceは円単位の整数、quantityは1〜20。

## 既存D1へ0003を適用する場合

`0003`は旧Discord登録を消し、全sessionを失効させる非互換migrationです。適用中は旧Workerと新schemaが共存できません。次の順で短いメンテナンス時間を設けます。

1. stagingで同じ手順を完了し、登録済み・未登録アカウントの両方を実機確認する。
2. stagingとproductionそれぞれに別の`DISCORD_ID_HMAC_KEY`を作り、パスワード管理アプリへ保存する。
3. 注文受付を止め、適用直前のD1 Time Travel bookmarkと注文集計をrelease記録へ残す。
4. 現在のadminがactiveかつ1人だけであることを確認する。違う場合はmigrationを実行しない。
5. migration、対応Worker、対応Pagesを同じメンテナンス時間内に切り替える。
6. 一時bootstrap Secretで唯一のadminを再登録し、ログイン成功直後にSecretを削除する。
7. 管理画面から参加者・managerの本人確認済みDiscord User IDを再登録する。
8. 未登録アカウント拒否、宴会コース非表示、代理追加注文の本人履歴を確認してから受付を再開する。

HMAC鍵、bootstrap ID、参加者IDはmigration、fixture、release記録へ書きません。

## 旧SQLの扱い

次のファイルは新schemaと互換ではなく、正式手順では使用しません。

- ルート`seed_food.sql`
- ルート`seed_drink.sql`
- ルート`update_menu.sql`
- Git対象外の`update_login.sql`
- Git対象外の`seed_users.sql`

特に`update_menu.sql`は全メニュー削除を含み、注文履歴があるDBでは外部キー制約と衝突します。内容を参照する場合も、必要な行を`production.local.sql`へ手作業で移し、旧SQL自体は実行しません。

## ローカルでfresh DBを検証する

```powershell
cd api
npm run db:migrate:local
npx wrangler d1 execute DB --local --config wrangler.local.toml --file fixtures/staging.sql
```

確認SQL:

```sql
SELECT name FROM sqlite_schema
WHERE type = 'table'
ORDER BY name;

PRAGMA foreign_key_check;

SELECT role, COUNT(*)
FROM users
GROUP BY role;
```

`PRAGMA foreign_key_check`が0件であることを確認します。

## production投入前後の比較

個人名を出力せず、次を記録します。

```sql
SELECT role, COUNT(*) AS count FROM users GROUP BY role ORDER BY role;
SELECT category, COUNT(*) AS count FROM menu_items GROUP BY category ORDER BY category;
SELECT COUNT(*) AS order_count,
       COALESCE(SUM(unit_price_snapshot * quantity), 0) AS total_amount
FROM orders
WHERE status != 'cancelled';
PRAGMA foreign_key_check;
```

旧DBから注文履歴を移す場合は、旧schemaの構造確認と専用変換migrationが別途必要です。列を推測してコピーしません。今回の推奨は、旧DBを読取保全し、新開催回を新D1で開始する方式です。
