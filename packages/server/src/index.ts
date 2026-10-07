import { createServer } from './api/index.js';
import { loadEnv } from './db/env.js';

// 單體伺服器進入點，也是唯一的組裝根。
// 環境變數在此讀取一次、往下注入，其餘各層不直接碰 process.env。

loadEnv();
const port = Number(process.env['PORT'] ?? 8768);
const host = process.env['HOST'] ?? '127.0.0.1';

const app = createServer();

try {
  await app.listen({ port, host });
} catch (error: unknown) {
  app.log.error(error);
  process.exit(1);
}
