-- 文件列表查询索引（v3）
CREATE INDEX IF NOT EXISTS idx_paths_state ON paths(state);
CREATE INDEX IF NOT EXISTS idx_paths_last_seen ON paths(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_issues_path_status ON issues(path_pk, status);
