import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from './index.js';
import { HttpError } from '../http/errors.js';
import { requireSession } from '../http/auth.js';
import { verifyAdminPassword } from '../services/admin.js';
import {
  createSession,
  deleteSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from '../services/sessions.js';

const LoginInput = z.object({ password: z.string().min(1).max(1024) });

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 5;

export function registerAuthRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const attempts = new Map<string, { count: number; resetAt: number }>();

  app.post('/api/v1/auth/login', async (request, reply) => {
    const now = Date.now();
    const ip = request.ip;
    const entry = attempts.get(ip);
    if (entry && entry.resetAt > now && entry.count >= RATE_MAX) {
      throw new HttpError(429, 'too many login attempts', 'try again later', true);
    }

    const body = LoginInput.parse(request.body);

    if (!verifyAdminPassword(ctx.db, body.password)) {
      const next =
        entry && entry.resetAt > now
          ? { count: entry.count + 1, resetAt: entry.resetAt }
          : { count: 1, resetAt: now + RATE_WINDOW_MS };
      attempts.set(ip, next);
      throw new HttpError(401, 'invalid credentials');
    }

    attempts.delete(ip);
    const session = createSession(ctx.db, SESSION_TTL_MS, now);
    reply.setCookie(SESSION_COOKIE, session.id, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return { ok: true, expires_at: session.expires_at };
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const id = request.cookies?.[SESSION_COOKIE];
    if (id) deleteSession(ctx.db, id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/v1/me', async (request) => {
    const session = requireSession(ctx.db, request);
    return { authenticated: true, expires_at: session.expires_at };
  });
}
