import { Link } from 'react-router-dom';
import { paths } from './routes';
export function RouteErrorPage({ article = false }: { article?: boolean }) {
  return (
    <section className="automatic-panel" role="status">
      <h1>{article ? '文章不存在或已删除' : '页面不存在'}</h1>
      <p>
        {article
          ? '请检查文章地址，或到回收站查看已删除的文章。'
          : '请检查地址，或返回工作区继续操作。'}
      </p>
      <Link to={paths.home}>返回工作区</Link>
      {article && (
        <>
          {' '}
          · <Link to={paths.trash}>查看回收站</Link>
        </>
      )}
    </section>
  );
}
