# Obsidian Plugin：GitHub Pages share

## Context

使用者想要一個 Obsidian plugin：設定好 GitHub repo 後，能把筆記發佈到該 repo，透過 GitHub Pages（內建 Jekyll）變成可分享的網頁連結，並且之後能更新已發佈的筆記。

已確認的需求：
- **轉換程度**：基本轉換後上傳 —— `[[wikilink]]` 轉標準 Markdown 連結、`![[圖片]]` 附件一併上傳並改寫路徑，其餘交給 Jekyll 渲染（callout 退化為 blockquote，可接受）
- **觸發方式**：指令面板、Ribbon 按鈕、檔案右鍵選單、已發佈筆記存檔自動更新（全部都要）
- **目標**：先自用，之後提交社群商店 → 從一開始就遵守 eslint-plugin-obsidianmd 規範與 submission 命名規則
- **前提**：repo 由使用者自行在 GitHub 建立（public），plugin 負責上傳/更新與補齊 Pages 所需設定檔

## 專案位置與識別

- 路徑：`/Users/markchang/mark/workshop/github-pages-share/`
- `manifest.json`：`id: "github-pages-share"`、`name: "GitHub Pages share"`、`description: "Publish notes to a GitHub Pages site and copy shareable links."`、`isDesktopOnly: false`（符合命名規則：無 "obsidian"、不以 "plugin" 結尾、描述以句點收尾）

## 檔案結構

```
github-pages-share/
├── manifest.json
├── versions.json
├── package.json            # obsidian、esbuild、typescript、eslint + eslint-plugin-obsidianmd
├── tsconfig.json
├── esbuild.config.mjs
├── eslint.config.mjs       # extends obsidianmd recommended（typescript-eslint recommendedTypeChecked）
├── styles.css              # 預期幾乎用不到，保留空檔
└── src/
    ├── main.ts             # Plugin class：commands、ribbon、file-menu、auto-update 事件
    ├── settings.ts         # 設定介面 + PluginSettingTab
    ├── github.ts           # GitHub Contents API client（requestUrl）
    ├── transform.ts        # Markdown 轉換：frontmatter、wikilink、嵌入圖片、slugify
    └── publisher.ts        # 發佈/更新流程編排 + 已發佈筆記 registry
```

## 設定（settings.ts）

- GitHub token（fine-grained PAT，`type="password"` 輸入框；說明文字提醒存於 data.json 為明文）
- Repo：`owner/name` 一欄
- Branch（預設 `main`）
- Repo 內目標資料夾（預設 `notes`）、附件資料夾（預設 `assets`）
- Pages base URL：預設自動推導 `https://{owner}.github.io/{repo}`，可覆寫（自訂網域）
- 存檔自動更新 toggle（預設開）
- 「Test connection」按鈕：GET repo 驗證 token/repo 有效
- UI 文字全部 sentence case、headings 用 `.setHeading()`

已發佈 registry（vault 路徑 → repo 路徑 + slug）與設定一起存在 `saveData()` 的資料中。

## GitHub client（github.ts）

全部走 `requestUrl()`（規則 24，桌機/手機通用）：
- `GET /repos/{owner}/{repo}/contents/{path}?ref={branch}` → 取得現有檔案 `sha`（404 = 新檔）
- `PUT /repos/{owner}/{repo}/contents/{path}` → base64 內容 + `sha`（更新時）= create or update 一條路
- `GET /repos/{owner}/{repo}` → Test connection / 取得 default branch
- `POST /repos/{owner}/{repo}/pages`（body: `{"source":{"branch":<branch>,"path":"/"}}`）→ 啟用 Pages；409/已啟用視為成功。`GET /repos/{owner}/{repo}/pages` 可取回實際 Pages URL
- 文字/二進位皆用 obsidian 的 `arrayBufferToBase64()` 編碼（不用 Node Buffer，保 mobile 相容）

### Repo 初始化（新增指令「Set up Pages repo」）

