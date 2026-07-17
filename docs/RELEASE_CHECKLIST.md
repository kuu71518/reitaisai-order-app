# 公開前チェックリスト

更新日: 2026-07-17

現在の`[x]`は、2026-07-17時点の未コミットworking treeに対するローカル検証記録であり、そのまま公開承認には使いません。release commit後に同じ検証を全件再実行し、コード変更が入った場合も再実行してください。今回追加した参加者操作と開催データ初期化の`[ ]`は、ローカル自動テストが成功していても、release commitとstaging D1で再確認するまで完了扱いにしません。

- Release commit SHA: 未確定（公開前に記入）
- 最終検証JST / UTC: 未確定（同じSHAの検証完了後に記入）
- 検証者: 未確定

## Git・依存関係

- [ ] 秘密値・実参加者SQL・D1 ID入り設定がGit対象外
- [ ] 初回commit前に`git check-ignore`とstaged差分を確認
- [ ] GitHub Private repositoryのremoteが設定済み
- [ ] `main`と`staging` branchがGitHubへpush済み
- [ ] Node.js 22.17.0
- [ ] `api`のWrangler 4.110.0
- [x] root、api、frontendで`npm ci`成功
- [x] 依存関係のオンライン監査結果を確認（root / api / frontendとも0件）

## 自動検証

- [x] API unit tests
- [x] API TypeScript check
- [x] Worker dry-run bundle
- [x] frontend tests
- [x] frontend lint
- [x] frontend production build
- [x] fresh local D1へ全migration適用
- [x] staging fixture適用
- [x] foreign key error 0件
- [ ] 320px幅のログインUIを実ブラウザで確認
- [ ] 未ログイン初回画面に誤った「期限切れ」を出さないことを実ブラウザで確認
- [x] memberからadmin APIを403
- [x] CSRFなしの書込みを403
- [x] 注文bodyの偽user IDを無視し、session本人で保存
- [x] HMAC Secret不足時にOAuthを503でfail closed
- [x] 生Discord ID列と旧連携申請tableが最終schemaに存在しない
- [x] activeかつ唯一のadmin 1人をDB制約で保護
- [x] memberのメニューから宴会コースを除外
- [x] memberが宴会コースIDを直接指定しても404
- [x] memberから管理者代理注文APIを403
- [x] 管理者追加注文の追加元を記録し、管理者追加分だけ訂正可能
- [ ] 一括参加者追加は1件でも不正なら全件取消
- [ ] 参加者の利用停止でsessionを失効し、注文・会計・操作履歴を保持
- [ ] 開催データ初期化は直近ログイン・復元地点確認・確認文が揃わなければ拒否
- [ ] 開催データ初期化後もadmin 1人、メニュー、操作履歴を保持
- [x] JST 21:29は注意非表示、21:30は表示

## staging環境

- [ ] Cloudflare dashboardで所有zone apexと`Active` statusを本人が確認
- [ ] zoneのCloudflare accountと`wrangler whoami`のaccountが一致
- [ ] 4つの予定hostnameに既存DNS recordがない
- [ ] `npm run check:deploy-config:staging`成功（production未設定でも実行可）
- [ ] CORSはstaging Pagesの正確なoriginだけ
- [ ] PagesとAPIが同じ独自ドメインsite配下
- [ ] staging migration一覧を確認して適用
- [ ] 架空fixtureだけを投入
- [ ] stagingとproductionで別の`DISCORD_ID_HMAC_KEY`をパスワード管理アプリへ保存
- [ ] iPhone SafariでDiscordログイン成功
- [ ] Android ChromeでDiscordログイン成功
- [ ] 初回admin bootstrap後にbootstrap Secret削除
- [ ] 登録済みアカウントだけログイン成功
- [ ] 未登録アカウントを拒否し、未知のDiscord情報をDBへ残さない
- [ ] ログイン許可解除後、既存sessionも利用不可
- [ ] member / manager / adminの実機権限確認
- [ ] memberに宴会コースが見えず、ID直指定も拒否
- [ ] admin代理追加が本人履歴へ表示され、宴会コースは即`ordered`
- [ ] 管理者の事前追加だけ訂正でき、合計と監査ログへ反映
- [ ] 架空データで参加者の一括追加・利用停止を確認
- [ ] staging D1のTime Travel bookmarkを記録して開催データ初期化を確認
- [ ] staging初期化後に注文件数0、admin 1人、メニュー維持、外部キー違反0件を確認
- [ ] stagingの復元地点から戻す手順を確認
- [ ] 21:29非表示・21:30表示をJSTで確認
- [ ] 320px幅で追加toastと固定カートを確認
- [ ] 他グループ注文へのID指定アクセスを拒否
- [ ] ログアウト後のsession再利用を拒否
- [ ] PWAがAPI・認証レスポンスをキャッシュしない
- [ ] OAuth `/api/auth/discord/start`のWAF rate limitをstagingで検証
- [ ] 同一会場Wi-Fiの複数端末でWAF誤検知なし
- [ ] callbackも保護する場合はDiscord往復後のログイン成功を両OSで確認
- [ ] WAF rule名・path・閾値・期間・action・plan制約を記録

