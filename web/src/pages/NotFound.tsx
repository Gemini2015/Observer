import { Link } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { useDocumentTitle } from '../lib/hooks';

export default function NotFoundPage() {
  useDocumentTitle('页面不存在');
  return (
    <div className="panel" style={{ marginTop: 24 }}>
      <EmptyState
        title="页面不存在"
        description="地址可能已失效或输入有误。侧栏里的页面都在，可以从那里返回。"
        action={
          <Link className="btn btn-primary" to="/">
            返回总览
          </Link>
        }
      />
    </div>
  );
}
