import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './index.js';
import { HttpError } from '../http/errors.js';
import { requireSession } from '../http/auth.js';
import { IdParam, ScanRequest } from '../http/schemas.js';
import { computeCoverage, createScanJob, getMount, type MountRow } from '../services/jobs.js';
import { parseSchedule } from '../services/scheduler.js';
import { deleteMount } from '../services/deletion.js';
import { transfersPath } from '../services/repairs.js';

function mountView(
  db: RouteContext['db'],
  mount: MountRow,
  now: number,
): Record<string, unknown> {
  const machine = db
    .prepare('SELECT machine_id FROM machines WHERE id = ?')
    .get(mount.machine_pk) as { machine_id: string } | undefined;

  return {
    id: mount.id,
    mount_id: mount.mount_id,
    label: mount.label,
    machine_id: machine?.machine_id ?? null,
    physical_path: mount.physical_path,
    state: mount.state,
    manifest_epoch: mount.manifest_epoch,
    rules_hash: mount.rules_hash,
    include: JSON.parse(mount.include_json) as unknown,
    exclude: JSON.parse(mount.exclude_json) as unknown,
    schedule: parseSchedule(mount.schedule_json),
    repair_allowed: mount.repair_allowed === 1,
    coverage: computeCoverage(db, mount.id, now),
  };
}

export function registerMountRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/v1/mounts', async (request) => {
    requireSession(ctx.db, request);
    const rows = ctx.db
      .prepare("SELECT * FROM mounts WHERE state != 'removed' ORDER BY machine_pk, mount_id")
      .all() as MountRow[];
    const now = Date.now();
    return rows.map((row) => mountView(ctx.db, row, now));
  });

  app.get('/api/v1/mounts/:id', async (request) => {
    requireSession(ctx.db, request);
    const mountPk = IdParam.parse((request.params as { id: string }).id);
    const mount = getMount(ctx.db, mountPk);
    if (!mount) throw new HttpError(404, 'mount not found');

    const lastJob = ctx.db
      .prepare(
        'SELECT id, mode, status, created_at, started_at, finished_at, stats_json FROM scan_jobs WHERE mount_pk = ? ORDER BY id DESC LIMIT 1',
      )
      .get(mountPk) as Record<string, unknown> | undefined;

    return { ...mountView(ctx.db, mount, Date.now()), last_job: lastJob ?? null };
  });

  app.delete('/api/v1/mounts/:id', async (request) => {
    requireSession(ctx.db, request);
    const mountPk = IdParam.parse((request.params as { id: string }).id);
    const result = deleteMount(
      ctx.db,
      mountPk,
      transfersPath(ctx.env.OBSERVER_DATA_DIR),
    );
    if (!result) throw new HttpError(404, 'mount not found');
    return { ok: true, ...result };
  });

  app.post('/api/v1/mounts/:id/scan', async (request, reply) => {
    requireSession(ctx.db, request);
    const mountPk = IdParam.parse((request.params as { id: string }).id);
    const body = ScanRequest.parse(request.body ?? {});
    const { jobId } = createScanJob(ctx.db, mountPk, body.mode, 'user');
    return reply.code(202).send({ job_id: jobId, mode: body.mode });
  });
}
