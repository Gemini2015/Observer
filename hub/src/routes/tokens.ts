import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './index.js';
import { requireSession } from '../http/auth.js';
import { CreateEnrollTokenSchema } from '../http/schemas.js';
import { audit } from '../services/audit.js';
import { issueEnrollToken } from '../services/tokens.js';

export function registerTokenRoutes(app: FastifyInstance, ctx: RouteContext): void {
  /** Web 控制台生成一次性注册 token（只返回一次明文）。 */
  app.post('/api/v1/enroll-tokens', async (request, reply) => {
    requireSession(ctx.db, request);
    const body = CreateEnrollTokenSchema.parse(request.body ?? {});
    const issued = issueEnrollToken(ctx.db, {
      machineHint: body.machine_hint,
      ttlHours: body.ttl_hours,
    });
    audit(ctx.db, 'user', 'enroll_token.create', body.machine_hint, {
      token_pk: issued.tokenPk,
      expires_at: issued.expiresAt,
      ttl_hours: body.ttl_hours,
    });
    return reply.code(201).send({
      token: issued.token,
      expires_at: issued.expiresAt,
      machine_hint: body.machine_hint ?? null,
    });
  });
}
