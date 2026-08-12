# Underwriting Glossary

英國 SME 信貸與 fintech 專有名詞的間隔複習系統。330 張卡，內容來源是 Notion，練習紀錄存在 Cloudflare KV，前端是一個沒有 build step 的 HTML 檔。

正式網址：`https://glossary-sync.quintice.workers.dev/`

---

## 這個專案在做什麼

三個角色，各自只做一件事：

- **Notion** 是內容的唯一真相。要新增、修改、刪除單字都在 Notion 做，不要改程式碼裡的資料。
- **Cloudflare Worker** 同時是 API、排程器和資料庫。它從 Notion 拉卡片、存你的練習狀態、每天把狀態鏡射回 Notion 給你看。
- **前端** 是一個單檔 HTML，跑排程演算法、畫卡片、收你的作答，定期把狀態推回 Worker。

```
┌─────────────┐   每日 cron / 手動同步    ┌──────────────┐
│   Notion    │ ─────────────────────────▶│  Worker KV   │
│  Glossary   │                           │              │
└─────────────┘                           │  cards       │
       ▲                                  │  state       │──▶ 前端 App
       │  每日回寫                          │  log:YYYY-MM-DD │◀── 每 8 次作答
┌──────┴──────┐                           └──────────────┘
│ Card State  │
│ Review Log  │  ← 給人看的鏡子，不是真相
└─────────────┘
```

為什麼練習狀態不直接寫回 Glossary：一寫就會動到 `Last edited time`，下次同步又把整批卡片抓回來。教材與行為紀錄分開，那個欄位才保得住意義。

---

## 檔案結構

```
glossary-worker/
├── worker.js          後端：API 路由 + cron + Notion 讀寫
├── wrangler.toml      綁定設定（KV、環境變數、cron、靜態資源）
├── public/
│   └── index.html     整個前端，資料與程式都內嵌在裡面
├── SETUP.md           第一次架設的步驟
└── README.md          你在看的這份
```

`index.html` 裡面有三塊：`<style>` 是全部 CSS，`<script>` 開頭的 `const BUILTIN = [...]` 是 330 張卡的種子資料，其餘是 App 邏輯。**種子資料只在第一次開啟、還沒同步過時使用**，同步之後就以 KV 為準，所以改單字請去 Notion。

---

## 資料模型

### 卡片（Notion Glossary → KV `cards`）

| 欄位 | Notion 屬性 | 說明 |
|---|---|---|
| `t` | term | 英文詞條，同時是主鍵 |
| `f` | full | 縮寫全名，沒有就空字串 |
| `p` | pos | 詞性，如 `n. phr.` |
| `c` | pattern | 搭配結構，如 `comply with sth` |
| `e` | example | 例句，克漏字就是從這裡挖空 |
| `z` | chinese | 中文 |
| `m` | meaning | 解釋 |
| `n` | note | 使用註記／陷阱註記 |
| `s` | section | 只取第一個字元 A–O |
| `x` | trap | Yes → 1 |

主鍵是 `term` 字串本身，沒有獨立 ID。**在 Notion 改 term 會被當成新卡**，舊的練習狀態會留在舊字串上。要改詞的話順手去 Card State 刪掉那一列。

### 練習狀態（KV `state`）

以小寫 term 為鍵：

```js
{
  "debenture": {
    st: 2,        // 階段 1 認詞 / 2 克漏字 / 3 打字
    b: 3,         // 該階段內的盒子
    due: 1755..., // 下次到期（epoch ms）
    seen: 11,     // 累計作答次數
    ok: 8,        // 累計 Approve 次數
    lapse: 2,     // 摔階次數
    t: 1755...    // 最後作答時間，跨裝置合併時比這個
  }
}
```

### 明細（KV `log:2026-08-12`）

陣列的陣列，刻意壓成位置參數省空間：

```
[term, 分鐘時戳, grade, mode, 反應時間/100ms, 作答前階段, 是否計分]
```

`grade` 是 0 Decline / 1 Refer / 2 Approve。`反應時間`除以 10 就是秒。這份是 append-only 的事實紀錄，狀態是從它推導出來的快取——想換演算法就拿這份重算。

---

## 排程演算法

三階梯，每階有自己的間隔表。全對走完一張卡需要 12 次正確作答、約 125 天。

| 階段 | 練習方式 | 盒子上限 | 間隔（天） |
|---|---|---|---|
| 1 | 認詞（英→中，翻卡自評） | 3 | 1 / 2 / 4 |
| 2 | 克漏字（例句挖空） | 4 | 1 / 3 / 7 / 14 |
| 3 | 打字（中→英，逐字比對） | 5 | 1 / 3 / 8 / 21 / 60 |

- **Approve** 盒子 +1，超過該階上限就升階、盒子歸 1
- **Refer** 盒子不動，重新計算到期日
- **Decline** 盒子歸 1；如果本來就在盒子 1 且不在第一階，退一階
- **熟練** 的定義是第 3 階盒子 ≥ 4。認詞階再高都不算

