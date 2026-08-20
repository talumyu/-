# 注音急轉彎 v3｜AI 動態出題版

這個版本保留 v2 的固定題庫、計分、倒數、提示、上一題/下一題、亂序與勝利畫面，新增「AI 動態出題」。

## AI 動態出題流程

1. 使用者輸入主題。
2. 前端 POST 到 `/api/generate-topic`。
3. 後端使用 OpenAI Responses API + `web_search` 搜尋主題詞彙。
4. 模型以 Structured Outputs 回傳固定 JSON 結構。
5. 後端再次程式驗證：中文字數、完整注音、每字首注音、提示洩漏、重複詞、主題相關度與難度。
6. 不足題數時最多補搜一輪。
7. 合格題目回傳前端，自動存入瀏覽器 localStorage 並立即可玩。

## 為什麼不能直接雙擊 index.html 使用 AI？

固定題庫可以直接雙擊使用，但 AI 功能需要一個後端，因為 `OPENAI_API_KEY` 不能放在瀏覽器 HTML 裡。部署後，瀏覽器只呼叫你自己的 `/api/generate-topic`，真正的 Key 只存在 Vercel 的伺服器環境變數。

---

# 最簡單部署方式：GitHub + Vercel

## A. 先準備 OpenAI API

1. 前往 OpenAI API Platform。
2. 建立一個 API Project（建議專門給這個遊戲用）。
3. 在該 Project 建立 API Key。
4. 設定 Billing / 儲值或付款方式。
5. 建議設定 Usage / Spend limit 或警示，避免超出預算。
6. 複製 Key 後妥善保存；不要貼到 `index.html`、GitHub、LINE 群或公開文件。

## B. 建立 GitHub repository

1. 登入 GitHub，新增 repository，例如 `zhuyin-rush-ai`。
2. 可設 Private；若設 Public 也沒關係，但「絕對不能」把真正 API Key 放進檔案。
3. 把這個資料夾內檔案全部上傳：
   - `index.html`
   - `api/generate-topic.js`
   - `package.json`
   - `vercel.json`
   - `.gitignore`
   - `.env.example`
4. 不要上傳 `.env` 或 `.env.local`。

## C. 在 Vercel 部署

1. 登入 Vercel。
2. New Project → Import 剛才的 GitHub repository。
3. Framework Preset 可維持 Other / 自動偵測。
4. 在 Environment Variables 加入：
   - Name: `OPENAI_API_KEY`
   - Value: 你的真正 OpenAI API Key
5. 強烈建議再加入：
   - Name: `APP_ACCESS_CODE`
   - Value: 你自己設定的一組活動密碼，例如一串不容易猜的文字。
6. `OPENAI_MODEL` 可不填；程式預設 `gpt-5.6`。
7. Deploy。
8. 部署完成後會拿到 `https://xxxxx.vercel.app` 網址。

## D. 第一次實測

1. 打開 Vercel 網址。
2. 固定題庫先按「開始正式競賽」，確認 v2 功能正常。
3. 回第一頁，在 AI 動態出題輸入「棒球」。
4. 難度選「標準」、範圍選「智慧延伸」。
5. 如果你有設定 `APP_ACCESS_CODE`，展開「進階」輸入同一組密碼。
6. 按「搜尋並建立題庫」。
7. 成功後會自動新增一張 `AI｜棒球` 題庫卡片並被選取。
8. 按「開始正式競賽」。

---

# 本機開發測試（選用）

如果你會使用 Terminal：

```bash
npm install
cp .env.example .env.local
```

打開 `.env.local`，把 `OPENAI_API_KEY` 改成真正 Key，再執行：

```bash
npm run dev
```

Vercel CLI 會顯示本機網址，通常是 `http://localhost:3000`。

> 不要用 `file:///.../index.html` 測 AI，因為那沒有 `/api/generate-topic` 後端。

---

# 使用上的重要差異

- **固定題庫**：完全沿用 v2。選定主題題數不足時，仍會從其他固定/已儲存題庫補題，補完後整池亂序。
- **AI 題庫**：不跨其他題庫補題。若 AI 最後只建立 8 題，而你原本設定 10 題，就以 8 題開始，避免主題被稀釋。
- **AI 題庫會保存在目前瀏覽器**：使用 localStorage。換電腦、換瀏覽器或清除網站資料後不會自動跟著走。
- AI 題庫卡片右上角垃圾桶可刪除。
- OpenAI / 網路失敗時，固定題庫仍可照常玩。

# 成本與安全建議

AI 動態出題每次至少會使用模型並進行網路搜尋；若第一批合格題目不足，最多再補搜一次，因此每次建立題庫都會產生 API 用量。建議：

1. 使用專屬 API Project。
2. 設定 Usage/Spend limit 或警示。
3. 部署公開網址時設定 `APP_ACCESS_CODE`。
4. 好用的題庫生成一次後就直接重複使用 localStorage 版本，不必每一場重新生成。
5. 若懷疑 Key 外洩，立刻在 API Platform 刪除/輪替 Key，並更新 Vercel Environment Variable。

# 常見錯誤

### 顯示「伺服器尚未設定 OPENAI_API_KEY」
Vercel Environment Variables 沒設好；設定後要重新 Deploy。

### 顯示「連線密碼不正確」
Vercel 有 `APP_ACCESS_CODE`，前端進階欄位必須輸入相同值。

### 顯示 API 額度/付款不足
到 OpenAI API Platform 檢查 Billing / Usage。ChatGPT Plus 與 API 使用額度是不同系統。

### 嚴格主題模式常常題數不夠
這是正常的。三個答案都必須同時符合「主題相關 + 相同注音開頭」條件，本來就可能找不到。改成「智慧延伸」會比較適合團康。

### 為什麼 AI 產生的題目還是可能偶爾有語音爭議？
程式可以驗證 AI 回傳的「完整注音」與「題目首注音」彼此一致，但目前沒有再連接教育部字典做第三方逐詞校音。因此正式大型活動前，第一次生成新主題後仍建議主持人快速看過幾題；若之後要做 v3.1，可再加入「題庫預覽、刪除此題、AI 補一題」的人工把關介面。
