# 秘密情報・個人情報の境界

この文書は値を記録せず、必要な設定名、保存先、取扱いだけを定義する。

## 現在の取扱い

- 原本に含まれていたVAPID鍵ペアは漏えい済みとして扱い、再利用しない。
- 新しいVAPID秘密鍵はCloudflare Workers Secretへ保存する。ローカル開発ではGit対象外の`api/.dev.vars`だけへ保存する。
- VAPID公開鍵は秘密ではないが環境固有である。APIでは環境バインディング、フロントエンドでは`VITE_VAPID_PUBLIC_KEY`から渡す。
- VAPID連絡先は個人アドレスではなく、可能なら役割用の連絡先を使う。
- API URLは公開設定だが環境固有である。`frontend/.env`は追跡せず、設定例だけを追跡する。
- D1のdatabase ID、Worker名、database名は環境別に管理し、実値入り`api/wrangler.toml`は追跡しない。
- OAuth client secretとセッション署名・暗号化用秘密値は、認証方式決定後にWorkers Secretとして追加する。Phase 0では方式も変数名も確定しない。

## 個人情報

- `update_login.sql`は実参加者情報を含む可能性があるため、追跡・共有・fixture利用を禁止する。
- 現在の`seed_users.sql`は安全な架空データである確認が取れていないため、追跡しない。
- `menu_list.txt`はリモートD1実行ログと環境識別値を含むため、追跡・共有しない。
- 参加者データが必要な場合は、完全な架空ユーザーだけを含む別fixtureをPhase 1で作成する。
- 氏名、外部サービス識別子、所属グループ、注文、Push endpoint・鍵をログや成果物へ出力しない。

## 設定例

- フロントエンド: `frontend/.env.example`
- APIローカル秘密値: `api/.dev.vars.example`
- Worker/D1構造: `api/wrangler.toml.example`

設定例へ本物の秘密値、参加者情報、本番の環境識別値を記入してコミットしてはならない。
