# IGotThis 工單系統實作

- 多產品開發團隊的 web 工單系統，開源自架免費，授權條款見 `LICENSE`
- 本 repo 為 Module Impl git，module_id 為 `no1_issue_system`
- 已完成地基層、引擎層、型別定義管理、流程轉換規則管理，應用層局部完成
- workflow_engine 的流程編輯（updateWorkflowDefinition）已有 domain／API／畫面三層：`WorkflowTransitionScreen` 管理狀態／轉換／結案原因，見待接事項的縮減範圍
- 行為規格的仲裁端為對側 Module Spec git，視覺標準的仲裁端為對側 Module Design git

---

## 起步

自架維護使用[安裝、升級、備份與還原指引](SELF_HOST.md)。交付建置請執行 `node scripts/self-host.mjs build`，此入口會連同 SQL migration 與版本資訊一起產生。

- 環境需求
    - Node 22 以上
    - npm 10 以上
    - PostgreSQL 17，本機安裝或容器擇一
- 安裝依賴，在 repo 根目錄執行一次即涵蓋兩個 workspace

    ```bash
    npm ci
    ```

- 準備環境變數，複製範本後填入實際值

    ```bash
    cp .env.example .env
    ```

    - `TEST_DATABASE_URL` 缺漏時整合測試靜默略過，不報錯，接手時最易漏
- 備妥資料庫，開發庫與測試庫各一，兩者不共用
    - 走本機安裝時自行建立角色與兩個資料庫，密碼須與 `.env` 一致

        ```bash
        psql -d postgres -c "CREATE ROLE igotthis LOGIN PASSWORD 'change_me_local_only' CREATEDB"
        createdb --owner igotthis igotthis_dev
        createdb --owner igotthis igotthis_test
        ```

    - 走容器時 compose 只建開發庫，測試庫另行補建

        ```bash
        docker compose up -d db
        docker compose exec db createdb --username igotthis igotthis_test
        ```

- 套用 migration，開發庫與測試庫各跑一次

    ```bash
    npm run migrate --workspace @igotthis/server
    npm run migrate:test --workspace @igotthis/server
    ```

    - 前向式執行，已套過的自動略過，可安全重跑
- 啟動開發伺服器，前端與後端同時起

    ```bash
    npm run dev
    ```

    - 前端 vite dev server 落 `8767`
    - 後端單體伺服器落 `8768`
    - 前端對 `/api` 的請求由 vite proxy 轉給後端
- 跑測試與靜態檢查

    ```bash
    npm test
    npm run typecheck
    npm run lint
    ```

---

## 技術棧決策摘要

- 執行環境走 Node 加 TypeScript
    - 前後端同語言，型別可跨層共用，減少介面漂移
- 型別嚴格度全開
    - `strict` 之外另開 `noUncheckedIndexedAccess` 與 `exactOptionalPropertyTypes`
    - 索引存取與選擇性屬性是工單系統動態欄位的高風險區，交給編譯器擋
- 資料庫走 PostgreSQL 17
    - 工單關聯為有向圖，無環判定與遞迴彙總需要 recursive CTE
    - 動態欄位值走 `jsonb`，交易保證由資料庫承擔
- 部署形態走單體伺服器
    - 前端建置產物由後端靜態託管，只有單一部署單元
    - 自用階段的規模不需要拆服務，拆分成本大於收益
- HTTP 層走 Fastify
    - TypeScript 型別支援原生，schema 驗證與序列化內建
    - 靜態託管以官方外掛掛載，無需另引 web server
- 前端走 React 加 Vite
    - 對側 Design git 的設計工件即 React 元件，可逐名對應搬入、不需跨框架翻譯
    - Vite 只出 `dist` 靜態產物，與單體部署形態相容
- 測試框架走 vitest
    - 與 Vite 共用 transform 管線，TypeScript 免額外編譯步驟
    - 啟動快、watch 迴圈短，撐得住全面 TDD 的紅綠節奏
- 認證走自帶帳密
    - 自用階段不引外部身分提供者，密碼只存雜湊
    - session 密鑰由環境變數注入

---

## 目錄導覽