程式在 `worker.js` 之外，全部在 `index.html` 的 `applyGrade()` 與 `LADDER` / `TOP` 兩個常數裡。要調間隔改那兩個常數就好，不需要動其他地方。

第 4 種模式「陷阱辨義」（四選一）**不計入階梯**，只寫 log。因為四選一是辨認不是提取，做完會高估自己。它的用途是把容易混淆的詞放在一起逼你區辨。

克漏字挖不出空的卡（例句用的是變化形，約 16 張）會自動改用打字模式，寧可偏難。

---

## API

全部要帶 header `x-app-key`，除了 `/` 和 `/health`。

| 端點 | 用途 |
|---|---|
| `GET /` | App 本體（靜態資源） |
| `GET /health` | 設定檢查，不需要 key |
| `GET /cards` | 完整快照，cron 每天更新，秒回 |
| `GET /cards?since=ISO` | 只回 `Last edited time` 之後有異動的卡 |
| `GET /state` | 全部練習狀態 |
| `POST /state` | 上傳 `{state, log}`，以 `t` 較新者勝 |
| `GET /export.csv` | 狀態表 |
| `GET /log.csv?days=30` | 逐筆明細 |

```bash
curl -H "x-app-key: $APP_KEY" https://glossary-sync.quintice.workers.dev/export.csv
```

---

## 本地開發

```bash
npx wrangler dev
```

會起在 `http://localhost:8787`，前端與 API 都在上面。改 `public/index.html` 存檔後重新整理瀏覽器就看得到；改 `worker.js` 會自動重載。

預設用的是**本地模擬的 KV**，跟線上是分開的，所以本地怎麼亂測都不會弄髒正式資料。想接線上 KV 與真實 Notion 用：

```bash
npx wrangler dev --remote
```

secret 在本地不會自動帶入。要在本地測 Notion 相關功能，在專案根目錄建一個 `.dev.vars`（已在 `.gitignore` 裡）：

```
NOTION_TOKEN=ntn_xxxxx
APP_KEY=你的密碼
```

只改前端的話其實不必開 wrangler，直接用瀏覽器打開 `public/index.html` 也能跑，只是同步會因為跨網域被擋。

### 部署

```bash
npx wrangler deploy
```

檢查輸出有沒有 `Assets` 那一行、`Total Upload` 是不是 150 KiB 左右。要回到上一版：

```bash
npx wrangler versions list
npx wrangler rollback
```

---

## 常見維護

**新增單字** — 在 Notion Glossary 加一列，欄位填滿。下次同步就會進來。`section` 只有第一個字元有意義，`trap` 填 Yes/No。

**修改例句或註記** — 一樣在 Notion 改，`Last edited time` 會自動更新，同步時抓得到。

**調整間隔** — `index.html` 搜尋 `const LADDER`。

**加一種練習方式** — 需要動三個地方：`STAGES` 常數、一個 `renderXxx()` 函式、`render()` 裡的分派。模式代號會直接寫進 log 的第 4 欄。

**改 cron 時間** — `wrangler.toml` 的 `crons`，用的是 UTC。`0 23 * * *` 是台北早上 7 點。

**清掉練習紀錄重來** — App 進度分頁最下面有按鈕，只清本機。要連 KV 一起清：`npx wrangler kv key delete --binding GLOSSARY state`。

---

## 已知限制

- **KV 不是資料庫**。沒有查詢、沒有 index，只能整包 JSON 讀寫。要做「上個月哪些 §H 的字最常摔階」這種分析，得先 `GET /log.csv` 拉下來自己算，或改用 Cloudflare D1。
- **KV 是最終一致**。兩台裝置同時練同一張卡，以 `t` 較新的為準，中間那次會被蓋掉。一次只用一台就不會遇到。
- **回寫 Notion 一次最多 120 張**，剩下的隔天續傳。Notion API 限速 3 req/s，程式裡刻意每張間隔 340ms。
- **免費額度**：Workers 每天 10 萬次請求、KV 每天 10 萬次讀與 1000 次寫。目前設計每 8 次作答才寫一次，一天大概用掉 30 次寫入。
- **term 當主鍵**的後果如上，改詞等於換卡。
- 語音用瀏覽器內建的 `speechSynthesis`，各家聲音品質差很多，Safari 的 en-GB 比 Chrome 好。

---

## 疑難排解

| 症狀 | 原因 |
|---|---|
| `同步失敗：Failed to fetch` | 在 Claude artifact 裡開的，沙箱擋掉對外連線。改用 workers.dev 的網址 |
| `bad key` | header 沒帶或 APP_KEY 對不上。用 `/health` 確認 secret 有設 |
| 根目錄顯示「Worker 活著，但 App 還沒上傳」 | `[assets]` 沒設或 `public/index.html` 不存在 |
| 同步成功但卡片沒變 | Notion 那三個 database 忘了加 integration 到 Connections |
| Card State 一直是空的 | cron 一天只跑一次；想立刻看用 `/export.csv` |
