# GitHub Pages share

[English](README.md)

把 Obsidian 裡的 Markdown 筆記發佈到你自己的 GitHub repository，透過 GitHub Pages（Jekyll）變成可分享的網頁，並把分享連結複製到剪貼簿。

## 功能

- 一鍵發佈目前開啟的筆記，另外提供「Publish folder」指令，可整批發佈整個資料夾。
- 發佈成功後自動把可分享的連結複製到剪貼簿。
- 檔案總管的檔案與資料夾右鍵選單可直接發佈，工具列也有圖示按鈕。
- 自動把 Obsidian 的 wikilink 轉成相對連結；若連結目標尚未發佈，會降級為純文字，頁面上不會留下失效連結。
- 自動把內嵌圖片上傳到 repository 裡指定的 assets 資料夾，並改寫圖片引用指向新位置。
- 將 Obsidian callout 轉成樣式化 HTML 區塊呈現在發佈後的頁面上。
- 在發佈後的頁面上用 mermaid.js（由 CDN 載入）渲染 `mermaid` 程式碼區塊。
- 若筆記 frontmatter 缺少 `title`，會自動補上，讓發佈後的頁面有正確的標題。
- Auto-update：開啟此選項後，已發佈的筆記在你儲存修改後約 15 秒會自動重新發佈。
- 「Set up pages repo」指令可一鍵初始化全新的 repo：建立 Jekyll 設定檔、index 頁、mermaid 的 head include、callout 樣式表，並嘗試幫你啟用 GitHub Pages。
- 「Unpublish current note」會從 repo 刪除已發佈的檔案與僅被該筆記使用的圖片，並清掉本地紀錄，之後該筆記就不再被視為已發佈。
- 支援行動裝置（`isDesktopOnly: false`）。

## 安裝

### 社群外掛（審核中）

本外掛正在申請上架至 Obsidian 社群外掛目錄。上架完成後，請到 Settings -> Community plugins -> Browse 搜尋並啟用。

### 手動安裝

1. 從 Releases 頁面下載最新發行檔（`main.js`、`manifest.json`、`styles.css`）。
2. 在 vault 中建立資料夾 `<your-vault>/.obsidian/plugins/github-pages-share/`（若尚未存在）。
3. 把上述三個檔案複製到該資料夾。
4. 在 Obsidian 中開啟 Settings -> Community plugins，若有開啟 Safe mode 請先關閉，然後啟用「GitHub Pages share」。

## 快速開始

1. 建立一個新的 **public** GitHub repository 作為發佈目的地。repo 名稱會決定預設網站網址（`https://<owner>.github.io/<repo>`），請挑一個你願意公開在 URL 上的名稱。
2. 到 <https://github.com/settings/tokens?type=beta> 建立一組 fine-grained 個人存取權杖（PAT），至少需對目標 repo 授予 **Contents: Read and write**。若希望「Set up pages repo」能自動啟用 GitHub Pages，請再加授 **Pages: Read and write**；沒給此權限仍可使用，只是外掛會請你到 GitHub 的 repo 設定頁手動啟用 Pages。
3. 在 Obsidian 中開啟 Settings -> GitHub Pages share，依序填入：
   - Personal access token：貼上權杖。
   - Repository：`owner/name`。
   - Branch：通常填 `main`。
   - Notes folder、Assets folder、Pages base URL：保留預設值或依需求修改。
   - 點「Test connection」確認權杖與 repo 可用。
4. 執行「Set up pages repo」指令。它會建立 Jekyll 設定、index 頁、mermaid head include、callout 樣式表，並嘗試啟用 GitHub Pages。
5. 開啟任一 Markdown 筆記並執行「Publish current note」。分享網址會自動複製到剪貼簿並顯示在結果對話框。

## 設定

所有設定都在 GitHub Pages share 設定頁籤內。