對使用者已建好的 repo 一鍵補齊 Pages 所需內容（全部冪等，重跑不壞）：
1. `GET /repos/...` 確認 repo 與 token 有效（private repo 警告：免費方案 Pages 需 public）
2. 建立 `_config.yml`（不存在才建）：`theme: jekyll-theme-primer` + `title: <repo 名>`
3. 建立 `index.md`（不存在才建）：含 front matter 的首頁，簡短說明 + 之後可手動維護目錄
4. 呼叫 Pages API 啟用 Pages（來源 = 設定的 branch 根目錄）；token 權限不足（403）時 Notice 引導使用者到 repo Settings → Pages 手動開，並說明 fine-grained PAT 需勾 Pages read/write
5. 完成後 Notice 顯示 Pages URL，並回填到設定的 base URL（若使用者未自訂）

發佈流程仍保留 fallback：publish 時若 `_config.yml` 不存在就自動補建，沒跑過 init 也能用。

## 轉換（transform.ts）

1. **Frontmatter**：Jekyll 只渲染有 YAML front matter 的檔案 → 確保輸出開頭有 `---\ntitle: <筆記名>\n---`；筆記原有 frontmatter 保留並補 `title`
2. **Wikilinks**：用 `metadataCache.getFirstLinkpathDest()` 解析
   - 目標筆記已在 registry（已發佈）→ 轉成相對標準連結 `[alias](target-slug.html)`
   - 未發佈 → 只留顯示文字（不產生死連結）
3. **嵌入圖片 `![[img.png]]` / `![](img.png)`**：解析出 TFile → `vault.readBinary()` 上傳到 `assets/`，改寫為 `![](../assets/img.png)` 相對路徑
4. **Slugify**：筆記名 → 小寫、空白轉 `-`、去除不合法字元；`normalizePath()` 處理路徑。不用 regex lookbehind（iOS 相容）

## 發佈流程（publisher.ts）

`publishNote(file: TFile)`：
1. `vault.cachedRead()` 讀內容（唯讀，不碰 Editor/modify）
2. transform → md 內容 + 附件清單
3. 逐一 GET sha → PUT 上傳（附件先、筆記後）
4. 更新 registry、`saveData()`
5. 組出分享連結 `{baseUrl}/{folder}/{slug}.html`，`navigator.clipboard.writeText()` 複製，`Notice` 顯示成功 + 連結
6. 錯誤（401/404/409）用 Notice 顯示可讀訊息

## 觸發點（main.ts）

- Commands：`publish-note`（發佈/更新目前筆記）、`copy-link`（複製已發佈連結）、`setup-repo`（Set up Pages repo，見上節）— 命名不含 "command"/plugin 名，無預設 hotkey
- Ribbon：`addRibbonIcon('upload-cloud', 'Publish current note', ...)`
- 右鍵選單：`registerEvent(workspace.on('file-menu', ...))`，僅對 md `TFile`（`instanceof` 檢查）顯示 Publish 項目
- 自動更新：`registerEvent(vault.on('modify', ...))` → 檔案在 registry 且 toggle 開啟 → per-file debounce（`activeWindow.setTimeout`，約 15 秒）後重新發佈；timer 存 Map，`onunload` 清除

## 建置與工具鏈

- 標準 obsidian 樣板：esbuild bundle 成 `main.js`（external: obsidian）、`npm run dev` watch / `npm run build` production
- ESLint flat config 掛 `eslint-plugin-obsidianmd` recommended，開發完成跑 `npx eslint .` 修到 0 error/warning

## 執行方式：Fable 調度，subagent 實作

主對話（Fable）不下場寫碼，只負責：寫派工 prompt（依 delegation-templates.md 模板）、收結論、驗收、升降級。每個派工 prompt 含三件套（目標動機／驗收條件／回報格式），回報只收 `檔案:行號` + 驗證結果，不收大段內容。

| 批次 | 內容 | subagent_type / model | 驗收（Fable 檢查） |
|------|------|----------------------|-------------------|
| A. 鷹架 | manifest.json、versions.json、package.json、tsconfig、esbuild.config.mjs、eslint.config.mjs、空 styles.css、`npm install` | `general-purpose` / `haiku`（樣板已定案；錯 1 次即升 sonnet） | read-back manifest 命名規則；`npm run build` 對空殼 main.ts 成功 |
| B. 核心實作 | src/ 五檔全部：settings、github client、transform、publisher、main 觸發點（依本 plan 規格） | `general-purpose` / `sonnet` | agent 需回報 `npm run build` + `npx eslint .` 結果；Fable 抽讀 github.ts 的 sha 處理與 main.ts 的事件註冊 |
| C. 對抗審查 | fresh-context 審查（模板 5）：對照 obsidian skill 規則清單逐條核對（requestUrl、registerEvent、instanceof、sentence case、no default hotkey、mobile 相容、activeWindow timer…），不告知「應該沒問題」 | `general-purpose` / `sonnet` | 發現清單逐項處置：修（派回 B 的 agent 或小修自己來）或標註不修理由 |
| D. 修正回合 | C 的 fail 項目批次修正 | `general-purpose` / `sonnet`（同一子任務連錯 2 次 → 帶軌跡升 `opus`） | 重跑 build + eslint 0 error/warning |

