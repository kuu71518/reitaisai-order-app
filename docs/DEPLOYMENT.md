# 公開手順（GitHub + Cloudflare）

更新日: 2026-07-14

この手順は、stagingで実機確認した後にproductionへ公開するための手順です。最初から本番へ直接出さないでください。

すべてのPowerShell例はrepository rootから開始します。`Push-Location api`を含むblockは最後の`Pop-Location`まで実行するとrepository rootへ戻ります。`REPLACE_...`と書かれた文字列は、実値へ置換してから実行します。

## 1. 公開構成

本番とstagingでWorker・D1・Discord Applicationを分けます。画面とAPIは、必ずHTTPSかつ同じ所有ドメイン配下にします。

| 環境 | Pages | Worker API | D1 | Git branch |
|---|---|---|---|---|
| staging | `https://staging-app.<所有ドメイン>` | `https://staging-api.<所有ドメイン>` | 新規staging D1 | `staging` |
| production | `https://app.<所有ドメイン>` | `https://api.<所有ドメイン>` | 新規production D1 | `main` |

`*.pages.dev`と`*.workers.dev`は別siteです。この組合せでは`SameSite=Lax`のログインCookieが安定して送られないため、公開URLには使いません。PagesとWorkerのカスタムドメイン設定はCloudflare公式の[Pages Custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/)と[Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)に沿います。

`<所有ドメイン>`は、Cloudflare dashboardの`Websites`に`Active`として表示されるzone apex（例: `touhoudaienkai.com`）でなければなりません。単に取得済みのドメイン、別アカウント管理のドメイン、`pages.dev`の名前では代用できません。この所有確認は設定検査では判定できないため、本人がdashboardで目視し、zone apexと確認日時をrelease記録へ残します。

## 2. 最初に本人が用意するもの

### GitHub

1. GitHubで空のPrivate repositoryを1つ作る。
2. README、`.gitignore`、LicenseはGitHub側で追加しない。
3. repository URLを控える。

Cloudflare PagesはGitHub repositoryへ接続すると、branchへのpushごとに自動でbuild・deployします。詳細は[Cloudflare Pages GitHub integration](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/)を参照してください。

repositoryを作ったら、Cloudflareへ接続する前にローカルの初回commitと2つのbranchを送ります。`$repoUrl`の`REPLACE_...`部分は、先ほど控えたURLへ置き換えます。

```powershell
$repoUrl = "https://github.com/REPLACE_ACCOUNT/REPLACE_REPOSITORY.git"
git status --short
git check-ignore api/wrangler.deploy.toml api/fixtures/production.local.sql api/.dev.vars private-data/
git add .
git diff --cached --check
git diff --cached --stat
git diff --cached
git commit -m "chore: prepare secure staging release"
git branch -M main
git remote add origin $repoUrl
git push -u origin main
git switch -c staging
git push -u origin staging
git switch main
```

`git check-ignore`で指定したpathが表示されない、またはstaged差分に秘密値・実名・実参加者データが見えた場合はcommitせず止めます。すでにcommitがある場合は`git commit`を、`origin`がある場合は`git remote add`を、`staging` branchがある場合は`git switch -c staging`をそれぞれ実行せず、現在の設定を確認します。`git push --force`は使いません。

### 独自ドメイン

Cloudflareで管理しているドメインを1つ決め、上表の4つのhostnameを決めます。`touhoudaienkai.com`を管理している場合は、例えば次の名前にできます。

- `order.touhoudaienkai.com`
- `order-api.touhoudaienkai.com`
- `staging-order.touhoudaienkai.com`
- `staging-order-api.touhoudaienkai.com`

既存のDNS名は上書きしません。使用中のhostnameがある場合は別名を選びます。

Cloudflare dashboardで次を本人が確認し、release記録へ転記します。

1. `Websites > <所有ドメイン> > Overview`のzone statusが`Active`。
2. 表示中のzone apexが4つのhostnameの末尾と完全に一致。
3. `DNS > Records`に同名の既存recordがない。
4. Cloudflare accountが`npx wrangler whoami`で表示されるaccountと同じ。

### Discord

staging用とproduction用にDiscord Applicationを1つずつ作ります。

