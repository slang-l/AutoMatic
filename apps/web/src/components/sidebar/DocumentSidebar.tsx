import {
  Home,
  Image,
  PanelsTopLeft,
  PencilLine,
  Plus,
  Search,
  Send,
  Settings,
  Trash2,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDocsStore } from '../../store/docsStore';
import type { AppDoc } from '../../types/document';
import { PageTree } from './PageTree';
import { buildPageTree } from './page-tree-data';
export type WorkspaceView = 'editor' | 'home' | 'start' | 'templates' | 'history' | 'trash' | 'pro';
export const viewLabels: Record<WorkspaceView, string> = {
  editor: '文章创作',
  home: '首页',
  start: '快速开始',
  templates: '模板中心',
  history: '发布记录',
  trash: '回收站',
  pro: '版本与空间',
};
interface Props {
  docs: AppDoc[];
  currentDocId: string;
  view: WorkspaceView;
  onNavigate: (view: WorkspaceView) => void;
  onDocumentOpen: () => void;
  onOpenSettings: () => void;
  onOpenAssets: () => void;
  onSearchOpen: () => void;
  assetsOpen: boolean;
  userName: string;
  userInitials: string;
}
export function DocumentSidebar({
  docs,
  currentDocId,
  view,
  onNavigate,
  onDocumentOpen,
  onOpenSettings,
  onOpenAssets,
  onSearchOpen,
  assetsOpen,
  userName,
  userInitials,
}: Props) {
  const store = useDocsStore();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const tree = useMemo(() => buildPageTree(docs), [docs]);
  const create = (parentId?: string) => {
    store.createDoc(parentId);
    setQuery('');
    onDocumentOpen();
  };
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        onSearchOpen();
        window.requestAnimationFrame(() => {
          searchRef.current?.focus();
          searchRef.current?.select();
        });
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [onSearchOpen]);
  const nav = (id: WorkspaceView, Icon: typeof Home) => (
    <button
      type="button"
      className={'automatic-nav ' + (view === id && !assetsOpen ? 'is-active' : '')}
      aria-current={view === id && !assetsOpen ? 'page' : undefined}
      onClick={() => onNavigate(id)}
    >
      <Icon size={18} strokeWidth={1.5} />
      <span>{viewLabels[id]}</span>
    </button>
  );
  return (
    <aside className="notion-sidebar automatic-sidebar" aria-label="工作区导航">
      <header className="automatic-brand">
        <span className="automatic-logo">A</span>
        <strong>AutoMatic</strong>
        <span className="automatic-beta">Beta</span>
      </header>
      <label className="automatic-search">
        <Search size={15} />
        <input
          ref={searchRef}
          type="search"
          placeholder="搜索文档"
          aria-label="搜索文档"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setQuery('');
          }}
        />
        <kbd>{navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl K'}</kbd>
      </label>
      <nav className="automatic-nav-group" aria-label="开始">
        {nav('home', Home)}
        {nav('start', Zap)}
        {nav('editor', PencilLine)}
        <button
          type="button"
          className={'automatic-nav ' + (assetsOpen ? 'is-active' : '')}
          aria-current={assetsOpen ? 'page' : undefined}
          onClick={onOpenAssets}
        >
          <Image size={18} strokeWidth={1.5} />
          <span>素材库</span>
        </button>
        {nav('templates', PanelsTopLeft)}
        {nav('history', Send)}
      </nav>
      <section className="notion-sidebar-pages">
        <header className="notion-sidebar-pages-header">
          <span>工作区</span>
          <button type="button" aria-label="新建文章" title="新建文章" onClick={() => create()}>
            <Plus size={16} />
          </button>
        </header>
        <div className="notion-sidebar-tree-scroll">
          <PageTree
            nodes={tree}
            query={query}
            selectedId={view === 'editor' ? currentDocId : ''}
            onAddChild={(node) => create(node.id)}
            onSelect={(node) => {
              store.setCurrentDocId(node.id);
              onDocumentOpen();
            }}
          />
        </div>
      </section>
      <footer className="automatic-account-footer">
        {nav('trash', Trash2)}
        <div className="automatic-user-row">
          <span className="automatic-user-avatar" aria-hidden="true">
            {userInitials}
          </span>
          <span className="automatic-user-name" title={userName}>
            {userName}
          </span>
          <button
            type="button"
            className="automatic-user-settings"
            aria-label="设置"
            title="设置"
            onClick={onOpenSettings}
          >
            <Settings size={15} strokeWidth={1.6} />
          </button>
        </div>
      </footer>
      {/* <footer className="automatic-footer">
        <div className="automatic-upgrade">
          <strong>升级到专业版</strong>
          <p>解锁更多功能 · 更大的存储空间</p>
          <button type="button" onClick={() => onNavigate('pro')}>
            查看升级方案
          </button>
        </div>
        <button className="automatic-settings" type="button" onClick={onOpenSettings}>
          <Settings size={14} />
          设置
        </button>
      </footer> */}
    </aside>
  );
}
