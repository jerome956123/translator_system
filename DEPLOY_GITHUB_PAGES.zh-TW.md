# 手機版即時翻譯：GitHub Pages 上傳指南

這次改成純前端版本。**請使用同一層的 `realtime.html`，不要再依早期說明安裝後端或填寫 `.env`。**

## 已經有 GitHub Pages

1. 將 `realtime.html` 上傳到 Pages 的發佈資料夾，與現有首頁放在一起。
2. 等待 Pages 更新。
3. 在目前網站網址後面加上 `realtime.html` 開啟。例如 `https://帳號.github.io/專案名稱/realtime.html`。
4. 在手機 Safari／Chrome 中輸入自己的 Gemini API Key，按開始並允許麥克風。

這個檔案包含所需程式與樣式，不需同時上傳 `realtime-text`、`node_modules` 或 `.env`。原本首頁可以繼續使用。

## 新建一個網站

把 `realtime.html` 的副本改名為 `index.html`，上傳到新 repository 的發佈資料夾。到 **Settings → Pages → Deploy from a branch** 選擇該分支／資料夾，完成後使用顯示的 HTTPS 網址。

## 從原始碼建置部署

已附 `.github/workflows/realtime-pages.yml`。上傳整個專案後，在 Pages 選 **GitHub Actions**，再到 Actions 選 **Deploy realtime subtitles to GitHub Pages → Run workflow**。不需要填 Gemini secret；使用者在發佈後的頁面自行輸入 Key。這個方式會將新版作為 Pages 首頁。

## 使用時

手機不需安裝 Node.js，筆電也不必一直開著。請保持頁面在前景；切到背景會自動停止收音。重新整理會清除 Key 與字幕，需要留存請先下載 TXT。

目前提供的是已建置成品與部署方法，尚未替你登入 GitHub 或發佈公開網址。辨識與翻譯的模型權限、延遲及手機麥克風效果，需在你的裝置與 API 帳號實測。

完整說明見 [realtime-text/README.zh-TW.md](realtime-text/README.zh-TW.md)。
