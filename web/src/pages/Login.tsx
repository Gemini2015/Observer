import { useState, type FormEvent } from 'react';
import { api } from '../api';

export default function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    <div className="login">
      <div className="panel">
        <img className="login-logo" src="/favicon.svg" alt="Observer" />
        <h1 style={{ marginBottom: 4 }}>Observer</h1>
        <p className="muted">多机文件完整性巡检</p>
        <form onSubmit={submit}>
          <input
            type="password"
            placeholder="管理员密码"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoFocus
          />
          {error ? <div className="error">{error}</div> : null}
          <button className="primary" type="submit" disabled={busy || password.length === 0}>
            {busy ? '登录中…' : '登录'}
          </button>
        </form>
      </div>
    </div>
  );
}
