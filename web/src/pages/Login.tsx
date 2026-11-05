import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useDocumentTitle } from '../lib/hooks';

export default function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useDocumentTitle('登录');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      onSuccess();
    } catch (err) {
      setError((err as Error).message || '登录失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card panel">
        <img className="login-logo" src="/logo.svg" alt="Observer" />
        <h1 className="login-title">Observer</h1>
        <p className="login-sub">多机文件完整性巡检控制台</p>
        <form className="login-form" onSubmit={submit}>
          <label className="field">
            <span className="field-label">管理员密码</span>
            <input
              className="input"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="输入管理员密码"
              autoComplete="current-password"
              autoFocus
              aria-invalid={error ? true : undefined}
            />
          </label>
          <label className="row" style={{ fontSize: 'var(--text-xs)' }}>
            <input
              type="checkbox"
              checked={showPassword}
              onChange={(event) => setShowPassword(event.target.checked)}
            />
            <span>显示密码</span>
          </label>
          {error ? (
            <div className="alert alert-danger" role="alert">
              {error}
            </div>
          ) : null}
          <button
            className="btn btn-primary btn-block"
            type="submit"
            disabled={busy || password.length === 0}
          >
            {busy ? '登录中…' : '登录'}
          </button>
        </form>
        <p className="login-hint">密码由 hub 的环境变量 OBSERVER_ADMIN_PASSWORD 提供。</p>
      </div>
    </div>
  );
}
