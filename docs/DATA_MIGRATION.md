# D1データ移行手順

更新日: 2026-07-14

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
   - Discord初回連携コードのハッシュ列
   - 参加者と承認済みDiscord連携の一意制約
   - 最後のactive adminをDB側で保護するtrigger

取消関連列は将来、取消理由・実行者・時刻を監査付きで実装するために残しています。現在のUIから取消通信は行いません。

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

この検査は、有効な初期adminがちょうど1人、メニューが1件以上、許可したINSERT以外のSQLがないことも確認します。氏名やメニュー内容は出力しません。

ルール:

- 最初はactiveかつ未連携のadminをちょうど1人にする。
- Discordの表示名・旧usernameを認証キーとして入れない。
- Discordの数値User IDを本人確認なしで推測・転記しない。
- 参加者は初回OAuth後、本人のスマホの8文字コードを管理者が直接照合して連携する。
- roleは`member / manager / admin`だけ。
- 同じ`category + name + size`のメニューを重複させない。
- priceは円単位の整数、quantityは1〜20。

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
