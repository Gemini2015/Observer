import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './index.js';
import { HttpError } from '../http/errors.js';
import { requireAgent } from '../http/auth.js';
import {
  AgentJobsQuery,
  EnrollInputSchema,
  FinishSchema,
  HeartbeatInput,
  IdParam,
  MountSyncSchema,
  OffsetQuery,
  RepairResultSchema,
  ResultBatchSchema,
  TransferFailSchema,
} from '../http/schemas.js';
import { enrollAgent, heartbeatAgent } from '../services/registry.js';
import { findUsableEnrollToken } from '../services/tokens.js';
import {
  dispatchJobForAgent,
  finishJob,
  getMount,
  jobView,
  listJobsForMachine,
} from '../services/jobs.js';
import { processBatch } from '../services/ingest.js';
import { streamManifest } from '../services/manifest.js';
import { syncAgentMounts } from '../services/mount-sync.js';
import {
  agentRepairTasks,
  agentTransferTasks,
  appendTransferChunk,
  failTransfer,
  readTransferChunk,
  reportRepairResult,
  transfersPath,
} from '../services/repairs.js';

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
      transfers: agentTransferTasks(ctx.db, agent.machine_pk),
      repairs: agentRepairTasks(ctx.db, agent.machine_pk),
    };
  });

  app.put('/api/v1/agent/mounts', async (request) => {
    const agent = requireAgent(ctx.db, request);
    const body = MountSyncSchema.parse(request.body);
    return syncAgentMounts(ctx.db, agent, body.mounts);
  });

  app.get('/api/v1/agent/jobs', async (request) => {
    const agent = requireAgent(ctx.db, request);
    const { limit } = AgentJobsQuery.parse(request.query ?? {});
    return listJobsForMachine(ctx.db, agent.machine_pk, limit).map(jobView);
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

  app.put('/api/v1/transfers/:id/data', async (request) => {
    const agent = requireAgent(ctx.db, request);
    const transferId = IdParam.parse((request.params as { id: string }).id);
    const offset = OffsetQuery.parse((request.query as { offset?: string }).offset);
    if (!Buffer.isBuffer(request.body)) {
      throw new HttpError(422, 'binary body required');
    }
    return appendTransferChunk(
      ctx.db,
      agent,
      transferId,
      offset,
      request.body,
      transfersPath(ctx.env.OBSERVER_DATA_DIR),
    );
  });

  app.get('/api/v1/transfers/:id/data', async (request, reply) => {
    const agent = requireAgent(ctx.db, request);
    const transferId = IdParam.parse((request.params as { id: string }).id);
    const offset = OffsetQuery.parse((request.query as { offset?: string }).offset);
    const chunk = readTransferChunk(
      ctx.db,
      agent,
      transferId,
      offset,
      transfersPath(ctx.env.OBSERVER_DATA_DIR),
    );
    reply.header('x-observer-size', chunk.total);
    return reply.type('application/octet-stream').send(chunk.data);
  });

  app.post('/api/v1/transfers/:id/fail', async (request) => {
    const agent = requireAgent(ctx.db, request);
    const transferId = IdParam.parse((request.params as { id: string }).id);
    const body = TransferFailSchema.parse(request.body);
    failTransfer(ctx.db, agent, transferId, body.reason, transfersPath(ctx.env.OBSERVER_DATA_DIR));
    return { ok: true };
  });

  app.post('/api/v1/repairs/:id/result', async (request) => {
    const agent = requireAgent(ctx.db, request);
    const repairId = IdParam.parse((request.params as { id: string }).id);
    const body = RepairResultSchema.parse(request.body);
    return reportRepairResult(
      ctx.db,
      agent,
      repairId,
      body,
      transfersPath(ctx.env.OBSERVER_DATA_DIR),
    );
  });
}
