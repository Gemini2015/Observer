import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
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
  });

  app.register(cookie);

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

  app.setNotFoundHandler((request, reply) =>
    problem(reply, 404, 'not found', `${request.method} ${request.url}`),
  );

  registerRoutes(app, { env, db });

  return app;
}
