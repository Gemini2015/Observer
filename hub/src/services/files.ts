import type { Db } from '../db/index.js';

export type FileState = 'active' | 'missing' | 'out_of_scope';
export type FileSort = 'path' | 'size' | 'last_seen' | 'last_hashed' | 'state';

export interface FileListQuery {
  q?: string;
  machine_id?: string;
  mount_pk?: number;
  mount_id?: string;
  state?: FileState;
  issue?: 'open' | 'none';
  hash?: 'hashed' | 'unhashed';
  size_min?: number;
  size_max?: number;
  sort?: FileSort;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  scopeMachinePk?: number;
}

export interface FileSummary {
  total: number;
  active: number;
  missing: number;
  out_of_scope: number;
  hashed: number;
  unhashed: number;
  open_issue_paths: number;
}

export interface FileItem {
  id: number;
  machine_id: string;
  machine_label: string | null;
  mount_pk: number;
  mount_id: string;
  mount_label: string | null;
  path_key: string;
  path_display_b64: string;
  state: FileState;
  size: number;
  mtime_ns: string;
  content_hash: string | null;
  last_seen_at: number | null;
  last_hashed_at: number | null;
  last_hash_kind: string | null;
  open_issue_count: number;
}

export interface FileListResult {
  items: FileItem[];
  total: number;
  limit: number;
  offset: number;
  summary: FileSummary;
}

export interface FileIssueView {
  id: number;
  type: string;
  status: string;
  confidence: string;
  occurrences: number;
  first_seen_at: number;
  last_seen_at: number;
  evidence: unknown;
}

export interface FileObservationView {
  hash: string;
  kind: string;
  observed_at: number;
}

export interface FileDetailResult {
  file: FileItem;
  machine: {
    machine_id: string;
    label: string | null;
    status: string;
    platform: string | null;
  };
  mount: {
    id: number;
    mount_id: string;
    label: string | null;
    physical_path: string;
    state: string;
  };
  issues: FileIssueView[];
  observations: FileObservationView[];
}

interface FileRow {
  id: number;
  machine_id: string;
  machine_label: string | null;
  mount_pk: number;
  mount_id: string;
  mount_label: string | null;
  physical_path: string;
  path_key: string;
  path_display: Buffer;
  state: FileState;
  size: number;
  mtime_ns: string;
  content_hash: string | null;
  last_seen_at: number | null;
  last_hashed_at: number | null;
  last_hash_kind: string | null;
  open_issue_count: number;
}

interface IssueRow {
  id: number;
  type: string;
  status: string;
  confidence: string;
  occurrences: number;
  first_seen_at: number;
  last_seen_at: number;
  evidence_json: string | null;
}

interface ObservationRow {
  hash: string;
  kind: string;
  observed_at: number;
}

interface WhereClause {
  sql: string;
  params: unknown[];
}

