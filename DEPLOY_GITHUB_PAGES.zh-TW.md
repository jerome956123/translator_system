# 手機版即時翻譯：GitHub Pages 上傳指南

這次改成純前端版本。**請上傳這個資料夾最外層的 `index.html`，取代 GitHub 上的同名首頁。** 不需安裝後端或填寫 `.env`。

## 已經有 GitHub Pages

1. 開啟 GitHub repository，進入原本存放 `index.html` 的發佈資料夾。
2. 選 **Add file → Upload files**，拖入這次修改後、資料夾最外層的 `index.html`，按 **Commit changes** 儲存。
3. 等待 Pages 更新，用原本的 HTTPS 網站首頁網址開啟。頁尾應顯示「版本 2.3」，沒有就重新整理。
4. 在手機 Safari／Chrome 中貼上 Gemini API Key，按開始並允許麥克風。下次使用同一個瀏覽器會自動帶入。

這個檔案包含所需程式與樣式，不需同時上傳 `realtime-text`、`node_modules` 或 `.env`。注意：`realtime-text` 裡面的 `index.html` 是原始碼入口，請上傳最外層的成品。

## 新建一個網站

把最外層的 `index.html` 上傳到新 repository 的發佈資料夾。到 **Settings → Pages → Deploy from a branch** 選擇該分支／資料夾，完成後使用顯示的 HTTPS 網址。

## 從原始碼建置部署

已附 `.github/workflows/realtime-pages.yml`。上傳整個專案後，在 Pages 選 **GitHub Actions**，再到 Actions 選 **Deploy realtime subtitles to GitHub Pages → Run workflow**。不需要填 Gemini secret；使用者在發佈後的頁面自行輸入 Key。這個方式會將新版作為 Pages 首頁。

## 使用時

手機不需安裝 Node.js，筆電也不必一直開著。請保持頁面在前景；切到背景會自動停止收音。API Key 會保存在同一個瀏覽器，按「清除」可刪掉。重新整理會清除字幕，需要留存請先下載 TXT。

語音由 Gemini AI 直接聽寫，沒有使用手機或電腦內建辨識；可填「辨識提示」協助人名與專有名詞。字幕採連續段落，短停頓會接續更新，較淡的內容仍是會修正的草稿。

版本 2.3 提供中文 ↔ 日文、中文 ↔ 英文、日文 ↔ 英文雙向配對。選定後兩種語言可以直接輪流說，不必停止切方向。每句字幕保留自己的翻譯方向，原本的繁體中文、上下文校正與紀錄保留都持續使用。

費用及預算改為台幣。預設換算 US$1 ≈ NT$32.58，屬於參考值；可在「調整台幣換算匯率」修改並記住。實際台幣扣款以帳單為準。已記住金鑰時仍只顯示一條小列，需要修改時按「更改金鑰」。

目前提供的是已建置成品與部署方法，尚未替你登入 GitHub 或發佈公開網址。辨識與翻譯的模型權限、延遲及手機麥克風效果，需在你的裝置與 API 帳號實測。

完整說明見 [realtime-text/README.zh-TW.md](realtime-text/README.zh-TW.md)。