- **Personal access token**：對目標 repo 有 Contents 讀寫權限的 fine-grained 權杖。以明文儲存在 vault 內的外掛資料檔（請見 Security & privacy）。
- **Repository**：目標 repository，格式為 `owner/name`。
- **Branch**：GitHub Pages 服務的分支。預設為 `main`，輸入空字串時會 fallback 為 `main`。
- **Notes folder**：repo 內用來存放已發佈筆記的資料夾。預設為 `notes`，會自動去掉頭尾斜線。
- **Assets folder**：repo 內用來存放上傳圖片的資料夾。預設為 `assets`，會自動去掉頭尾斜線。
- **Pages base URL**：分享網址的前綴。留空時使用 `https://<owner>.github.io/<repo>`，尾端斜線會自動去除。
- **Auto-update published notes**：開啟時，已發佈的筆記在你儲存修改後一小段時間會自動重新發佈。預設為開啟。
- **Test connection**：按鈕，會用目前的權杖與 repo 呼叫 GitHub API 並回報設定是否被接受。若 repo 是 private，提示訊息會提醒你免費版 GitHub Pages 無法服務它。

## Security & privacy

本外掛會代替你與 GitHub 互動，啟用前請先閱讀以下內容。

- **權杖儲存方式**：個人存取權杖以明文儲存在 `<vault>/.obsidian/plugins/github-pages-share/data.json`，與發佈紀錄寫在一起。任何人只要能讀到那個檔案，就能讀到你的權杖。請勿把該檔案同步或分享給你不敢直接交付權杖的人或系統。若懷疑權杖外洩，請立刻到 GitHub 撤銷並重新建立一組。
- **連線端點**：本外掛只連線到 `api.github.com`（Contents、Repository、Pages 等端點）。在 Obsidian 端不會連線到任何其他第三方主機。
- **發佈頁面上的第三方腳本**：發佈後的網頁會在訪客的瀏覽器中從 `https://cdn.jsdelivr.net` 載入 `mermaid`。Obsidian 端的外掛本身不會載入任何遠端腳本，但任何造訪你發佈筆記的人，其瀏覽器會把 IP 與請求資訊送給 jsDelivr。若你不想讓某篇筆記觸發遠端腳本載入，請避免在裡面使用 `mermaid` 程式碼區塊。
- **Auto-update 就是直接公開發佈**：當「Auto-update published notes」開啟時，每儲存一次已發佈的筆記，約 15 秒後就會自動重新發佈。沒有預覽步驟。請勿對仍在草稿階段的筆記開啟 Auto-update，否則未完成的編輯會直接上線。
- **免費 GitHub Pages 需要 public repo**：免費版 GitHub Pages 僅服務 public repository，而 public repository 對全世界可讀。你透過本外掛發佈的每一篇筆記與圖片，任何知道或猜到網址的人都看得到。請勿發佈含有密鑰、個人資料，或任何你不願公開的內容。

## 運作方式

發佈一篇筆記時，外掛會：

1. 從 vault 讀取筆記內容，進行 Markdown 轉換：把 wikilink 改寫成相對連結、解析並上傳內嵌圖片到 assets 資料夾、把 Obsidian callout 轉成樣式化 HTML、若 frontmatter 沒有 `title` 則補上。
2. 透過 GitHub Contents API 把筆記（與所有圖片）上傳到設定中的 repo 與分支。
3. 若 repo 尚未初始化，會以等冪方式（idempotent）建立 `_config.yml`（Jekyll theme `jekyll-theme-primer`）、`index.md`、`_includes/head-custom.html`（mermaid 啟動腳本與 callout 樣式表 link）以及 `assets/callouts.css`。這些路徑下若已有檔案則不會覆寫。
4. 把筆記的 repo 路徑、slug 與上傳的 assets 記錄到外掛的本地 registry，方便之後的發佈更新同一個檔案，並讓「Copy published link」能重新組合分享網址。
5. 組合分享網址 `<pages-base-url>/<notes-folder>/<slug>.html` 並複製到剪貼簿。

「Set up pages repo」會執行步驟 3 並嘗試透過 API 啟用 GitHub Pages。若權杖缺少 Pages 寫入權限，外掛會顯示提示，請你到 GitHub 上手動啟用 Pages。

## License

MIT.