const SORT_COLUMNS: Record<FileSort, string> = {
  path: 'p.path_key COLLATE NOCASE',
  size: 'p.size',
  last_seen: 'p.last_seen_at',
  last_hashed: 'p.last_hashed_at',
  state: 'p.state',
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function buildWhere(query: FileListQuery): WhereClause {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (query.scopeMachinePk !== undefined) {
    clauses.push('m.machine_pk = ?');
    params.push(query.scopeMachinePk);
  }
  if (query.machine_id) {
    clauses.push('mc.machine_id = ?');
    params.push(query.machine_id);
  }
  if (query.mount_pk !== undefined) {
    clauses.push('m.id = ?');
    params.push(query.mount_pk);
  }
  if (query.mount_id) {
    clauses.push('m.mount_id = ?');
    params.push(query.mount_id);
  }
  if (query.state) {
    clauses.push('p.state = ?');
    params.push(query.state);
  }
  if (query.issue === 'open') {
    clauses.push(
      "EXISTS (SELECT 1 FROM issues i WHERE i.path_pk = p.id AND i.status = 'open')",
    );
  } else if (query.issue === 'none') {
    clauses.push(
      "NOT EXISTS (SELECT 1 FROM issues i WHERE i.path_pk = p.id AND i.status = 'open')",
    );
  }
  if (query.hash === 'hashed') {
    clauses.push('p.last_hashed_at IS NOT NULL');
  } else if (query.hash === 'unhashed') {
    clauses.push('p.last_hashed_at IS NULL');
  }
  if (query.size_min !== undefined) {
    clauses.push('p.size >= ?');
    params.push(query.size_min);
  }
  if (query.size_max !== undefined) {
    clauses.push('p.size <= ?');
    params.push(query.size_max);
  }

  const search = query.q?.trim();
  if (search) {
    if (/^[0-9a-fA-F]{64}$/.test(search)) {
      clauses.push('p.content_hash = ?');
      params.push(search.toLowerCase());
    } else {
      clauses.push("p.path_key LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(search)}%`);
    }
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

function normalizedPaging(query: FileListQuery): { limit: number; offset: number } {
  const limit = Math.min(200, Math.max(1, Math.floor(query.limit ?? 50)));
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  return { limit, offset };
}

function orderBy(query: FileListQuery): string {
  const sort = query.sort ?? 'path';
  const direction = query.order === 'desc' ? 'DESC' : 'ASC';
  const column = SORT_COLUMNS[sort];
  if (sort === 'last_seen' || sort === 'last_hashed') {
    return `${column} IS NULL ASC, ${column} ${direction}, p.id ASC`;
  }
  return `${column} ${direction}, p.id ASC`;
}

const FILE_SELECT = `
  SELECT p.id, mc.machine_id, mc.label AS machine_label,
         m.id AS mount_pk, m.mount_id, m.label AS mount_label, m.physical_path,
         p.path_key, p.path_display, p.state, p.size, p.mtime_ns,
         p.content_hash, p.last_seen_at, p.last_hashed_at, p.last_hash_kind,
         (SELECT COUNT(*) FROM issues i WHERE i.path_pk = p.id AND i.status = 'open') AS open_issue_count
  FROM paths p
  JOIN mounts m ON m.id = p.mount_pk
  JOIN machines mc ON mc.id = m.machine_pk
`;

function rowToItem(row: FileRow): FileItem {
  return {
    id: row.id,
    machine_id: row.machine_id,
    machine_label: row.machine_label,
    mount_pk: row.mount_pk,
    mount_id: row.mount_id,
    mount_label: row.mount_label,
    path_key: row.path_key,
    path_display_b64: Buffer.from(row.path_display).toString('base64'),
    state: row.state,
    size: row.size,
    mtime_ns: row.mtime_ns,
    content_hash: row.content_hash,
    last_seen_at: row.last_seen_at,
    last_hashed_at: row.last_hashed_at,
    last_hash_kind: row.last_hash_kind,
    open_issue_count: row.open_issue_count,
  };
}

export function listFiles(db: Db, query: FileListQuery): FileListResult {
  const where = buildWhere(query);
  const { limit, offset } = normalizedPaging(query);

  const rows = db
    .prepare(`${FILE_SELECT} ${where.sql} ORDER BY ${orderBy(query)} LIMIT ? OFFSET ?`)
    .all(...where.params, limit, offset) as FileRow[];

  const summaryRow = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN p.state = 'active' THEN 1 ELSE 0 END), 0) AS active,
              COALESCE(SUM(CASE WHEN p.state = 'missing' THEN 1 ELSE 0 END), 0) AS missing,
              COALESCE(SUM(CASE WHEN p.state = 'out_of_scope' THEN 1 ELSE 0 END), 0) AS out_of_scope,
              COALESCE(SUM(CASE WHEN p.last_hashed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS hashed,
              COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM issues i WHERE i.path_pk = p.id AND i.status = 'open') THEN 1 ELSE 0 END), 0) AS open_issue_paths
       FROM paths p
       JOIN mounts m ON m.id = p.mount_pk
       JOIN machines mc ON mc.id = m.machine_pk
       ${where.sql}`,
    )
    .get(...where.params) as {
    total: number;
    active: number;
    missing: number;
    out_of_scope: number;
    hashed: number;
    open_issue_paths: number;
  };

  return {
    items: rows.map(rowToItem),
    total: summaryRow.total,
    limit,
    offset,
    summary: {
      total: summaryRow.total,
      active: summaryRow.active,
      missing: summaryRow.missing,
      out_of_scope: summaryRow.out_of_scope,
      hashed: summaryRow.hashed,
      unhashed: summaryRow.total - summaryRow.hashed,
      open_issue_paths: summaryRow.open_issue_paths,
    },
  };
}

export function getFileDetail(
  db: Db,
  pathId: number,
  scopeMachinePk?: number,
): FileDetailResult | undefined {
  const scopeClause = scopeMachinePk === undefined ? '' : 'AND m.machine_pk = ?';
  const params: unknown[] = scopeMachinePk === undefined ? [pathId] : [pathId, scopeMachinePk];
  const row = db
    .prepare(`${FILE_SELECT} WHERE p.id = ? ${scopeClause}`)
    .get(...params) as FileRow | undefined;
  if (!row) return undefined;

  const machine = db
    .prepare('SELECT machine_id, label, status, platform FROM machines WHERE machine_id = ?')
    .get(row.machine_id) as {
    machine_id: string;
    label: string | null;
    status: string;
    platform: string | null;
  };
  const mount = db
    .prepare('SELECT id, mount_id, label, physical_path, state FROM mounts WHERE id = ?')
    .get(row.mount_pk) as {
    id: number;
    mount_id: string;
    label: string | null;
    physical_path: string;
    state: string;
  };

  const issues = db
    .prepare(
      `SELECT id, type, status, confidence, occurrences, first_seen_at, last_seen_at, evidence_json
       FROM issues WHERE path_pk = ?
       ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'acked' THEN 1 WHEN 'ignored' THEN 2 ELSE 3 END,
                last_seen_at DESC, id DESC
       LIMIT 50`,
    )
    .all(pathId) as IssueRow[];
  const observations = db
    .prepare(
      'SELECT hash, kind, observed_at FROM observations WHERE path_pk = ? ORDER BY observed_at DESC, id DESC LIMIT 20',
    )
    .all(pathId) as ObservationRow[];

  return {
    file: rowToItem(row),
    machine,
    mount,
    issues: issues.map((issue) => ({
      id: issue.id,
      type: issue.type,
      status: issue.status,
      confidence: issue.confidence,
      occurrences: issue.occurrences,
      first_seen_at: issue.first_seen_at,
      last_seen_at: issue.last_seen_at,
      evidence: issue.evidence_json ? (JSON.parse(issue.evidence_json) as unknown) : null,
    })),
    observations,
  };
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function listFilesCsv(db: Db, query: FileListQuery): { csv: string; truncated: boolean; total: number } {
  const result = listFiles(db, { ...query, limit: 5000, offset: 0 });
  const header = [
    'id',
    'machine',
    'mount',
    'path',
    'state',
    'size',
    'hash',
    'last_seen',
    'last_hashed',
    'open_issues',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const item of result.items) {
    lines.push(
      [
        item.id,
        item.machine_id,
        item.mount_id,
        item.path_key,
        item.state,
        item.size,
        item.content_hash ?? '',
        item.last_seen_at ?? '',
        item.last_hashed_at ?? '',
        item.open_issue_count,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return {
    csv: lines.join('\r\n'),
    truncated: result.total > result.items.length,
    total: result.total,
  };
}
