[UploadingBRAWL ARENA オンライン化（初期版）
===================================

このセットは、既存の GitHub Pages フロントエンドに WebSocket マッチメイキングとプレイヤー位置共有を追加するものです。
既存の home.html / modes.html / index.html / characters.json はそのまま残してください。

含まれるもの
- online-config.js : デプロイした WebSocket サーバーURLの設定
- matchmaking.html : 実際のサーバーへ接続して待機し、試合IDを受け取る
- survival.html : 試合IDで再接続し、他の人間プレイヤーの位置を表示・共有
- server/ : Node.js + ws + MongoDB Atlas サーバー

重要な制限
この初期版でオンライン共有されるのはマッチメイキングとプレイヤーの位置・HP状態です。
現在のボットAI、弾の当たり判定、箱、毒エリア、勝敗は各端末側で動いており、全員で同じ試合状態を共有する完全なサーバー権威型バトルはまだ完成していません。
そのため、今の段階では「友達がオンラインで同じ部屋に入り、画面上に相手が表示されて動く」ことを最初の到達点にしています。攻撃・ダメージ・撃破・ボットAI・勝敗を完全同期するには次の実装が必要です。

A. サーバーをデプロイ
1. MongoDB Atlasで専用のDatabase Userを作成。強いパスワードを設定します。
2. Atlas Network Accessでデプロイ先サービスから接続できるように設定します。可能なら広い 0.0.0.0/0 許可は避け、サービス要件を確認してください。
3. `server` フォルダの中身をGitHubリポジトリのルートに置くか、サーバー用の別リポジトリにアップロードします。
4. RenderなどのNode.js Web Serviceとしてデプロイします。
   - Root Directory: `server`（serverフォルダごとリポジトリに置いた場合）
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Node: 20以上
5. 環境変数を設定します（値は公開しないでください）。
   - `MONGODB_URI` = Atlasの接続文字列。`brawl_arena` DBを使う
   - `DB_NAME` = `brawl_arena`
   - `ALLOWED_ORIGINS` = `https://kazu1haru4.github.io`
   - `ROOM_SIZE` = `10`
   - `MATCH_WAIT_MS` = `10000`
   - `PORT` はホストが自動設定するなら未設定でも可
6. デプロイ先の `https://<server-host>/health` を開き、`{"ok":true,...}` が返ることを確認します。

B. GitHub Pages側
1. `online-config.js` の `YOUR-WEBSOCKET-SERVER.example` を実際のホスト名に変更します。
   例: `window.BRAWL_ARENA_WS_URL = 'wss://brawl-arena-server.onrender.com';`
   ※実際に割り当てられたURLを使い、例のURLをそのまま使わないこと。
2. `online-config.js` と `matchmaking.html` と `survival.html` を既存リポジトリへアップロードしてコミットします。
3. 既存の `characters.json` は置き換えず、そのまま維持します。
4. `modes.html` の出撃ボタンが `matchmaking.html` を開く設定になっていることを確認します。

C. テスト
1. サイトを2台の端末で開き、別々にサバイバルへ出撃します。
2. 10秒以内に人数がそろわない場合、空き枠はサーバー側でボット枠として記録されます。
3. 試合画面で、相手のプレイヤーが青いキャラクターとして表示され、動きが共有されることを確認します。
4. サーバーの `/health` が正常か、RenderログにMongoDB接続エラーがないか確認します。

セキュリティ
- MongoDB接続文字列やDBパスワードをHTML、JavaScript、GitHubに絶対に書かないでください。
- クライアントが送るHP・位置は初期版では十分な不正対策がありません。ランキングや報酬の本番保存には使わないでください。
- `matches` コレクションに試合開始記録が保存されます。サーバーがMongoDBに接続できない場合、マッチメイキング自体は動いても記録保存は無効です。
 README_セットアップ.txt…]()
