import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import type { Env } from './env.js';
import type { Db } from './db/index.js';
import { HttpError, problem } from './http/errors.js';
import { registerRoutes } from './routes/index.js';

export interface BuildAppOptions {
  env: Env;
  db: Db;
  logger?: boolean;
}

export function buildApp({ env, db, logger = true }: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: logger ? { level: env.OBSERVER_LOG_LEVEL } : false,
    // 成功请求不刷日志（Web 控制台会定时轮询）；失败请求由下方 onResponse 记录。
    logController: logger
      ? new LogController({ disableRequestLogging: true })
      : undefined,
  });

  app.register(cookie);
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  // 仅记录失败请求，保留排障信息且避免正常轮询刷屏。
  app.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode >= 400 && reply.statusCode < 500) {
      request.log.warn(
        { method: request.method, url: request.url, statusCode: reply.statusCode },
        'request failed',
      );
    }
  });

  const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
  const hasPublic = fs.existsSync(publicDir);
  if (hasPublic) {
    app.register(fastifyStatic, { root: publicDir, prefix: '/' });
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return problem(reply, error.status, error.title, error.detail, error.retryable);
    }
    if (error instanceof ZodError) {
      const detail = error.issues
        .map((issue) => `${issue.path.join('.') || '(body)'}: ${issue.message}`)
        .join('; ');
      return problem(reply, 422, 'validation failed', detail);
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      const clientError = error as Error;
      return problem(reply, statusCode, clientError.name || 'request error', clientError.message);
    }
    request.log.error(error);
    return problem(reply, 500, 'internal error');
  });

  app.setNotFoundHandler((request, reply) => {
    if (hasPublic && request.method === 'GET' && !request.url.startsWith('/api/')) {
      return reply.sendFile('index.html');
    }
    return problem(reply, 404, 'not found', `${request.method} ${request.url}`);
  });

  registerRoutes(app, { env, db });

  return app;
}
