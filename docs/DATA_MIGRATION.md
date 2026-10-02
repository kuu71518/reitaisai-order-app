# D1データ移行手順

更新日: 2026-10-02（JST）

## 採用方針

- `api/migrations/`を唯一の正式schema履歴とする。
- `0001_initial.sql`は新規D1専用とする。
- 旧システムから初回移行するときは既存production D1を保全し、新しいproduction D1へ切り替える。正式migration適用済み環境の日常更新は、未適用migrationだけを追加する。
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
4. `0004_cleared_order_requests.sql`
   - 注文履歴削除後の遅延再送を拒否する送信識別子のtableとtrigger
5. `0005_push_subscriptions.sql`
   - 通知先URLを利用者と認証sessionへ結び付けるtableとindex
6. `0006_chief_role.sql`
   - usersの役割制約へ`chief`を追加
   - users表を削除せず、既存のID・所属・役割・ログイン許可を保持して役割列を置き換える
   - 管理者1人の制約と最後のactive admin保護triggerを同じmigration内で復元
7. `0007_cash_receipts.sql`
   - 参加者ごとの受領状態、確認した注文合計、時刻、更新番号、直前の操作識別子を保存する`cash_receipts` table
   - 実受取額やテーブルチャージを計算・保存しない

`0001`と`0002`に旧Discord列・旧連携tableが残るのはmigration履歴として必要なためです。fresh DBでは`0001`→`0002`→`0003`の順に適用され、最終schemaから旧情報は消えます。

取消関連列は既存のものを使い、取消理由・実行者・時刻を監査付きで残します。確認中は本人・同グループmanager・admin、伝達済みは店舗確認済みのadminだけが取消可能です。取消機能のために既存注文を削除・初期化するmigrationは実行しません。

## 0005適用済み環境へ主任・現金受領記録を追加する場合

`0006`は役割制約を広げ、既存users、注文、menu、認証session、通知登録、削除済み送信識別子、監査記録の内容と参照関係を保持します。usersをDROPして作り直す方法は外部キーによる削除を起こすため使いません。

`0007`は空の受領記録tableとindexを追加します。既存注文・利用者・ログイン情報を変更せず、過去の受領状態を推測して投入しません。

1. 対象がstagingであることと、`0005`までの適用状況を確認する。初回移行・bootstrap・seedの手順を既存環境へ実行しない。
2. 適用直前のTime Travel復元地点、DB名、Worker/Pagesの公開版、各table件数・注文状態別合計・外部キー検査結果を非公開のrelease記録へ保存する。
3. 未適用migrationが予定どおりであることを確認し、`0006`→`0007`、対応Worker、対応Pagesの順に反映する。通知鍵やDiscord/HMACの既存設定を変更する必要はない。
4. 適用前後の件数・注文合計・外部キーを照合し、既存ログインが保持されること、主任の全グループ会計、担当者の自グループ制限、主任の管理・取りまとめAPI拒否を確認する。
5. 注文取消は架空データで、数量や状態変更時の409、取消済みへの再送、監査と会計への反映を確認する。本番の注文を検証のために取り消さない。
6. 現金受領は管理者・主任だけが記録・解除できること、担当者は自グループの閲覧だけであること、注文合計の変更・同時更新を検知することを架空データで確認する。

これは検証環境向けの手順です。本番への同じ変更は別途公開承認とstaging結果が必要です。コードを旧版へ戻してもDBを自動restoreしません。旧版は`chief`を扱えないため、主任を割り当てた後の切戻しでは主任の利用を止める影響も記録し、役割変更やD1復元は別途判断します。

## 0003適用済み環境へ0004・0005を追加する場合

`0004`と`0005`はtable・index・triggerの追加だけです。既存の注文、参加者、メニュー、認証sessionを削除・変更しません。既存環境を空にするbootstrapやseedは実行しません。

stagingの架空データで先に検証し、対象DBと適用済みmigrationを確認して、適用直前のTime Travel復元地点を記録します。未適用分が`0004`・`0005`だけであることを確認し、追加migration → 対応Worker → 対応Pagesの順で反映します。`0003`が未適用ならこの手順を止め、非互換migration用の手順を使います。新旧の通知鍵は再利用せず、[通知の公開手順](PUSH_NOTIFICATIONS.md)に従います。

反映前後で注文・利用者・メニュー件数と`PRAGMA foreign_key_check`を比較します。公開時に注文履歴削除APIを実行する必要はありません。コードだけのrollbackでは追加tableを残し、D1をrestoreしません。履歴削除を実行した後は、旧Workerでもtriggerにより同じ識別子の再送は挿入されませんが、旧画面では専用の削除済みメッセージを表示できないため受付停止中に切り戻します。

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
- `0006`以降のroleは`member / manager / chief / admin`。通常の追加操作ではadminを指定しない。
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

## 管理画面から開催データを初期化する場合

管理画面の初期化機能は、schemaを作り直すmigrationではありません。全注文、管理者以外の参加者、管理者分を含む全現金受領記録を削除し、唯一の管理者、メニュー、操作履歴、migration情報を保持します。参加者・担当者の削除時は外部キー制約により、過去の操作履歴にある実行者との紐づけが解除され、画面では「システム」と表示されます。初期化操作そのもののために追加migrationは行いません。

「注文履歴だけを削除」はこの初期化と異なり、現金受領記録を保持します。受領時に確認した注文合計と削除後の合計との差があれば、会計で変更注意として表示します。

productionで使う場合は、必ず次の順に進めます。

1. 注文受付を止める。
2. D1 Time Travel bookmarkを取得し、非公開のrelease記録へJST時刻とともに保存する。
3. 管理画面へログインし直す。
4. 画面に表示された削除件数と保持件数を確認する。
5. 復元地点を記録済みの確認欄と確認文を入力し、初期化する。
6. 注文件数0、activeなadmin 1人、メニュー件数維持、`PRAGMA foreign_key_check` 0件を確認する。
7. 問題がなければ参加者を一括登録し、登録済み・未登録アカウントのログイン可否をstagingと同じ手順で確認してから受付を再開する。

復元地点を未記録のまま実行しません。復元が必要な場合はWorkerから自動実行せず、[公開手順](DEPLOYMENT.md)とrelease記録に従ってCloudflare側で一段階ずつ行います。

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
