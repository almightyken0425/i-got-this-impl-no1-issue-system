import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { Pool } from 'pg';

import type { AuthConfig } from '../../auth/config.js';
import { loadEnv } from '../../db/env.js';
import { applyMigrations } from '../../db/migrate.js';
import { createServer } from '../index.js';
import { permissionRepo } from '../../db/repositories/index.js';

// API 整合測試共用鷹架（非 .test.ts，不被 vitest 收集為測試檔）。
//
// 走真實連線池連 igotthis_test，以 Fastify inject 打真路由；隔離靠每個 case 前
// TRUNCATE companies CASCADE 連帶清空全租戶資料。無 TEST_DATABASE_URL 時整組略過。

loadEnv();

export const testUrl = process.env['TEST_DATABASE_URL'];

export const TEST_CONFIG: AuthConfig = {
  sessionSecret: 'test-session-secret-please-change-0123456789',
  cookieName: 'igotthis_sid',
  ttlSeconds: 3600,
  cookieSecure: false,
};

/** 建測試庫連線池、套 schema、起 app。 */
export async function bootstrap(): Promise<{ pool: Pool; app: FastifyInstance }> {
  const pool = new Pool({ connectionString: testUrl });
  await applyMigrations(pool);
  const app = createServer({ pool, authConfig: TEST_CONFIG });
  await app.ready();
  return { pool, app };
}

export interface Session {
  readonly cookie: string;
  readonly companyId: string;
  readonly accountId: string;
}

/** 定義路由的專用授權 fixture，不建立工作區或額外欄位以免干擾定義清單案例。 */
export async function grantTypeAdminFixture(pool: Pool, session: Session): Promise<void> {
  const now = Date.now();
  const levelId = randomUUID();
  const roleId = randomUUID();
  await permissionRepo.insertLevelDefinition(pool, {
    id: levelId, companyId: session.companyId, name: '定義測試', system: false,
    canRead: false, canComment: false, canCreate: false, canEditOwn: false,
    canEditAny: false, canArchive: false, canStructure: false, canAssignRole: false,
    createdOn: now, updatedOn: now,
  });
  await permissionRepo.insertRole(pool, {
    id: roleId, companyId: session.companyId, roleTitle: '定義測試', levelId,
    typeAdmin: true, orgAdmin: false, permAdmin: false, tags: null, createdOn: now, updatedOn: now,
  });
  await permissionRepo.insertAccountRole(pool, {
    id: randomUUID(), companyId: session.companyId, accountId: session.accountId, roleId,
    createdOn: now, updatedOn: now,
  });
}

/** 註冊一個帳號並回其 session cookie 與租戶鍵；預設 email 唯一化避免撞號。 */
export async function registerSession(
  app: FastifyInstance,
  email = 'owner@example.com',
): Promise<Session> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'password123', name: 'Owner' },
  });
  const body = res.json() as { account: { id: string; companyId: string } };
  const c = res.cookies.find((x) => x.name === TEST_CONFIG.cookieName);
  if (c === undefined) throw new Error('註冊未回 session cookie');
  return { cookie: `${c.name}=${c.value}`, companyId: body.account.companyId, accountId: body.account.id };
}

/** 帶 cookie 的 inject 簡寫。 */
export function authed(
  app: FastifyInstance,
  cookie: string,
): (args: {
  method: string;
  url: string;
  payload?: unknown;
}) => Promise<LightMyRequestResponse> {
  return ({ method, url, payload }) =>
    app.inject({ method: method as 'GET', url, headers: { cookie }, payload: payload as object });
}
