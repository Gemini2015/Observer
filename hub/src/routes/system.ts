import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './index.js';
import { requireSession } from '../http/auth.js';

/** 从 hub/package.json 读取版本号：src（tsx）与 dist（编译后）两种运行位置均可用。 */
let cachedVersion: string | null = null;

function readVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const raw = fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const version =
      parsed !== null && typeof parsed === 'object'
        ? (parsed as { version?: unknown }).version
        : undefined;
    cachedVersion = typeof version === 'string' ? version : 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

function count(db: RouteContext['db'], sql: string): number {
  const row = db.prepare(sql).get() as { n: number } | undefined;
  return row?.n ?? 0;
}

export function registerSystemRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/v1/system', async (request) => {
    requireSession(ctx.db, request);

    let dbInfo: {
      ok: boolean;
      machines: number;
      mounts: number;
      paths: number;
      issues_open: number;
      jobs_running: number;
      repairs_active: number;
    };
    try {
      dbInfo = {
        ok: true,
        machines: count(ctx.db, 'SELECT COUNT(*) AS n FROM machines'),
        mounts: count(ctx.db, "SELECT COUNT(*) AS n FROM mounts WHERE state != 'removed'"),
        paths: count(ctx.db, 'SELECT COUNT(*) AS n FROM paths'),
        issues_open: count(ctx.db, "SELECT COUNT(*) AS n FROM issues WHERE status = 'open'"),
        jobs_running: count(ctx.db, "SELECT COUNT(*) AS n FROM scan_jobs WHERE status = 'running'"),
        repairs_active: count(
          ctx.db,
          "SELECT COUNT(*) AS n FROM repair_jobs WHERE status IN ('pending','transferring','ready','applying')",
        ),
      };
    } catch {
      dbInfo = {
        ok: false,
        machines: 0,
        mounts: 0,
        paths: 0,
        issues_open: 0,
        jobs_running: 0,
        repairs_active: 0,
      };
    }

    return {
      version: readVersion(),
      now: Date.now(),
      uptime_ms: Math.round(process.uptime() * 1000),
      scheduler: {
        enabled: ctx.env.OBSERVER_SCHEDULER_ENABLED,
        interval_ms: ctx.env.OBSERVER_SCHEDULER_INTERVAL_MS,
      },
      offline_after_seconds: ctx.env.OBSERVER_OFFLINE_AFTER_SECONDS,
      db: dbInfo,
    };
  });
}
