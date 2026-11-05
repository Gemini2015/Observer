import { useState } from 'react';
import { ApiError, api, type EnrollTokenResult, type SystemInfo } from '../api';
import { KeyValue } from '../components/KeyValue';
import { PageHeader } from '../components/PageHeader';
import { PageLoading } from '../components/PageLoading';
import { useToast } from '../components/Toast';
import { copyText } from '../lib/clipboard';
import { formatCount, formatDuration, formatTime } from '../lib/format';
import { useDocumentTitle, usePolling } from '../lib/hooks';

const TTL_OPTIONS = [
  { hours: 24, label: '24 小时' },
  { hours: 72, label: '72 小时' },
  { hours: 168, label: '7 天' },
];

export default function SystemPage() {
  useDocumentTitle('系统');
  const toast = useToast();
  const [machineHint, setMachineHint] = useState('');
  const [ttlHours, setTtlHours] = useState(24);
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<EnrollTokenResult | null>(null);

  const state = usePolling(async (signal) => api<SystemInfo>('/api/v1/system', { signal }), {
    intervalMs: 30_000,
  });

  const info = state.data;
  const missingEndpoint = state.error instanceof ApiError && state.error.status === 404;

  const copyValue = async (value: string, label: string) => {
    const ok = await copyText(value);
    if (ok) toast.success(`已复制${label}`);
    else toast.error('复制失败', '浏览器不允许访问剪贴板，请手动选中复制。');
  };

  const createToken = async () => {
    setIssuing(true);
    try {
      setIssued(
        await api<EnrollTokenResult>('/api/v1/enroll-tokens', {
          method: 'POST',
          body: JSON.stringify({
            machine_hint: machineHint.trim() || undefined,
            ttl_hours: ttlHours,
          }),
        }),
      );
      toast.success('已生成注册 token');
    } catch (err) {
      toast.error('生成注册 token 失败', (err as Error).message);
    } finally {
      setIssuing(false);
    }
  };

  if (!info && state.error && !missingEndpoint) {
    return (
      <div className="alert alert-danger" role="alert">
        加载系统信息失败：{state.error.message}
      </div>
    );
  }
  if (!info && !missingEndpoint) return <PageLoading />;

  return (
    <>
      <PageHeader
        title="系统"
        subtitle="中心服运行状态与配置概览（只读；配置在 hub 的 .env 与 agent 的 YAML 中维护）"
        actions={
          <button className="btn" type="button" onClick={() => state.reload()}>
            刷新
          </button>
        }
      />

      {missingEndpoint ? (
        <div className="alert alert-warn" role="status">
          当前 hub 版本还没有 /api/v1/system 接口，系统信息暂不可用。升级 hub 后刷新即可。
        </div>
      ) : null}

      {info ? (
        <>
          <div className="kpi-grid">
            <div className="kpi">
              <span className="kpi-label">hub 版本</span>
              <span className="kpi-value" style={{ fontSize: 'var(--text-xl)' }}>
                {info.version}
              </span>
              <span className="kpi-hint">当前时间 {formatTime(info.now)}</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">已运行</span>
              <span className="kpi-value" style={{ fontSize: 'var(--text-xl)' }}>
                {formatDuration(info.uptime_ms)}
              </span>
              <span className="kpi-hint">进程启动至今</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">调度器</span>
              <span className="kpi-value" style={{ fontSize: 'var(--text-xl)' }}>
                {info.scheduler.enabled ? '已启用' : '已关闭'}
              </span>
              <span className="kpi-hint">
                {info.scheduler.enabled
                  ? `每 ${info.scheduler.interval_ms / 1000} 秒轮询一次`
                  : 'OBSERVER_SCHEDULER_ENABLED=false'}
              </span>
            </div>
            <div className="kpi">
              <span className="kpi-label">数据库</span>
              <span className="kpi-value" style={{ fontSize: 'var(--text-xl)' }}>
                {info.db.ok ? '正常' : '异常'}
              </span>
              <span className="kpi-hint">离线判定阈值 {info.offline_after_seconds} 秒</span>
            </div>
          </div>

          <h2 style={{ margin: '22px 0 10px' }}>数据规模</h2>
          <div className="panel">
            <KeyValue
              items={[
                { label: '机器', value: formatCount(info.db.machines) },
                { label: '挂载点', value: formatCount(info.db.mounts) },
                { label: '入库文件', value: formatCount(info.db.paths) },
                { label: '未关闭异常', value: formatCount(info.db.issues_open) },
                { label: '运行中任务', value: formatCount(info.db.jobs_running) },
                { label: '进行中修复', value: formatCount(info.db.repairs_active) },
              ]}
            />
          </div>

          <h2 style={{ margin: '22px 0 10px' }}>配置说明</h2>
          <div className="panel muted" style={{ fontSize: 'var(--text-sm)' }}>
            <p>
              中心服配置通过环境变量提供（<code>OBSERVER_HOST</code>、<code>OBSERVER_PORT</code>、
              <code>OBSERVER_DATA_DIR</code>、<code>OBSERVER_ADMIN_PASSWORD</code>、
              <code>OBSERVER_SCHEDULER_ENABLED</code>、<code>OBSERVER_SCHEDULER_INTERVAL_MS</code>、
              <code>OBSERVER_OFFLINE_AFTER_SECONDS</code>），见仓库的{' '}
              <code>docs/CONFIG.md</code> 与 <code>.env.example</code>。
            </p>
            <p style={{ marginTop: 8 }}>
              agent 的调度、限速、规则等高级配置在其 YAML 中维护；Web 端不提供写入入口，避免与
              agent 配置分叉。
            </p>
          </div>
        </>
      ) : null}

      <h2 style={{ margin: '22px 0 10px' }}>注册新机器</h2>
      <div className="panel">
        <p className="muted" style={{ fontSize: 'var(--text-sm)', marginBottom: 12 }}>
          生成一次性注册 token，填入 agent 配置的 <code>agent.token</code> 后启动即可。已有节点重连请到机器详情页获取「接入 token」。
        </p>
        {issued ? (
          <div className="stack">
            <div className="alert alert-warn">
              token 只显示这一次；过期时间 {formatTime(issued.expires_at)}。
            </div>
            <pre className="code-block" style={{ maxHeight: 120 }}>
              {issued.token}
            </pre>
            <div className="toolbar">
              <button className="btn" type="button" onClick={() => void copyValue(issued.token, '注册 token')}>
                复制 token
              </button>
              <button className="btn" type="button" onClick={() => setIssued(null)}>
                再生成一个
              </button>
            </div>
          </div>
        ) : (
          <div className="filter-grid">
            <label className="field">
              <span className="field-label">机器 ID 提示（可选）</span>
              <input
                className="input"
                value={machineHint}
                onChange={(event) => setMachineHint(event.target.value)}
                placeholder="例如 nas-01"
                autoComplete="off"
              />
            </label>
            <label className="field">
              <span className="field-label">有效期</span>
              <select
                className="select"
                value={String(ttlHours)}
                onChange={(event) => setTtlHours(Number(event.target.value))}
              >
                {TTL_OPTIONS.map((option) => (
                  <option key={option.hours} value={String(option.hours)}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn btn-primary" type="button" disabled={issuing} onClick={() => void createToken()}>
              {issuing ? '生成中…' : '生成 token'}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
