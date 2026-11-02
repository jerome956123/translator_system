# 語音翻譯：GitHub Pages 更新方式

請使用最外層已打包的index.html，取代GitHub上的同名首頁。手機使用不需要Node.js、後端或.env。

1. 已使用GitHub Desktop：提交本次修改並Push origin，等待Pages更新。
2. 網頁上傳方式：在GitHub原本發佈資料夾選Add file → Upload files，拖入根目錄index.html並提交。
3. 用原本HTTPS首頁開啟，確認頁尾「版本 2.8.0」。若仍是舊版，重新整理，電腦可按Ctrl + F5。
4. 貼上自己的API Key，選「精準原音翻譯」或「空白鍵 · 按住說話」。模式與金鑰會在這個瀏覽器記住。

精準模式約12–20秒優先在停頓處分段，加3秒後文再翻譯；下一段連同完整前段原音校對，直接更新舊譯文，重聽用量也計費。空白鍵模式先開始待命，再按住說話，按住時邊說邊顯示文字。兩種模式各自獨立，不同時執行。語言與模式切換後保留紀錄和累計費用，重新整理前請先下載。

Pages若從main根目錄發佈，就更新根目錄；若從/docs發佈，請把成品放入docs。第一次啟用Pages可在Settings → Pages → Deploy from a branch選對分支和資料夾，並使用HTTPS。

原始碼部署也可用附帶的.github/workflows/realtime-pages.yml：Pages來源選GitHub Actions，再手動執行Deploy realtime subtitles to GitHub Pages。工作流程會測試並建置dist，不需要Gemini secret。

不要上傳.env、真正API Key、node_modules或.pnpm-store。不要把自己的Key寫進HTML。此次只更新本機檔案，沒有代為推送或公開發佈。