```
.
├── package.json              npm workspaces 根，統管 script 與共用開發依賴
├── tsconfig.base.json        嚴格模式基準，兩個 workspace 各自 extends
├── tsconfig.json             根層設定檔本身的 typecheck 範圍
├── vitest.config.ts          全 workspace 共用測試設定
├── eslint.config.js          flat config，typescript-eslint 推薦組
├── docker-compose.yml        PostgreSQL 17 服務與資料 volume
├── .env.example              環境變數範本
└── packages
    ├── server                單體伺服器
    │   └── src
    │       ├── index.ts      進入點與組裝根，環境變數只在此讀取
    │       ├── api/          HTTP 邊界，路由、驗證、序列化、靜態託管
    │       ├── auth/         帳密認證，密碼雜湊與 session
    │       ├── db/           唯一碰資料庫的一層，連線池與 repository
    │       ├── permission/   有效權限計算
    │       └── domain/       core logic，純函式無 IO
    │           ├── shared/     跨 domain 共用：檢查結果、錯誤基底、日期與工作日曆
    │           ├── relation/   關聯完整性
    │           ├── rollup/     彙總計算與偏離標示
    │           ├── numbering/  工單集 KEY 與顯示編號
    │           └── view/       看板欄序與檢視排序
    └── web                   桌面瀏覽器前端
        └── src
            ├── main.tsx      掛載根
            ├── App.tsx       路由掛載
            ├── api/          後端 API 呼叫封裝
            ├── app/          應用外殼與路由定義
            ├── auth/         登入狀態與路由守衛
            ├── components/   共用元件庫
            ├── hooks/        共用 hook
            ├── screens/      各畫面
            └── theme/        design token，對齊 Pine Paper 標準
```

- 依賴方向單向由外向內
    - `api` 依賴 `domain` 與 `db`
    - `domain` 不依賴任何同層以外的模組
- `domain` 的硬性約束
    - 純函式，不碰資料庫、檔案系統、網路、時鐘、亂數
    - 當下時間與識別碼由呼叫端注入
    - 測試檔與被測檔同目錄，測試先行
- `domain` 層內的方向
    - 各 domain 依賴 `shared`，`shared` 不反向依賴任何 domain
    - domain 之間只取型別投影，不互相呼叫行為
    - 真的被兩個以上 domain 用到才進 `shared`，共用層不當雜物間
- 失敗的兩種表達
    - 預期內的檢查不通過回傳 `ValidationResult`，帶 `code` 與 `reason`
    - 呼叫端違反前置條件才擲錯，一律為 `DomainError` 子類、帶 `code`

---

## npm script

- `npm run dev` — 同時起前端與後端開發伺服器
- `npm run dev:server` — 只起後端，watch 模式
- `npm run dev:web` — 只起前端 vite dev server
- `npm run build` — 先建前端、再編譯後端，順序不可調換
- `npm run typecheck` — 根層設定檔與兩個 workspace 全掃
- `npm run lint` — eslint 全 repo
- `npm test` — vitest 單次執行
- `npm run test:watch` — vitest watch 模式
- `npm start --workspace @igotthis/server` — 以建置產物啟動後端

---

## 待接事項

本次候選已接上工單權限、彙總自動更新、詳情模式與工時、關聯與日曆維護，以及自訂欄位的清單顯示、排序、分組與欄位設定保存。四週真實使用驗收仍需實際工單與合併紀錄，不能由整合測試代替。官網公開上線不在本次範圍。

- **changelog_engine：**
    - 寫入與讀取的 repository、對外 API 皆已接上，workspace.ts 與 issues.ts 兩條欄位寫入路徑也都已接上
    - `rebuildFieldStateAt` 時點重建純函式已寫好，尚未掛進任何 API 或 repository，留給燃盡圖等自用深化波次需求時再補
