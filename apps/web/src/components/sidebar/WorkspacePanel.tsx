import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useState } from 'react';
import { FileText, Plus, RefreshCw, Trash2, Undo2 } from 'lucide-react';
import {
  descendantIds,
  getDocsOwnerId,
  useDocsStore,
  type PublishRecord,
} from '../../store/docsStore';
import { getWechatPublishStatus } from '../../services/wechat-api';
import { formatDateTime } from '../../utils/date';
import { viewLabels, type WorkspaceView } from '../../routing/routes';

const templates = [
  {
    name: '技术教程',
    description: '从问题出发，逐步讲解实现与验证。',
    sections: ['你将学到什么', '准备工作', '实现步骤', '验证与常见问题', '总结'],
  },
  {
    name: '产品发布',
    description: '清晰介绍新功能、使用场景和上手方式。',
    sections: ['这次更新了什么', '适用场景', '核心功能', '如何开始', '下一步计划'],
  },
  {
    name: '生活随笔',
    description: '记录一个瞬间，整理自己的感受与思考。',
    sections: ['一个值得记录的瞬间', '事情的经过', '我的感受', '留给未来的自己'],
  },
];

export function WorkspacePanel({
  view,
  onOpenDocument,
  onNavigate,
}: {
  view: WorkspaceView;
  onOpenDocument: (id: string) => void;
  onNavigate: (view: WorkspaceView) => void;
}) {
  const store = useDocsStore();
  const docsOwnerId = getDocsOwnerId();
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const active = store.docs.filter((doc) => !doc.deletedAt);
  const trashed = store.docs.filter((doc) => doc.deletedAt);
  const open = (id: string) => {
    onOpenDocument(id);
  };
  const create = () => {
    onOpenDocument(store.createDoc());
  };
  const refresh = async (record: PublishRecord) => {
    setBusyId(record.publishId);
    setError('');
    try {
      const status = await getWechatPublishStatus(record.publishId);
      store.savePublishRecord(
        {
          ...record,
          state: status.state,
          articleUrl: status.articleUrl,
          message: status.message,
        },
        docsOwnerId,
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : '查询失败，请重试');
    } finally {
      setBusyId(null);
    }
  };
  return (
    <section className="automatic-panel" aria-label={viewLabels[view]}>
      <header className="automatic-panel-header">
        <div>
          <span className="automatic-eyebrow">我的空间 / AUTOMATIC</span>
          <h1>{viewLabels[view]}</h1>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="automatic-primary"
          type="button"
          onClick={create}
        >
          <Plus size={16} />
          新建文章
        </Button>
      </header>
      {view === 'home' && (
        <>
          <p className="automatic-description">从一个想法开始，继续你的下一篇好文章。</p>
          <div className="automatic-stats">
            <div>
              <strong>{active.length}</strong>
              <span>篇文章</span>
            </div>
            <div>
              <strong>
                {store.publishRecords.filter((record) => record.state === 'published').length}
              </strong>
              <span>次成功发布</span>
            </div>
            <div>
              <strong>{trashed.length}</strong>
              <span>篇已删除</span>
            </div>
          </div>
          <div className="automatic-section-title">
            <h2>最近编辑</h2>
            <Input
              type="search"
              placeholder="搜索标题或正文"
              aria-label="搜索标题或正文"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="automatic-document-list">
            {[...active]
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
              .filter((doc) =>
                (
                  doc.title +
                  ' ' +
                  doc.blocks
                    .map((block) => [block.text, ...(block.items ?? [])].join(' '))
                    .join(' ')
                )
                  .toLocaleLowerCase()
                  .includes(query.toLocaleLowerCase()),
              )
              .map((doc) => (
                <article key={doc.id} className="automatic-document-row">
                  <FileText size={19} />
                  <div className="automatic-document-info">
                    {editingId === doc.id ? (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (title.trim()) {
                            store.renameDoc(doc.id, title.trim());
                            setEditingId(null);
                          }
                        }}
                      >
                        <Input
                          aria-label="文章名称"
                          autoFocus
                          value={title}
                          onChange={(event) => setTitle(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') setEditingId(null);
                          }}
                        />
                        <Button variant="default" size="sm" type="submit">
                          保存
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          type="button"
                          onClick={() => setEditingId(null)}
                        >
                          取消
                        </Button>
                      </form>
                    ) : (
                      <Button variant="ghost" size="sm" type="button" onClick={() => open(doc.id)}>
                        {doc.title.trim() || '未命名文章'}
                      </Button>
                    )}
                    <small>{formatDateTime(doc.updatedAt)}</small>
                  </div>
                  <select
                    aria-label={`移动${doc.title}到`}
                    value={doc.parentId ?? ''}
                    onChange={(event) => store.moveDoc(doc.id, event.target.value || null)}
                  >
                    <option value="">工作区根目录</option>
                    {active
                      .filter((parent) => !descendantIds(active, doc.id).has(parent.id))
                      .map((parent) => (
                        <option key={parent.id} value={parent.id}>
                          {parent.title || '未命名文章'}
                        </option>
                      ))}
                  </select>
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={() => {
                      setEditingId(doc.id);
                      setTitle(doc.title);
                    }}
                  >
                    重命名
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    type="button"
                    aria-label={`删除${doc.title}`}
                    title="移入回收站（含子页面）"
                    onClick={() => store.deleteDoc(doc.id)}
                  >
                    <Trash2 size={16} />
                  </Button>
                </article>
              ))}
          </div>
          {query &&
            !active.some((doc) =>
              (
                doc.title +
                ' ' +
                doc.blocks.map((block) => [block.text, ...(block.items ?? [])].join(' ')).join(' ')
              )
                .toLocaleLowerCase()
                .includes(query.toLocaleLowerCase()),
            ) && <p className="automatic-empty">没有匹配的文章，试试其他关键词。</p>}
        </>
      )}
      {view === 'start' && (
        <>
          <p className="automatic-description">只需三步，把灵感变成可发布的文章。</p>
          <div className="automatic-guide">
            <article>
              <span>01</span>
              <h2>开始写作</h2>
              <p>
                新建空白文章，或从模板中心选择结构。点击目录旁的 +
                可以创建子页面；在首页管理文章名称和层级。
              </p>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => onNavigate('templates')}
              >
                选择文章模板 →
              </Button>
            </article>
            <article>
              <span>02</span>
              <h2>丰富内容</h2>
              <p>
                在编辑器输入 / 插入内容块，使用顶部的组件与素材入口添加排版组件、图片和品牌素材。
              </p>
              <Button variant="ghost" size="sm" type="button" onClick={() => onNavigate('editor')}>
                打开编辑器 →
              </Button>
            </article>
            <article>
              <span>03</span>
              <h2>预览与发布</h2>
              <p>
                在右侧预览公众号排版，选择主题并发布。首次发布需要配置公众号凭据和封面；提交后可在发布记录中查看结果。
              </p>
              <Button variant="ghost" size="sm" type="button" onClick={() => onNavigate('history')}>
                查看发布记录 →
              </Button>
            </article>
          </div>
        </>
      )}
      {view === 'templates' && (
        <>
          <p className="automatic-description">选择一种文章结构，创建属于你的新草稿。</p>
          <div className="automatic-template-grid">
            {templates.map((template) => (
              <article className="automatic-template" key={template.name}>
                <div className="automatic-template-paper">
                  <FileText size={22} />
                  <h2>{template.name}</h2>
                  {template.sections.slice(0, 3).map((section) => (
                    <p key={section}>{section}</p>
                  ))}
                </div>
                <p>{template.description}</p>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => {
                    const id = store.createDoc();
                    store.renameDoc(id, template.name);
                    store.updateDocBlocks(
                      id,
                      template.sections.flatMap((text) => [
                        {
                          id: crypto.randomUUID(),
                          type: 'heading' as const,
                          level: 2 as const,
                          text,
                        },
                        { id: crypto.randomUUID(), type: 'paragraph' as const, text: '' },
                      ]),
                    );
                    open(id);
                  }}
                >
                  使用模板
                </Button>
              </article>
            ))}
          </div>
        </>
      )}
      {view === 'history' && (
        <>
          <p className="automatic-description">
            此浏览器中本账户的发布提交记录。点击刷新获取微信的最新处理结果。
          </p>
          {error && <p role="alert">{error}</p>}
          {store.publishRecords.length === 0 ? (
            <div className="automatic-empty">
              <h2>还没有发布记录</h2>
              <p>在文章预览中完成首次发布后，记录会出现在这里。</p>
              <Button variant="ghost" size="sm" type="button" onClick={() => onNavigate('editor')}>
                开始创作
              </Button>
            </div>
          ) : (
            store.publishRecords.map((record) => (
              <article className="automatic-record" key={record.publishId}>
                <div>
                  <h2>{record.title}</h2>
                  <small>{formatDateTime(record.submittedAt)}</small>
                  <p>{record.message}</p>
                </div>
                <span>
                  {{ publishing: '发布中', published: '已发布', failed: '发布失败' }[record.state]}
                </span>
                {record.articleUrl && /^https?:\/\//i.test(record.articleUrl) && (
                  <a href={record.articleUrl} target="_blank" rel="noreferrer">
                    查看文章
                  </a>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => void refresh(record)}
                >
                  <RefreshCw size={15} />
                  {busyId === record.publishId ? '查询中' : '刷新状态'}
                </Button>
              </article>
            ))
          )}
        </>
      )}
      {view === 'trash' && (
        <>
          <p className="automatic-description">
            删除的文章和子页面保留在这里，可随时恢复。永久删除后无法找回。
          </p>
          {trashed.length === 0 ? (
            <div className="automatic-empty">
              <Trash2 size={30} />
              <h2>回收站是空的</h2>
              <p>继续放心创作，删除的文章会保留在这里。</p>
            </div>
          ) : (
            trashed.map((doc) => (
              <article className="automatic-record" key={doc.id}>
                <div>
                  <h2>{doc.title || '未命名文章'}</h2>
                  <small>删除于 {formatDateTime(doc.deletedAt!)}</small>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => store.restoreDoc(doc.id)}
                >
                  <Undo2 size={15} />
                  恢复
                </Button>
                {confirmId === doc.id ? (
                  <>
                    <span>同时永久删除子页面？</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      onClick={() => {
                        store.permanentlyDeleteDoc(doc.id);
                        setConfirmId(null);
                      }}
                    >
                      确认删除
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      onClick={() => setConfirmId(null)}
                    >
                      取消
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={() => setConfirmId(doc.id)}
                  >
                    永久删除
                  </Button>
                )}
              </article>
            ))
          )}
        </>
      )}
      {view === 'pro' && (
        <div className="automatic-plan">
          <span className="automatic-eyebrow">当前版本</span>
          <h2>AutoMatic Beta</h2>
          <p>文章编辑、模板、素材管理与公众号发布现已可用。</p>
          <p>
            本账户有 {active.length} 篇文章，保存后可在其他设备登录查看，文档数据约{' '}
            {(new Blob([JSON.stringify(store.docs)]).size / 1024).toFixed(1)} KB。
          </p>
          <p>Pro 方案尚未开放购买，价格与扩容额度将在上线时公布。</p>
          <Button variant="ghost" size="sm" type="button" onClick={() => onNavigate('home')}>
            返回我的工作区
          </Button>
        </div>
      )}
    </section>
  );
}
