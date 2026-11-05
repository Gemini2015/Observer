import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('界面渲染失败', error, info);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="content">
          <div className="panel">
            <div className="alert alert-danger">
              页面渲染失败：{this.state.error.message}
            </div>
            <p className="muted" style={{ marginTop: 12 }}>
              可以先重新加载页面；如果问题持续出现，请把浏览器控制台的错误信息反馈给维护者。
            </p>
            <div className="toolbar" style={{ marginTop: 12 }}>
              <button className="btn btn-primary" type="button" onClick={() => window.location.reload()}>
                重新加载
              </button>
              <button className="btn" type="button" onClick={() => this.setState({ error: null })}>
                返回上一状态
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