- **workflow_engine：**
    - 狀態、轉換、結案原因的定義層 CRUD 已完成
    - `validateStatusTransition`／`changeIssueStatus` 五項檢查皆已寫好且接進 workspace.ts：轉換合法性、角色、必填欄位、終止結案原因、結案原因合法性
    - workspace.ts 的角色查詢已補真實資料，issues.ts 泛用欄位路徑已擋 status／resolution，不再能繞過轉換規則
    - 管理介面已補：`WorkflowTransitionScreen`（路由 `/workflow`）左欄選工單型別，右側狀態／轉換／結案原因三區塊，可建立帶 `requiredRole`／`requiredFields` 的轉換規則
    - 範圍縮減：狀態、轉換只做新增／移除，不做行內編輯表單（「編輯」走「先移除、再用新值新增」這條路徑）
    - 起始狀態（`isInitial`）已接進建工單邏輯：`POST /api/workspace/issues` 未帶 `status` 時查該型別實際的 `isInitial` 狀態落地，不再寫死 `DEFAULT_STATUS = '待處理'`（workspace.ts）；`DEFAULT_STATUS` 僅當資料異常查無起始狀態時的防禦回退
    - 已端到端驗證：補上本機 PostgreSQL 環境後跑滿整套整合測試（657 組），抓到並修掉三個先前被靜默略過測試掩蓋的真 bug——`replaceWorkflowStates`／`replaceWorkflowTransitions` 同交易內先刪 states 會撞外鍵（改 `workflow_transitions` 兩條 FK 為 `DEFERRABLE INITIALLY DEFERRED`，見 migration `003_defer_workflow_transition_fks.sql`）；`PUT /:id/workflow` 的 `states`／`resolutionOptions` 未依 wire schema 補上 `sortOrder`／`system` 就轉頭餵給 repo 層，導致整包替換必噴 500；Gantt 层級計算把「只有 Container 型別、無 Children 型別」誤判成「兩者皆缺」，第 1 層候選連帶交白卷
    - 結案原因排序依儲存順序呈現
        - `sortOrder` 從一開始
        - 新建型別維持已完成、不做的預設順序
        - 已部署的排序欄位遷移維持原樣
        - 後續遷移補齊既有位置並保留相對順序
        - 原位置相同時依選項值排序
        - 過去未儲存的自訂順序無法還原
- **view_layer：**
    - `resolveViewCalendar`／`computeIssueDuration`／`admitNewContainerIssue`／`applyViewFilter` 四個 domain 函式皆已接進 views.ts
    - 新單自動入表已完成，ListScreen 建單後自動 reload
    - 工期天數呈現已在 DevOrderScreen 完成，不是 ListScreen 缺口
    - 日曆選用已接：AddViewForm 有日曆選用 Select，留白跟隨帳號預設日曆
    - 清單篩選面板已接，可編輯條件並儲存至 `View.filterConfig`。套用成功後重載資料並更新條件標籤
    - 看板卡片依工單型別判斷終止狀態、提供結案原因與隱藏已結案卡片的到期日
    - 看板欄位仍取公司內全部工單型別的狀態聯集，尚未縮到檢視的資料來源範圍
    - DevOrderScreen 甘特圖座標轉換已完成，`devOrderGantt.ts` 有 23 組測試、已接進 views.ts 的 GET /:id/issues，三層級是後端真算的，非另開獨立主題
    - workspace.ts 種子已補 StartTime／EndTime（spec 標準欄位，帶 rollupable／earliest／latest），長條會依實際填值顯示；種子欄位本身不掛管理介面白名單，屬泛用欄位路徑可編輯
- **web_shell：**
    - 工單詳情頁已補（`IssueDetailScreen`）：欄位／關聯／異動歷史三區，List／Kanban／DevOrder 三處入口可導覽進入
    - 詳情頁依工單型別的欄位組配方顯示單值欄位，狀態與結案原因讀取同一型別的流程定義
    - 工單詳情頁的欄位編輯已對齊 design 定案：非唯讀欄位一律可編輯，不分值型別。白名單四欄位 title/assignee/point/due 走 workspace.ts PATCH，其餘含自訂欄位走 issues.ts 泛用路徑，兩條都已記變更歷史
    - 型別維護與定義區管理介面已補
        - `TypeDefinitionScreen` 掛載於 `/types`
        - 欄位組支援建立、列出與刪除
        - 欄位定義支援完整 CRUD
        - 工單型別支援建立與列出
        - 工單型別可編輯欄位組配方
        - `/types` 與 `/workflow` 皆有側邊選單入口
    - 登入頁已對齊 design 定案畫面（`LoginScreen` 逐名對齊 `no7_login_screen`）
    - 主題選擇已接持久化，存瀏覽器 localStorage，不跟帳號走，換裝置需重新選一次
