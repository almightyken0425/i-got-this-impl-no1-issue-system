# 自架安裝與維護

本文件交付單一 Node 伺服器與 PostgreSQL 資料庫的安裝、升級、備份及還原流程。伺服器同時提供 API 與 web 建置檔。所有命令從實作 repository 根目錄執行。

目前為本機候選，尚未完成產品路線圖的四週自用驗收，也尚未發布正式版本。下列維護流程可供候選驗證。

## 環境與版本

- Node.js 22 以上與 npm 10 以上。
- PostgreSQL 17。`psql`、`createdb`、`pg_dump`、`pg_restore` 必須可執行。
- 以專用資料庫與專用登入角色執行應用，測試另用不同資料庫。
- 正式環境透過 HTTPS 反向代理連入應用。應用預設只監聽本機位址。
- 保存完整來源、lockfile、`.env` 與建置版本資訊。每次升級使用獨立目錄，保留上一版目錄。

`node scripts/self-host.mjs build` 產生前後端建置檔、SQL migration 及 `packages/server/dist/release.json`。版本資訊包含來源雜湊、基底 commit 與每個 migration 的校驗碼。未指定 `RELEASE_VERSION` 時使用候選雜湊，不會把未提交修改當成正式 release。

不要只複製 server 的 JavaScript。部署目錄需要 server dist、web dist、npm 相依套件、維護腳本與根 `.env`，並保留原本相對位置。

## 全新安裝

先取得選定版本的完整來源，在獨立安裝目錄執行。

```bash
npm ci
cp .env.example .env
```

以資料庫管理者建立專用角色。使用互動提示設定密碼，接著建立空資料庫。

```bash
createuser --pwprompt igotthis
createdb --owner=igotthis igotthis
```

編輯根 `.env`。

| 設定 | 用途 |
| --- | --- |
| `DATABASE_URL` | 專用應用資料庫的連線字串。不要指向測試庫。 |
| `SESSION_SECRET` | 隨機密鑰。升級時保留同一份。 |
| `NODE_ENV` | 正式服務設為 `production`，session cookie 只透過 HTTPS 傳送。 |
| `HOST` | 使用同機反向代理時維持 `127.0.0.1`。 |
| `PORT` | 應用監聽埠，與反向代理的上游設定一致。 |

產生密鑰後填入 `.env`，限制該檔只有服務使用者可讀。

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
chmod 600 .env
node scripts/self-host.mjs build
node scripts/self-host.mjs install
node scripts/self-host.mjs verify
npm start --workspace @igotthis/server
```

`install` 只接受空資料庫。已有資料時使用升級流程。`verify` 核對建置內的 migration 校驗碼、資料庫版本並讀取工單數。

由 HTTPS 網址開啟應用。第一個註冊帳號成為管理者，後續帳號須由管理者授予適用權限。建立工單、修改狀態，再重新登入，確認資料仍可讀取。程序監督服務的工作目錄設為安裝根目錄，啟動命令沿用上方 `npm start`。

`/api/health` 只表示 HTTP 程序存活。資料庫版本與連線另用 `verify` 核對。

## 備份

先建立只有維護者可讀的備份目錄，再指定尚不存在的檔名。

```bash
mkdir -m 700 backups
node scripts/self-host.mjs backup backups/before-maintenance.dump
```

成功後會有兩個檔案，必須成對保存。

- `.dump` 保存資料庫 schema 與資料。
- `.dump.json` 保存 SHA-256 校驗碼、migration 清單及產生時間。

備份採 PostgreSQL custom archive。此格式由 `pg_restore` 還原，單一資料庫備份不包含叢集角色。[PostgreSQL 備份文件](https://www.postgresql.org/docs/17/app-pgdump.html)

`.env`、服務設定、HTTPS 設定與上一版程式碼另行備份。它們不在資料庫 dump 內。不要將含憑證的檔案加入 repository。

同名檔案不會被覆寫。中斷後可能留下不完整 dump，缺少 metadata 或校驗失敗的檔案不可還原。改用新檔名重新備份。

## 升級

先在新目錄準備指定版本並建置。複製原 `.env`，保持資料庫與 session 密鑰一致。停止舊應用，期間不要再寫入資料。

```bash
npm ci
node scripts/self-host.mjs build
node scripts/self-host.mjs upgrade backups/before-upgrade.dump
node scripts/self-host.mjs verify
npm start --workspace @igotthis/server
```

備份目錄須先建立。`upgrade` 先完成備份與校驗，再套用尚未執行的 migration。備份失敗時不改資料庫。已套用 migration 會略過，資料庫比交付版本新或 migration 缺號時拒絕執行。

每個 migration 在獨立交易內執行。升級失敗時保留備份與原程式碼，不直接啟動不相容的舊版程式。修復後續跑，或依下節還原到新的空資料庫。

本次升級保留既有 `point` 資料並啟用加總，補上工時定義與彙總來源權限索引。歷史來源索引由升級時仍存在的關聯回填。更早版本已刪除且未記錄來源的歷史無法逆推。

啟動後核對原帳號可登入、既有工單編號與欄位可讀、流程仍可轉換、異動歷史仍存在，再讓使用者恢復操作。

## 獨立還原與回退

由資料庫管理者先建立新的空資料庫。使用原角色或另一個專用角色作為 owner。

```bash
createdb --owner=igotthis igotthis_restore
```

在選定版本的安裝目錄，將 `.env` 的 `DATABASE_URL` 改指向新資料庫，再執行。

```bash
node scripts/self-host.mjs restore backups/before-maintenance.dump
node scripts/self-host.mjs verify
npm start --workspace @igotthis/server
```

`restore` 先核對備份校驗碼，再確認目標庫為空。還原在單一交易內執行，錯誤時回滾，不使用會刪除既有資料的 `--clean`。[PostgreSQL 還原文件](https://www.postgresql.org/docs/17/app-pgrestore.html)

還原不自動升級。回退時使用備份對應的程式版本與環境設定。若目的是在新版讀取舊備份，還原後再執行新版的 `upgrade` 與 `verify`。

核對工單、流程、歷史和登入後才切換服務目的地。保留原資料庫，確認還原成功之前不刪除原庫。

## 維護演練

以下測試需要可建立臨時資料庫的測試角色。測試會載入根 `.env`，`TEST_DATABASE_URL` 必須指向隔離測試環境。缺少連線設定會回報失敗，不會以略過冒充通過。

```bash
node scripts/self-host.mjs build
node --test scripts/self-host.test.mjs
```

測試會建立兩個隨機命名資料庫，驗證全新安裝、從 migration 005 資料形態升級、工單與流程及歷史保留、備份還原、損壞備份拒絕和非空目標拒絕。結束只清理它自己建立的資料庫。

此演練不代替四週真實使用，也不代表已在其他主機或作業系統驗證。
