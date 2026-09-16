# cc2-suggest-api

Cold Clear 2 (wasm) を使って着手候補を返す Cloudflare Worker API。

## 今回加えた修正

1. **`wrangler.toml` / `package.json` を追加**（元のzipには無く、このままではデプロイ不可でした）
2. **`src/cc2-glue.js`: メッセージ蓄積によるメモリリークを修正**
   `__emit()` が全種類のメッセージを `cc2Messages` に貯め続け、`suggestion` 以外
   （`__worker_ready` など）が無限に残っていました。isolateが長生きするほど
   メモリを圧迫するため、保持する種別を `suggestion` のみに限定しました。
3. **`src/index.js`: リクエストバリデーションを強化**
   - `board` の各行が10列であることをチェック
   - `board` のセルが `null` または `I/O/T/L/J/S/Z` のいずれかであることをチェック
   - `queue` の要素が有効なミノ種別であることをチェック

## デプロイ手順

```bash
npm install
wrangler secret put CC_API_TOKEN   # 任意。設定すると認証必須になる
npm run deploy
```

## 既知の注意点（今回は未修正・要検討）

- **`new Function(...)` の使用**: `cc2-glue.js` 内の `__wbg_newnoargs_...` は
  wasm-bindgen が生成する定型コードで、内部で `new Function(...)` を呼びます。
  Cloudflare Workers は動的コード生成 (`eval` / `new Function`) を実行時に
  ブロックすることがあります。今回のエンジン利用方法（`log` という素の
  グローバル関数をコールバックに使うだけ）ではこのパスは通らない想定ですが、
  wasm 側の実装が変わって汎用クロージャ呼び出しが増えた場合はランタイム
  エラーになるリスクが残ります。気になる場合は wasm-bindgen のターゲットを
  `--target no-modules` 以外（例: `--target web` や `bundler` 向けの出力）で
  再生成し、この呼び出しパスが生成されないか確認してください。
- **固定スリープによるポーリング**: `runSuggest()` は `sleep(40)` の後に
  `suggest` を送り、20msごとにポーリングして結果を待ちます。動作はしますが、
  wasm側からの完了通知をイベントベースで待つ実装（Promiseをresolveする形）
  の方が、環境差によるタイムアウトの取りこぼしに強くなります。
- **シングルトンエンジンの永続性**: `service` / `chain` / `cc2Messages` は
  モジュールスコープの変数としてisolateの生存期間だけ再利用されます。
  Cloudflareはisolateをいつでも破棄・再生成できるため、常にウォームである
  ことを前提にはできません。現状 `isReady()` チェックと再待機で最低限
  フォールバックしていますが、一度 `ready` が失敗した場合の再初期化パスは
  用意されていません。
