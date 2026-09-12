# IGotThis 工單系統實作規則

- 本 repo 是 Module Impl git
- 產品為 IGotThis
- module id 為 `no1_issue_system`
- 本 repo 承載伺服器與 web 實作

## 多層配對

- Product git 承載上游決策
- Spec git 仲裁資料與邏輯
- Design git 仲裁視覺與互動
- 本 repo 跟進兩側定案
- 配對以 `product-scope` 的註冊表為準

---

## 實作邊界

- 根目錄管理 npm workspaces
- `packages/server/` 承載單體伺服器
- `packages/server/src/domain/` 保持純函式
- `packages/server/src/db/` 是資料庫邊界
- `packages/web/` 承載 React 前端
- `packages/web/src/theme/` 對齊 Design token
- 環境變數只由組裝邊界讀取
- 開發庫與測試庫不得共用

---

## 原生工作規則

- 任何改動先使用 `product-scope`
- 行為改動先核對 Spec
- UI 改動先核對 Design
- 功能與缺陷修正採測試先行
- Markdown 改動使用 `doc-markdown`
- 跨層 branch 名稱必須一致
- 配對 commit 的 subject 與 body 必須一致
- 完成前執行適用驗證
    - `npm test`
    - `npm run typecheck`
    - `npm run lint`
- 整合測試需要 `TEST_DATABASE_URL`
- 缺少測試資料庫時不得誤報全綠

---

## 相容與漂移控制

- `AGENTS.md` 是本目錄的規則真相
- `CLAUDE.md` 只保留 Claude Code 入口
- 產品規則不得複製回相容入口
- 漂移檢查確認相容入口只含導向規則