升降級依 dispatch.md §5：haiku 錯 1 次直升 sonnet；sonnet 同任務連錯 2 次帶完整失敗軌跡升 opus；總嘗試 ≤3 次，再失敗回報使用者。

## 驗證方式

1. `npm run build` 成功產出 `main.js`
2. `npx eslint .` 無 error/warning
3. 實測：把 `main.js`/`manifest.json` 複製（或 symlink）到測試 vault 的 `.obsidian/plugins/github-pages-share/`，請使用者提供 vault 路徑與測試 repo + PAT，然後：
   - 設定 token/repo → Test connection 通過
   - 執行「Set up Pages repo」→ repo 出現 `_config.yml`、`index.md`，Pages 已啟用（或 403 時 Notice 給出手動指引），設定回填 Pages URL；重跑一次確認冪等
   - 發佈一篇含 wikilink + 嵌入圖片的筆記 → repo 出現 `notes/*.md`、`assets/*`，剪貼簿有連結
   - 等 Pages build 完開連結確認渲染正常、圖片顯示
   - 修改筆記存檔 → 15 秒後自動更新；右鍵選單與 ribbon 各觸發一次
4. Token 錯誤/repo 不存在時 Notice 顯示清楚錯誤

## v1.1 修正回合（實機測試回饋，2026-07-13）

v1 四批次已完成並部署到 vault `/Users/markchang/mark/obsidian_note/MyWiki`。實測回饋兩項：

**問題診斷**（已用 public API 確認）：
- 404 根因：`has_pages: false` —— 使用者發佈了筆記但從未執行「Set up pages repo」，Pages 未啟用，整站 404。repo 只有 fallback 建的 `_config.yml` 與 `notes/`，無 `index.md`。非 plugin bug，是 UX 缺口：**plugin 在 Pages 未啟用時仍給出死連結且無任何警告**
- 成功提示太不明顯：Notice 幾秒就消失，使用者要更明顯的提示（已確認要 Modal 形式）

### 改動內容

1. **新增 `src/modal.ts`：PublishResultModal**（手動發佈成功後彈出；quiet 自動更新路徑不彈）
   - 顯示完整分享連結（可選取文字）
   - 按鈕：「Copy link」「Open in browser」（`window.open`）
   - 首次發佈提示：Pages build 需 1-2 分鐘才會生效
   - 遵守規範：sentence case、按鈕鍵盤可及、樣式進 styles.css 用 Obsidian CSS 變數、Modal 生命週期正確（onOpen/onClose 清空 contentEl）
2. **Pages 未啟用偵測**（publisher.ts）：手動發佈上傳成功後，若 settings 內 `pagesConfirmed` 旗標未立 → `getPagesInfo()` 查一次；回 null 時 Modal 內顯眼警告「Pages 尚未啟用，連結還不能用」＋一個「Set up pages repo now」按鈕直接觸發 setupRepo；查到已啟用則立旗標（之後不再多打這支 API）並用實際 Pages URL 校正 base URL
3. **setupRepo 成功後**也立 `pagesConfirmed` 旗標
4. copy-link 指令維持 Notice（不彈窗打斷）

### 執行方式（沿用調度模式）

| 批次 | 內容 | 執行者 | 驗收 |
|------|------|--------|------|
| E. v1.1 實作 | modal.ts + publisher/settings/main 接線 + styles.css | `general-purpose` / `sonnet`（可 SendMessage 回原實作 agent） | build + lint 0/0；Fable 抽讀 modal 生命週期與 pagesConfirmed 邏輯；重新部署到 vault |

### 驗證方式

