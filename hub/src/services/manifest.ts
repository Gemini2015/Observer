import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import type { FastifyReply } from 'fastify';
import type { Db } from '../db/index.js';

interface ManifestRow {
  path_key: string;
  size: number;
  mtime_ns: string;
  last_hashed_at: number | null;
}

/**
 * 流式下发完整路径清单（NDJSON + gzip）：
 * {"k": path_key, "s": size, "m": mtime_ns, "h": last_hashed_at}
 * 只包含 state='active' 的路径；不做「到期过滤」，由 agent 本地比对。
 */
export function streamManifest(db: Db, mountPk: number, reply: FastifyReply): FastifyReply {
  const statement = db.prepare(
    "SELECT path_key, size, mtime_ns, last_hashed_at FROM paths WHERE mount_pk = ? AND state = 'active' ORDER BY id",
  );

  function* lines(): Generator<string> {
    const rows = statement.iterate(mountPk) as Iterable<ManifestRow>;
    for (const row of rows) {
      yield `${JSON.stringify({
        k: row.path_key,
        s: row.size,
        m: row.mtime_ns,
        h: row.last_hashed_at,
      })}\n`;
    }
  }

  const gzip = createGzip();
  Readable.from(lines()).pipe(gzip);

  reply.header('content-type', 'application/x-ndjson');
  reply.header('content-encoding', 'gzip');
  return reply.send(gzip);
}