## production直前

旧productionがない初回公開では、旧環境に関する各欄へ`N/A（初回公開）`と理由を記録します。

- [ ] productionは新規D1を指定
- [ ] `npm run check:deploy-config:production`成功（両環境の完全性と相互分離を検査）
- [ ] staging Workerとproduction Workerが別
- [ ] staging D1とproduction D1が別
- [ ] staging/production Discord Applicationが別
- [ ] `d1 info`のname/UUIDが作成直後の新D1と一致
- [ ] baseline前に`npm run db:assert-empty:production`成功（remote `sqlite_schema`でapp table 0件）
- [ ] 旧production D1へbaselineを適用していない
- [ ] 旧Pages deployment/custom domain/環境変数設定を記録
- [ ] 旧Worker version/route/変数名/D1 bindingを記録
- [ ] 旧D1 name/ID/migration/注文集計を記録
- [ ] 旧production D1の切替直前Time Travel bookmarkを記録（初回公開はN/A理由を記録）
- [ ] 旧注文の受付停止・処理方針・切替JST/UTC時刻を記録
- [ ] 旧Pages/Worker/D1を削除していない
- [ ] 初回専用`npm run db:bootstrap:production`成功（空D1再検査 + baseline）
- [ ] production migration適用後の未適用0件を確認
- [ ] `npm run db:seed:production`成功（seed静的検査を含む）
- [ ] 新production D1の公開直前Time Travel bookmarkを記録
- [ ] Git commit SHA、JST/UTC検証時刻、clean worktreeを記録
- [ ] Pages production deploymentのSHAが記録したcommit SHAと一致
- [ ] production participant/menu件数を個人名なしで記録
- [ ] Client SecretをWorkers Secretへ登録
- [ ] production専用HMAC鍵をWorkers Secretへ登録し、復旧可能性を確認
- [ ] Client SecretがGit・ログ・チャットにない
- [ ] HMAC鍵・Discord User IDがGit・ログ・チャットにない
- [ ] 本人確認済みの初回admin Discord User IDをSecret登録
- [ ] production OAuth WAF ruleを有効化し設定を記録
- [ ] production Pages custom domainが`Active`でHTTPS接続可能
- [ ] Pages/Worker/D1/旧全体それぞれのrollback担当者と対象IDを確認
- [ ] D1 restoreが公開後注文を失うことを担当者が理解

## production公開後

- [ ] 管理者ログイン成功
- [ ] bootstrap Secret削除
- [ ] 本人確認済み参加者・managerのログイン許可を管理画面から登録
- [ ] ログイン許可登録後の新D1公開直前bookmarkを記録
- [ ] URL案内時刻と注文受付開始時刻を記録
- [ ] ダミー注文を作らず、最初の実注文ID/時刻を記録
- [ ] 最初の実注文をmember表示とmanager自グループ表示で照合
- [ ] 最初の実注文の数量・状態・会計合計を照合
- [ ] admin操作履歴を確認
- [ ] 公開後15分はadmin/managerが監視
- [ ] Pages、Worker、D1の対象環境名をrelease記録へ追記
- [ ] 旧D1を削除せず、読取保全
- [ ] 受付停止時の告知・API domain停止・障害後bookmark取得手順を担当者が確認

`production直前`までの全項目が完了する前に実参加者へURLを案内しません。案内後は`production公開後`を順番に完了します。
