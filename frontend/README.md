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
