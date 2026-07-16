# Frontend

React + Viteで作られた例大祭打ち上げ注文画面です。

```powershell
npm ci
npm test
npm run lint
npm run build
```

ローカルAPIは`.env.local`へ次を設定します。

```text
VITE_API_URL=http://127.0.0.1:8787
```

`VITE_`値は生成JavaScriptから閲覧できるため、秘密値を入れません。Cloudflare Pages設定は[rootの公開手順](../docs/DEPLOYMENT.md)を参照してください。

## PWA更新

旧productionは自動生成された`/registerSW.js`をprecacheしていました。`legacyServiceWorkerMigration.js`はこの旧版だけを検出し、Service Workerが途中で停止しても移行状態を引き継いで新画面へ一度だけ再読込します。通常のPWA更新は従来どおり利用者の確認後に行います。

休眠中の旧端末も移行対象になるため、この互換処理と`public/_headers`の`/sw.js`再検証設定は、旧productionの保全解除を決めるまで削除しません。