1. build + lint 0/0，重新 cp 三檔到 vault plugin 資料夾
2. 使用者操作：Reload Obsidian → 執行「Set up pages repo」（這次真的跑）→ 重新 Publish 歡迎筆記 → 應彈 Modal 含連結與按鈕
3. Fable 從 GitHub 端驗證：`has_pages: true`、`index.md` 存在、等 build 後 curl 站點 200、中文檔名頁面可開（同時驗掉 v1 留下的實測項 #6 Jekyll 主題、#7 displayText）
4. 若 Pages 未開就發佈 → Modal 應出現警告與一鍵 setup 按鈕（可先不重測，程式碼審閱確認邏輯即可）

## v2 回合（0.2.0，2026-07-14）

沿用調度模式（Fable 派工 general-purpose/sonnet，逐批驗收）。四批次 F→G→H→I 全部完成：

| 批次 | 內容 | 主要改動 |
|------|------|---------|
| F | putFile 409 衝突強制覆蓋：重試迴圈最多 3 次，每次重抓 sha 再 PUT；可重試 = 409 或 422 且訊息含 "sha"；base64 編碼移到迴圈外；用盡照舊 throw | github.ts putFile |
| G | Callout 轉 HTML 嵌入 markdown（維持 .md + Jekyll 管線）：`transformCallouts`（行掃描+遞迴，支援 +/- 摺疊、巢狀、code fence 跳過，kramdown `markdown="1"`）；樣式 `assets/callouts.css`（create-only）；`ensureHeadCustom` 改內容比對式（marker `<!-- gps-callouts-v1 -->`，檔尾附加 `relative_url` 的 CSS link，保留既有 mermaid 內容）；github.ts 加 `getFileContent` | transform.ts、callouts.css.ts（新）、publisher.ts、github.ts |
| H | 資料夾批次發佈：file-menu 對 TFolder 顯示「Publish folder」；`publishFolder` 用 `getMarkdownFiles()` 過濾、逐檔 quiet publish、進度 Notice、逐檔錯誤不中斷、三種總結；`publishNote` 回傳型別改 `Promise<boolean>` | publisher.ts、main.ts |
| I | Unpublish：github.ts 加 `deleteFile`（404 冪等）；`PublishedNoteRecord.attachments?: string[]`（舊記錄相容）；`unpublishNote` 刪筆記 + 未被其他已發佈筆記引用的附件（`collectReferencedAttachments` 純函式）；`UnpublishConfirmModal` 確認框（`gps-danger-button`）；command `unpublish-note` + file-menu 項目（僅已發佈筆記）；`clearAutoUpdateTimer` 防 unpublish 後排程中的 auto-update 復活 | github.ts、settings.ts、publisher.ts、modal.ts、main.ts、styles.css |

審查修正（Fable 抽讀發現）：
1. callout CSS link 不可用絕對路徑 `/assets/callouts.css`（project pages 子路徑會 404）→ 改 Liquid `{{ '/assets/callouts.css' | relative_url }}`。
2. CSS 不可用 `[markdown="1"]` selector（kramdown 輸出會移除該屬性）→ 改 `.callout > *:first-child` / `*:last-child`。
3. UnpublishConfirmModal 的 Unpublish 按鈕原本先 `close()` 再 `onConfirm()`，close 同步觸發 onClose 會被 caller 判成取消 → 順序對調。

### 驗證

- 每批次 `npm run build` + `npx eslint .` 0 error/0 warning；版本 bump 0.2.0（manifest/versions/package）。
- 部署 vault（main.js/manifest.json/styles.css md5 一致）。
- transformCallouts 五案例實測：無 callout 冪等、note→blockquote、warning+→details open、巢狀、fence 內不轉。
- 實機項（使用者操作）：Reload Obsidian 後發佈含 callout 筆記看渲染；資料夾右鍵批次發佈；unpublish 含共用附件的筆記驗證只刪孤兒附件。

## 不做（範圍外）

- Plugin 端整頁轉完整 HTML（v2 已用「callout 轉 HTML 嵌入 markdown」方案取代）
- 自動建立 GitHub repo（使用者先在 GitHub 網站建好 repo；Pages 啟用與初始化由「Set up Pages repo」指令處理）
- 批次發佈時跳過未變更筆記（需逐檔 sha 比對，成本高；列為 v3 候選）
