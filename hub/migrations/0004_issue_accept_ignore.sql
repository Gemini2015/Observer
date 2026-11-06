-- 0004：异常生命周期调整
-- - 新增 ignored_hash / ignored_at / resolution
-- - 旧 acked（已确认）统一迁移为 ignored（已知）
-- - mismatch 的 ignored_hash 优先从 evidence.observed_hash 回填，其次取最近一次观测
-- 说明：保留 status CHECK 中的 acked 作为遗留值，避免重建 issues 表；
--       应用不再写入 acked，迁移后正常数据中不应再有 acked。

ALTER TABLE issues ADD COLUMN ignored_hash TEXT;
ALTER TABLE issues ADD COLUMN ignored_at INTEGER;
ALTER TABLE issues ADD COLUMN resolution TEXT;

UPDATE issues
   SET ignored_hash = COALESCE(
         CASE
           WHEN json_valid(evidence_json) THEN json_extract(evidence_json, '$.observed_hash')
           ELSE NULL
         END,
         (SELECT o.hash FROM observations o
           WHERE o.path_pk = issues.path_pk
           ORDER BY o.observed_at DESC, o.id DESC LIMIT 1)
       ),
       ignored_at = COALESCE(ignored_at, last_seen_at)
 WHERE type = 'mismatch' AND status IN ('acked', 'ignored');

UPDATE issues
   SET status = 'ignored',
       ignored_at = COALESCE(ignored_at, last_seen_at)
 WHERE status = 'acked';

UPDATE issues
   SET ignored_at = last_seen_at
 WHERE status = 'ignored' AND ignored_at IS NULL;