1. [Discord Developer Portal](https://discord.com/developers/applications)で`New Application`を押す。
2. `OAuth2`でRedirect URIを1つ登録する。
3. stagingは`https://staging-api.<所有ドメイン>/api/auth/discord/callback`。
4. productionは`https://api.<所有ドメイン>/api/auth/discord/callback`。
5. Client IDを控える。
6. Client Secretはパスワード管理アプリ等へ保存し、Git・文書・チャットへ貼らない。

アプリは`identify`だけを要求し、メッセージ・メール・サーバー一覧は取得しません。Discord公式のauthorization code flowと`state`確認に従っています。[Discord OAuth2](https://docs.discord.com/developers/topics/oauth2)

初回管理者用に、自分のDiscord数値User IDも控えます。DiscordのDeveloper Modeを有効にし、自分のプロフィールから`Copy User ID`を選びます。この値も公開文書へ書きません。

## 3. ローカルの公開設定を作る

```powershell
Push-Location api
Copy-Item wrangler.toml.example wrangler.deploy.toml
Pop-Location
```

`wrangler.deploy.toml`のstaging欄のplaceholderを、決めたWorker名・D1名・D1 ID・Pages URL・API URL・Discord Client IDへ置換します。production欄はproductionの準備時までplaceholderのままで構いません。このファイルはGit対象外です。

設定後に検査します。

```powershell
Push-Location api
npm run check:deploy-config:staging
Pop-Location
```

`check:deploy-config:staging`はstaging欄だけを厳格に検査し、未設定のproduction欄は無視します。productionを準備するときは`npm run check:deploy-config:production`を使います。production検査と汎用の`npm run check:deploy-config`は両環境を検査し、相互分離も必須にします。

次を自動で拒否します（環境間の同一値はproduction・全環境検査時に確認します）。

- placeholderの残存
- stagingとproductionで同じD1
- HTTP URL
- `pages.dev` / `workers.dev`をCookie siteに指定
- 画面とAPIが別site
- CORS originと画面originの不一致
- Discord callbackとWorker domainの不一致
- 設定ファイルへClient Secretを書いた場合

## 4. Cloudflare CLIへログインする

```powershell
Push-Location api
npm ci
npx wrangler login
npx wrangler whoami
Pop-Location
```

表示されたCloudflare accountが公開先と一致することを確認します。

## 5. stagingを作る

### D1

```powershell
Push-Location api
npx wrangler d1 create reitaisai-order-staging --location=apac
Pop-Location
```

返されたdatabase nameとIDを`wrangler.deploy.toml`のstagingへ入れ、再度`npm run check:deploy-config:staging`を実行します。production欄のplaceholderは、この段階では検査を妨げません。

```powershell
Push-Location api
npm run db:migrations:list:staging
npm run db:migrate:staging
npx wrangler d1 execute DB --remote --env staging --config wrangler.deploy.toml --file fixtures/staging.sql
Pop-Location
```

`fixtures/staging.sql`は架空ユーザー・架空メニューだけです。

### WorkerとSecret

```powershell
Push-Location api
npm run deploy:staging
npx wrangler secret put DISCORD_CLIENT_SECRET --env staging --config wrangler.deploy.toml
npx wrangler secret put BOOTSTRAP_ADMIN_DISCORD_USER_ID --env staging --config wrangler.deploy.toml
Pop-Location
```

Secret入力時は値を画面共有・録画・チャットへ出しません。Workerの`Settings > Domains & Routes`でstaging API custom domainが有効になったことを確認します。

### PagesをGitHubへ接続

1. Cloudflare dashboardの`Workers & Pages`を開く。
2. `Create application > Pages > Connect to Git`を選ぶ。
3. GitHub Appの対象を、このPrivate repositoryだけに制限する。
4. Production branchを`main`にする。
5. Preview branchは`staging`だけを許可する。
6. Root directoryを`frontend`にする。
7. Build commandを`npm ci && npm run build`にする。
8. Build output directoryを`dist`にする。
9. Production環境の`VITE_API_URL`をproduction API URLにする。
10. Preview環境の`VITE_API_URL`をstaging API URLにする。
11. 両環境の`NODE_VERSION`を`22.17.0`にする。

Viteの標準設定は`npm run build`と`dist`です。Cloudflare公式の[Pages Build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/)でも同じ値が案内されています。

staging branchのdeployment成功後、Pagesのstaging custom domainをstaging branch aliasへ接続します。手順は[Add a custom domain to a branch](https://developers.cloudflare.com/pages/how-to/custom-branch-aliases/)を参照してください。

この時点の`main` deploymentと`pages.dev` URLは初期build確認用です。production custom domainはまだ案内せず、production D1・Worker・復元地点を準備した後の手順9で接続します。

## 6. staging実機確認

### OAuth入口にWAF rate limitingを設定する

Worker custom domainが有効になったら、Cloudflare dashboardの`Websites > <所有zone> > Security > WAF > Rate limiting rules`でOAuth入口を保護します。Cloudflare公式の[Rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/)にあるとおり、利用できる条件・期間・rule数はplanで異なり、Free planはpath条件・IP単位・10秒期間・1 ruleです。

最低限のruleは次の値で作ります。

- 対象path: `/api/auth/discord/start`と完全一致
- 計数: IP単位（dashboardの既定のdata center IDを含む）
- 期間: planで選べる最短期間。Freeは10秒
- 初期候補: 30 requests / 10秒。会場Wi-Fiでは複数端末が同じIPになるため、この数値を無条件で本番採用しない
- staging検証前: planにpreview/log相当があればそれを使う。なければruleを無効のまま保存するか、通常操作に影響しない高い閾値で開始する
- staging検証後: `Managed Challenge`を優先し、正常なDiscord往復を妨げないことを確認してから有効化する。明確な濫用だけを止められる検証結果がある場合に限り`Block`を選ぶ

planが2 rule以上を許す場合は、`/api/auth/discord/callback`を別rule・より高い閾値で追加できます。callbackへのchallengeはDiscordから戻る途中のURLを再処理するため、iPhone SafariとAndroid Chromeで必ず成功を確認します。失敗する場合はcallback ruleを無効にし、最低限`/start`の保護を残します。Free planではhostname条件を使えないため、同じzone内の同一pathにもruleが及ぶ点を確認します。

### 実機テスト

1. staging URLをスマートフォンで開く。
2. 管理者本人がDiscordでログインする。
3. staging fixtureの唯一の未連携adminへbootstrapされることを確認する。
4. 直後にbootstrap Secretを削除する。

```powershell
Push-Location api
npx wrangler secret delete BOOTSTRAP_ADMIN_DISCORD_USER_ID --env staging --config wrangler.deploy.toml
Pop-Location
```

5. 別のDiscordアカウントで初回ログインし、8文字の確認コードが表示されることを確認する。
6. 管理画面で、本人のスマホに出たコードを直接見て入力する。
7. 間違ったコードが拒否され、正しいコードだけ連携できることを確認する。
8. memberが管理APIへ入れないことを確認する。
9. managerが自グループ以外を見られないことを確認する。
10. 注文、二重送信防止、数量変更、伝達済み、会計、ログアウトを確認する。
11. iPhone SafariとAndroid Chromeの少なくとも1台ずつで確認する。
12. 同じ会場Wi-Fiから複数端末で通常ログインし、WAFの誤検知がないことを確認する。
13. WAF rule名、対象path、閾値、期間、action、検証結果をrelease記録へ残す。

## 7. production D1を新規作成する

既存production D1へbaseline migrationを流しません。新しいD1を作って、検証済みデータだけ移します。

```powershell
Push-Location api
npx wrangler d1 create reitaisai-order-production-v2 --location=apac
Pop-Location
```

新しいnameとIDを`wrangler.deploy.toml`のproductionへ入れ、`npm run check:deploy-config:production`を実行します。この検査はstagingとproductionの両方を厳格に検証し、Worker・domain・Discord Application・D1の同一値事故を拒否します。旧production D1のIDを入れないでください。

baselineを適用する前に、production bindingが本当に新規の空D1を指すことをremote queryで確認します。

```powershell
$newProductionDb = "reitaisai-order-production-v2"
Push-Location api
npx wrangler d1 info $newProductionDb --json
npm run db:assert-empty:production
Pop-Location
```

`d1 info`のname/UUIDが作成直後の値と一致し、`db:assert-empty:production`がremote `sqlite_schema`を調べてapp table 0件で成功することが合格条件です。`users`、`orders`、`menu_items`、`d1_migrations`など対象tableが1件でも検出されるとscriptは失敗します。その場合はbaselineを実行せず、binding先を調べ直します。画面上の「新規」という記憶だけで先へ進めません。

参加者・メニュー準備は[DATA_MIGRATION.md](DATA_MIGRATION.md)に従います。

## 8. 旧production環境を保全し、切替地点を記録する

公開ごとに、変更・削除を始める前にrelease記録を作ります。`private-data`はGitへ追加しません。

```powershell
New-Item -ItemType Directory -Force private-data | Out-Null
$releaseRecord = "private-data/release-$((Get-Date).ToString('yyyyMMdd-HHmm')).md"
Copy-Item docs/RELEASE_RECORD_TEMPLATE.md $releaseRecord
$releaseRecord
```

旧環境がある場合は、次を画面と設定からrelease記録へ転記します。

- Pages: project名、production deployment ID/URL、commit SHA、production branch、custom domain、`VITE_API_URL`
- Worker: name、直前の正常なversion/deployment ID、custom domain/route、compatibility date、変数名、D1 binding `DB`のdatabase name/ID
- D1: database name/ID、適用済みmigration、未処理注文数、取消を除く注文数・合計額、最後の注文ID/日時
- DNS: production画面/API hostnameの変更前record
- Secret: 値そのものではなく、旧Workerへ再登録できる値がパスワード管理アプリに保管済みであること

切替開始を参加者と運営へ知らせ、旧システムへの新規注文を止めます。未処理注文を旧システム側で処理し終えるか、担当者・注文ID・数量を別途引き継いでから、切替時刻を決めます。旧と新の両方で同時に注文を受け付けません。

```powershell
$previousProductionDb = "REPLACE_PREVIOUS_PRODUCTION_DATABASE_NAME"
$cutoverNow = [DateTimeOffset]::UtcNow
$cutoverUtc = $cutoverNow.ToString("o")
$cutoverJst = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId($cutoverNow, "Tokyo Standard Time").ToString("o")
$cutoverJst
$cutoverUtc
Push-Location api
npx wrangler d1 time-travel info $previousProductionDb --timestamp $cutoverUtc --json
Pop-Location
```

JST/UTC時刻と返された旧D1 bookmarkをrelease記録へ転記します。既存のproductionがない初回公開では、旧環境の各欄を空欄にせず`N/A（初回公開）`と記録します。

旧production Pages/Workerを別projectとして置き換える場合は、旧custom domain/routeを切替直前に外しますが、旧Pages project、Worker、D1、deploymentは削除しません。同じproject内の更新では、旧deployment IDを残したまま次へ進みます。

Time Travelの`info`と`restore`はWranglerの正式コマンドです。[Cloudflare D1 commands](https://developers.cloudflare.com/workers/wrangler/commands/d1/)

## 9. productionへ適用する

### D1、Worker、Secretを準備する

```powershell
Push-Location api
npm run check:deploy-config:production
npm run db:migrations:list:production
npm run db:bootstrap:production
npm run db:migrations:list:production
npm run db:seed:production
npm run deploy:production
npx wrangler secret put DISCORD_CLIENT_SECRET --env production --config wrangler.deploy.toml
npx wrangler secret put BOOTSTRAP_ADMIN_DISCORD_USER_ID --env production --config wrangler.deploy.toml
Pop-Location
```

`db:bootstrap:production`は初回の新規production D1専用で、空D1を再検査してからbaseline migrationを適用します。2回目のmigration一覧（未適用0件）、`db:seed:production`の静的検査と投入まで、すべて成功することを確認します。seed検査はplaceholderや例示値を拒否し、`users`/`menu_items`へのVALUES形式INSERTだけ、有効な初期adminちょうど1人、menu 1件以上を要求します。投入後のuser/menu件数が準備資料と一致することも確認します。

公開後に追加migrationだけを適用するときは`npm run db:migrations:list:production`で内容を確認してから`npm run db:migrate:production`を使います。既存D1へ`db:bootstrap:production`を再実行しません。

production Workerの`Settings > Domains & Routes`でproduction API custom domainを接続し、HTTPSで有効になるまで待ちます。手順6で検証したWAF ruleをproductionにも有効にし、rule設定をrelease記録へ残します。Free planのようにpathだけのzone-wide ruleを使った場合は同じruleがすでにproduction pathにも及ぶため、重複作成せず有効状態を確認します。

### 検証済みcommitをmainへ反映する

stagingで確認したcommitだけを`main`へ反映します。次はfast-forwardできる場合の例です。

```powershell
git switch staging
git status --short
git push origin staging
git switch main
git pull --ff-only origin main
git merge --ff-only staging
$releaseSha = git rev-parse HEAD
$releaseNow = [DateTimeOffset]::UtcNow
$releaseUtc = $releaseNow.ToString("o")
$releaseJst = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId($releaseNow, "Tokyo Standard Time").ToString("o")
$releaseSha
$releaseJst
$releaseUtc
git status --short
git push origin main
```

`git status --short`が空であること、SHAと同一時点のJST/UTC時刻をrelease記録へ転記します。fast-forwardできない場合は`--force`や競合の自動解消をせず、GitHub Pull Requestで差分を確認してmergeします。Pull Requestを使った場合はmerge後に`main`を`git pull --ff-only`し、`git rev-parse HEAD`でSHAと検証時刻を取り直します。Pages dashboardでproduction build成功を待ち、表示されたcommit SHAが記録したSHAと完全一致すること、deployment IDと完了時刻を記録します。

### 新D1の公開直前bookmarkを取る

production migration・fixtureの適用後、まだ実利用の注文を受ける前の新D1についても復元地点を取ります。

```powershell
$newProductionDb = "reitaisai-order-production-v2"
$preOpenNow = [DateTimeOffset]::UtcNow
$preOpenUtc = $preOpenNow.ToString("o")
$preOpenJst = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId($preOpenNow, "Tokyo Standard Time").ToString("o")
$preOpenJst
$preOpenUtc
Push-Location api
npx wrangler d1 time-travel info $newProductionDb --timestamp $preOpenUtc --json
Pop-Location
```

返されたbookmarkを「新D1公開直前bookmark」として、取得UTC/JST時刻、migration一覧、user/menu件数と一緒にrelease記録へ保存します。旧D1 bookmarkとは別欄です。

### production Pages custom domainを接続する

1. Cloudflare dashboardで`Workers & Pages > <Pages project> > Custom domains`を開く。
2. `Set up a domain`からproduction Pages hostnameを追加する。
3. 旧Pages projectが同じhostnameを使っている場合は、手順8で受付停止・記録を完了してから旧側を外し、新側へ追加する。
4. statusが`Active`となり、certificateが発行されるまで待つ。
5. production URLを開き、ブラウザのoriginが予定どおりで、APIのCORS許可originと完全一致することを確認する。
6. Pages deploymentのcommit SHA、production Worker version、D1 nameをrelease記録と照合する。

Cloudflare Pagesでは成功済みproduction deploymentをdashboardからrollbackできます。production custom domainの設定とrollback方法は[Pages Custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/)と[Pages Rollbacks](https://developers.cloudflare.com/pages/configuration/rollbacks/)を参照してください。

URLを参加者へ知らせる前に管理者本人がログインし、role・menu・管理画面・監査ログを確認します。成功直後にproductionのbootstrap Secretを削除します。

```powershell
Push-Location api
npx wrangler secret delete BOOTSTRAP_ADMIN_DISCORD_USER_ID --env production --config wrangler.deploy.toml
Pop-Location
```

ダミー注文は作りません。運営が受付開始を宣言した後の最初の実注文を、memberの表示、managerの自グループ表示、合計、監査ログで照合し、その注文IDと時刻だけをrelease記録へ残します。

## 10. 公開後の注文運用

1. production URLの案内時刻と注文受付開始時刻を記録する。
2. 最初の15分は管理者とmanagerが待機し、最初の実注文を端末間で照合する。
3. 「送信できたか不明」の連絡が来た場合は再注文を促す前に管理画面で確認する。二重送信を手作業で増やさない。
4. 旧D1の注文を新D1へ自動移行したものと見なさない。旧側に残した注文は、旧DBの記録に基づき担当者が完了させる。
5. 障害時は受付停止時刻をDiscordで告知し、その時刻以後に操作した参加者を控える。復旧後に新D1の注文・監査ログと照合してから再受付する。
6. 旧D1、旧Worker、旧Pages projectはrelease責任者が保全解除を決めるまで削除しない。

## 11. rollback手順

rollback責任者を1人決め、次の順で実施します。画面・Workerだけの不具合でD1をrestoreしてはいけません。D1 restoreはbookmark以後の注文を失うため、注文データ破損時の最終手段です。

### まず書込みを止めて証拠を残す

1. Discordで注文受付停止を告知し、JST/UTC時刻を記録する。
2. Pages projectからproduction画面custom domainを一時的に外し、続けて`production Worker > Settings > Domains & Routes`からproduction API custom domain/routeを外す。project、Worker、D1、deployment、DNSの控えは削除しない。
3. 障害発生後の新D1 bookmarkを取り、可能ならSQL exportも`private-data`へ保存する。

```powershell
$newProductionDb = "reitaisai-order-production-v2"
$failureNow = [DateTimeOffset]::UtcNow
$failureUtc = $failureNow.ToString("o")
$failureJst = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId($failureNow, "Tokyo Standard Time").ToString("o")
$failureJst
$failureUtc
Push-Location api
npx wrangler d1 time-travel info $newProductionDb --timestamp $failureUtc --json
npx wrangler d1 export $newProductionDb --remote --output ..\private-data\new-production-before-rollback.sql
Pop-Location
```

### 症状ごとの戻し方

- **Pagesだけ壊れた:** Pages projectの`Deployments > All deployments`で、release記録に控えた直前の正常なproduction deploymentの`... > Rollback to this deployment`を選ぶ。preview deploymentはrollback先にできません。API/D1は戻しません。
- **Worker codeだけ壊れた:** production Workerの`Deployments`で、控えた直前の正常なversionを選び`Rollback`する。Worker rollbackは即時にそのversionをactiveにしますが、D1データは戻りません。rollback後の`DB` bindingが期待するD1を指すこととschema互換性を確認します。公式手順は[Workers Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)です。
- **新D1のデータが破損した:** 受付停止・障害後bookmark・export・責任者承認を完了してから、公開直前bookmarkへrestoreする。

```powershell
$newProductionDb = "reitaisai-order-production-v2"
$preOpenBookmark = "REPLACE_NEW_D1_PRE_OPEN_BOOKMARK"
Push-Location api
npx wrangler d1 time-travel restore $newProductionDb --bookmark $preOpenBookmark --json
Pop-Location
```

restore後はmigration・user/menu件数を確認し、失われる公開後注文をexportと運営記録から洗い出します。確認できるまでAPI domainを戻しません。

公開直前bookmarkが初回admin連携より前なら、restoreによってadminのDiscord連携も戻ります。パスワード管理アプリに保管した本人のDiscord User IDを`BOOTSTRAP_ADMIN_DISCORD_USER_ID`へ一時登録し、再接続後の最初のadminログイン成功直後に必ず削除します。

- **旧システム全体へ切り戻す:** 新システムで実注文が0件、または新規注文をexportして担当者が手作業で引き継ぐことを責任者が承認した場合だけ行う。別project構成なら、新Pages/Workerからproduction custom domainを外し、release記録の旧Pages projectと旧Workerへ同じdomain/routeを再接続する。旧Workerの`DB` bindingが旧D1 name/IDであること、変数とSecretが復元されていること、旧Pagesの`VITE_API_URL`が旧APIを指すことを目視する。同じproject構成なら、控えたPages deploymentとWorker versionへそれぞれrollbackする。旧D1自体はbookmarkへrestoreせず、切替時点の保全状態を使う。

どの経路でも、記録したbinding・deployment・件数を先に照合し、選択した対象へAPI custom domain、続いてPages custom domainを再接続します。直後にmemberログイン、managerの自グループ制限、注文を作らないsmoke testを行います。成功後に再受付時刻をDiscordで告知し、停止中の注文申告を1件ずつ照合します。

## 12. Gitで更新する日常手順

公開後の画面更新は次の流れです。

```powershell
git status
$checkedFile = "REPLACE_PATH_TO_CHECKED_FILE"
git add -- $checkedFile
git commit -m "変更内容"
git push origin staging
```

stagingで確認後に`main`へmergeしてpushするとproduction Pagesが自動更新されます。Worker/API変更はPagesとは別なので、対応する`npm run deploy:staging`または`npm run deploy:production`も必要です。

## 禁止事項

- `wrangler.deploy.toml`、`.dev.vars`、`production.local.sql`をGitへ追加しない。
- Client Secret、bootstrap ID、実参加者名、D1 bookmarkをチャットへ貼らない。
- 旧production D1へ`0001_initial.sql`を直接適用しない。
- staging確認前にproductionへdeployしない。
- Pagesの全preview URLをCORS wildcardで許可しない。
- 本番で`update_menu.sql`、`seed_food.sql`、`seed_drink.sql`、`update_login.sql`を実行しない。
