import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './index.js';
import { HttpError } from '../http/errors.js';
import { requireAgent } from '../http/auth.js';
import {
  EnrollInputSchema,
  FinishSchema,
  HeartbeatInput,
  IdParam,
  ResultBatchSchema,
} from '../http/schemas.js';
import { enrollAgent, heartbeatAgent } from '../services/registry.js';
import { findUsableEnrollToken } from '../services/tokens.js';
import { dispatchJobForAgent, finishJob, getMount } from '../services/jobs.js';
import { processBatch } from '../services/ingest.js';
import { streamManifest } from '../services/manifest.js';

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
    const base = heartbeatAgent(ctx.db, agent, body);

    const job = dispatchJobForAgent(ctx.db, agent);
    const mount = job ? getMount(ctx.db, job.mount_pk) : undefined;

    return {
      ...base,
      cancel: job?.cancel_requested === 1,
      job:
        job && mount
          ? {
              id: job.id,
              mount_pk: mount.id,
              mount_id: mount.mount_id,
              mode: job.mode,
              lease_until: job.lease_until,
            }
          : null,
    };
  });

  app.post('/api/v1/jobs/:id/results', async (request) => {
    const agent = requireAgent(ctx.db, request);
    const jobId = IdParam.parse((request.params as { id: string }).id);
    const body = ResultBatchSchema.parse(request.body);
    return processBatch(ctx.db, {
      agent,
      jobId,
      seq: body.seq,
      entries: body.entries,
    });
  });

  app.post('/api/v1/jobs/:id/finish', async (request) => {
    const agent = requireAgent(ctx.db, request);
    const jobId = IdParam.parse((request.params as { id: string }).id);
    const body = FinishSchema.parse(request.body);
    return finishJob(ctx.db, agent, jobId, body);
  });

  app.get('/api/v1/mounts/:id/manifest', async (request, reply) => {
    const agent = requireAgent(ctx.db, request);
    const mountPk = IdParam.parse((request.params as { id: string }).id);
    const mount = getMount(ctx.db, mountPk);
    if (!mount || mount.machine_pk !== agent.machine_pk) {
      throw new HttpError(404, 'mount not found');
    }
    return streamManifest(ctx.db, mountPk, reply);
  });
}
