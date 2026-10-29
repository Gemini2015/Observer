import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RouteContext } from './index.js';
import { HttpError } from '../http/errors.js';
import { requireAgent } from '../http/auth.js';
import { enrollAgent, heartbeatAgent } from '../services/registry.js';
import { findUsableEnrollToken } from '../services/tokens.js';

const idPattern = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const MountInput = z.object({
  mount_id: z.string().regex(idPattern),
  label: z.string().max(200).optional(),
  physical_path: z.string().min(1).max(4096),
  sentinel: z.string().min(1).max(255).nullish(),
  fs_kind: z.enum(['local', 'network', 'removable', 'fuse']).default('local'),
  case_sensitive: z.enum(['auto', 'true', 'false']).default('auto'),
  unicode: z.enum(['auto', 'nfc', 'nfd']).default('auto'),
  include: z.array(z.string().max(1024)).default([]),
  exclude: z.array(z.string().max(1024)).default([]),
  rules_hash: z.string().min(1).max(128),
  limits: z.record(z.unknown()).default({}),
  schedule: z.record(z.unknown()).default({}),
});

const EnrollInputSchema = z.object({
  machine_id: z.string().regex(idPattern),
  label: z.string().max(200).optional(),
  hostname: z.string().max(255).optional(),
  platform: z.string().max(64).optional(),
  arch: z.string().max(64).optional(),
  agent_version: z.string().max(64).optional(),
  mounts: z.array(MountInput).min(1).max(256),
});

const HeartbeatInput = z.object({
  agent_version: z.string().max(64).optional(),
});

export function registerAgentRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.post('/api/v1/enroll', async (request, reply) => {
    const rawToken = request.headers['x-observer-enroll-token'];
    if (typeof rawToken !== 'string' || rawToken.length === 0) {
      throw new HttpError(401, 'unauthorized', 'missing enroll token');
    }
    const tokenRow = findUsableEnrollToken(ctx.db, rawToken);
    if (!tokenRow) {
      throw new HttpError(401, 'invalid or expired enroll token');
    }

    const input = EnrollInputSchema.parse(request.body);
    const result = enrollAgent(ctx.db, input, tokenRow.id);

    return reply.code(201).send({
      agent_id: result.agentId,
      token: result.token,
      machine_id: input.machine_id,
      protocol: 1,
      mounts: result.mounts,
    });
  });

  app.post('/api/v1/agent/heartbeat', async (request) => {
    const agent = requireAgent(ctx.db, request);
    const body = HeartbeatInput.parse(request.body ?? {});
    return heartbeatAgent(ctx.db, agent, body);
  });
}
