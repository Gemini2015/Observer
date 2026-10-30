import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './index.js';
import { HttpError } from '../http/errors.js';
import { requireSession } from '../http/auth.js';
import { CreateEnrollTokenSchema, IdParam } from '../http/schemas.js';
import { audit } from '../services/audit.js';
import { issueAgentTokenForMachine, issueEnrollToken } from '../services/tokens.js';

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

  /** 为已注册机器重新签发长期接入 token；旧 agent token 立即失效。 */
  app.post('/api/v1/machines/:id/token', async (request, reply) => {
    requireSession(ctx.db, request);
    const machinePk = IdParam.parse((request.params as { id: string }).id);
    const issued = issueAgentTokenForMachine(ctx.db, machinePk);
    if (!issued) throw new HttpError(404, 'machine not found');

    audit(ctx.db, 'user', 'agent.token.rotate', `machine:${issued.machineId}`, {
      agent_id: issued.agentId,
      revoked_agents: issued.revokedAgents,
    });

    return reply.code(201).send({
      token: issued.token,
      agent_id: issued.agentId,
      machine_id: issued.machineId,
      revoked_agents: issued.revokedAgents,
    });
  });
}
