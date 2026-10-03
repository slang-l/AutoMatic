import { Button } from '@/components/ui/button';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import {
  ChevronRight,
  Images,
  LibraryBig,
  LogOut,
  Menu,
  Moon,
  MoreHorizontal,
  PanelRight,
  Plus,
  Settings,
  Sun,
} from 'lucide-react';
import type { AuthUser } from '../../services/auth-api';
import { useDocsStore } from '../../store/docsStore';
import { EditorColumn } from '../editor/EditorColumn';
import { WeChatPreview } from '../preview/WeChatPreview';
import { SettingsModal } from '../settings';
import { WorkspacePanel } from '../sidebar/WorkspacePanel';
import { viewLabels, type WorkspaceView } from '../sidebar/DocumentSidebar';
import { DocumentSidebar } from '../sidebar/DocumentSidebar';

type ResizeEdge = 'sidebar' | 'preview';

interface PanelWidths {
  sidebar: number;
  preview: number;
}

const SIDEBAR_WIDTH_STORAGE_KEY = 'block-notes-sidebar-width-v1';
const PREVIEW_WIDTH_STORAGE_KEY = 'block-notes-preview-width-v1';
const THREE_PANE_QUERY = '(min-width: 1001px)';
const RESIZE_HANDLE_WIDTH = 8;
const KEYBOARD_RESIZE_STEP = 20;
const MIN_EDITOR_WIDTH = 420;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;
const MIN_PREVIEW_WIDTH = 320;
const MAX_PREVIEW_WIDTH = 760;
const DEFAULT_SIDEBAR_WIDTH = 240;
const DEFAULT_PREVIEW_WIDTH = 388;

interface AppLayoutProps {
  isSigningOut: boolean;
  onSignOut: () => void | Promise<void>;
  user: AuthUser;
}

export function AppLayout({ isSigningOut, onSignOut, user }: AppLayoutProps) {
  const allDocs = useDocsStore((state) => state.docs);
  const docs = allDocs.filter((doc) => !doc.deletedAt);
  const [view, setView] = useState<WorkspaceView>('editor');
  const openEditor = () => {
    setView('editor');
    if (window.matchMedia('(max-width: 760px)').matches) setSidebarOpen(false);
  };
  const currentDocId = useDocsStore((state) => state.currentDocId);
  const currentDoc = docs.find((doc) => doc.id === currentDocId) ?? docs[0];
  const createDoc = useDocsStore((state) => state.createDoc);
  const shellRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{
    edge: ResizeEdge;
    pointerId: number;
    startX: number;
    startWidths: PanelWidths;
  } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(true);
  const [componentLibraryOpen, setComponentLibraryOpen] = useState(false);
  const [brandAssetLibraryOpen, setBrandAssetLibraryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [activeResize, setActiveResize] = useState<ResizeEdge | null>(null);
  const [panelWidths, setPanelWidths] = useState<PanelWidths>(() => ({
    sidebar: clamp(
      readStoredWidth(SIDEBAR_WIDTH_STORAGE_KEY, DEFAULT_SIDEBAR_WIDTH),
      MIN_SIDEBAR_WIDTH,
      MAX_SIDEBAR_WIDTH,
    ),
    preview: clamp(
      readStoredWidth(PREVIEW_WIDTH_STORAGE_KEY, DEFAULT_PREVIEW_WIDTH),
      MIN_PREVIEW_WIDTH,
      MAX_PREVIEW_WIDTH,
    ),
  }));

  useEffect(() => {
    if (!accountMenuOpen) return undefined;

    const closeMenu = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setAccountMenuOpen(false);
      }
    };

    window.addEventListener('mousedown', closeMenu);
    return () => window.removeEventListener('mousedown', closeMenu);
  }, [accountMenuOpen]);

  useEffect(() => {
    const closeOverlay = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setComponentLibraryOpen(false);
      setBrandAssetLibraryOpen(false);
      setAccountMenuOpen(false);
    };

    window.addEventListener('keydown', closeOverlay);
    return () => window.removeEventListener('keydown', closeOverlay);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(panelWidths.sidebar)));
    window.localStorage.setItem(PREVIEW_WIDTH_STORAGE_KEY, String(Math.round(panelWidths.preview)));
  }, [panelWidths]);

  useEffect(() => {
    const fitPanelsToViewport = () => {
      if (!window.matchMedia(THREE_PANE_QUERY).matches) return;

      const availableWidth = shellRef.current?.clientWidth ?? window.innerWidth;
      setPanelWidths((current) =>
        fitPanelWidths(current, availableWidth, sidebarOpen, previewOpen),
      );
    };

    fitPanelsToViewport();
    window.addEventListener('resize', fitPanelsToViewport);
    return () => window.removeEventListener('resize', fitPanelsToViewport);
  }, [previewOpen, sidebarOpen]);

  useEffect(() => {
    if (!activeResize) return undefined;

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [activeResize]);

  const resizeByDelta = useCallback(
    (edge: ResizeEdge, startWidths: PanelWidths, delta: number): PanelWidths => {
      const availableWidth = shellRef.current?.clientWidth ?? window.innerWidth;

      if (edge === 'sidebar') {
        const previewSpace =
          previewOpen && window.matchMedia(THREE_PANE_QUERY).matches
            ? startWidths.preview + RESIZE_HANDLE_WIDTH
            : 0;
        const maxWidth = Math.max(
          MIN_SIDEBAR_WIDTH,
          Math.min(
            MAX_SIDEBAR_WIDTH,
            availableWidth - MIN_EDITOR_WIDTH - previewSpace - RESIZE_HANDLE_WIDTH,
          ),
        );

        return {
          ...startWidths,
          sidebar: clamp(startWidths.sidebar + delta, MIN_SIDEBAR_WIDTH, maxWidth),
        };
      }

      const sidebarSpace = sidebarOpen ? startWidths.sidebar + RESIZE_HANDLE_WIDTH : 0;
      const maxWidth = Math.max(
        MIN_PREVIEW_WIDTH,
        Math.min(
          MAX_PREVIEW_WIDTH,
          availableWidth - MIN_EDITOR_WIDTH - sidebarSpace - RESIZE_HANDLE_WIDTH,
        ),
      );

      return {
        ...startWidths,
        preview: clamp(startWidths.preview - delta, MIN_PREVIEW_WIDTH, maxWidth),
      };
    },
    [previewOpen, sidebarOpen],
  );

  const beginResize = useCallback(
    (edge: ResizeEdge, event: PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      resizeRef.current = {
        edge,
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidths: panelWidths,
      };
      setActiveResize(edge);
    },
    [panelWidths],
  );

  const updateResize = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const resizeState = resizeRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;

      event.preventDefault();
      setPanelWidths(
        resizeByDelta(
          resizeState.edge,
          resizeState.startWidths,
          event.clientX - resizeState.startX,
        ),
      );
    },
    [resizeByDelta],
  );

  const endResize = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const resizeState = resizeRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resizeRef.current = null;
    setActiveResize(null);
  }, []);

  const resizeWithKeyboard = useCallback(
    (edge: ResizeEdge, event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const multiplier = event.shiftKey ? 4 : 1;
      event.preventDefault();
      setPanelWidths((current) =>
        resizeByDelta(edge, current, direction * KEYBOARD_RESIZE_STEP * multiplier),
      );
    },
    [resizeByDelta],
  );

  if (!currentDoc) {
    return null;
  }

  const displayTitle =
    view === 'editor' ? currentDoc.title.trim() || '未命名文章' : viewLabels[view];
  const userInitials = getUserInitials(user);

  return (
    <>
      <main
        ref={shellRef}
        className={`workspace-shell ${darkMode ? 'workspace-dark' : ''} ${activeResize ? 'is-resizing' : ''}`}
      >
        <Button
          variant="ghost"
          size="icon"
          className={`workspace-sidebar-backdrop ${sidebarOpen ? 'is-visible' : ''}`}
          type="button"
          aria-label="关闭侧边栏"
          onClick={() => setSidebarOpen(false)}
        />

        <div
          className={`workspace-sidebar-layer ${sidebarOpen ? 'is-open' : ''}`}
          style={
            sidebarOpen ? { width: panelWidths.sidebar, minWidth: panelWidths.sidebar } : undefined
          }
        >
          <DocumentSidebar
            view={view}
            assetsOpen={brandAssetLibraryOpen}
            onNavigate={(next) => {
              setView(next);
              if (window.matchMedia('(max-width: 760px)').matches) setSidebarOpen(false);
            }}
            onOpenAssets={() => {
              openEditor();
              setBrandAssetLibraryOpen(true);
              setComponentLibraryOpen(false);
            }}
            currentDocId={currentDoc.id}
            onSearchOpen={() => setSidebarOpen(true)}
            docs={docs}
            onDocumentOpen={openEditor}
            onOpenSettings={() => setSettingsOpen(true)}
            userName={user.name}
            userInitials={userInitials}
          />
        </div>

        {sidebarOpen ? (
          <ResizeHandle
            active={activeResize === 'sidebar'}
            edge="sidebar"
            label="调整文档栏和编辑区宽度"
            value={panelWidths.sidebar}
            min={MIN_SIDEBAR_WIDTH}
            max={MAX_SIDEBAR_WIDTH}
            onKeyDown={resizeWithKeyboard}
            onPointerCancel={endResize}
            onPointerDown={beginResize}
            onPointerMove={updateResize}
            onPointerUp={endResize}
          />
        ) : null}

        <section className="workspace-main">
          <header className="workspace-topbar">
            <div className="workspace-breadcrumb-wrap">
              <Button
                variant="ghost"
                size="icon"
                className="workspace-icon-button"
                type="button"
                aria-label={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
                title={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
                onClick={() => setSidebarOpen((open) => !open)}
              >
                <Menu size={18} strokeWidth={1.7} />
              </Button>
              <nav className="workspace-breadcrumb" aria-label="面包屑导航">
                <span>工作区</span>
                <ChevronRight size={14} aria-hidden="true" />
                <strong title={displayTitle}>{displayTitle}</strong>
              </nav>
            </div>

            <div className="workspace-actions">
              <Button
                variant="ghost"
                size="icon"
                className="workspace-component-button"
                type="button"
                aria-haspopup="dialog"
                aria-expanded={componentLibraryOpen}
                aria-label="组件库"
                title="组件库"
                onClick={() => {
                  openEditor();
                  setBrandAssetLibraryOpen(false);
                  setComponentLibraryOpen(true);
                }}
              >
                <LibraryBig size={15} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="workspace-component-button"
                type="button"
                aria-haspopup="dialog"
                aria-expanded={brandAssetLibraryOpen}
                aria-label="素材库"
                title="素材库"
                onClick={() => {
                  openEditor();
                  setComponentLibraryOpen(false);
                  setBrandAssetLibraryOpen(true);
                }}
              >
                <Images size={15} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="workspace-theme-button"
                type="button"
                aria-pressed={darkMode}
                aria-label={darkMode ? '切换浅色模式' : '切换深色模式'}
                title={darkMode ? '切换浅色模式' : '切换深色模式'}
                onClick={() => setDarkMode((active) => !active)}
              >
                {darkMode ? <Sun size={15} /> : <Moon size={15} />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={`workspace-preview-button ${previewOpen ? 'is-active' : ''}`}
                type="button"
                aria-controls="workspace-preview-pane"
                aria-expanded={previewOpen}
                aria-label={previewOpen ? '关闭预览' : '打开预览'}
                title={previewOpen ? '关闭预览' : '打开预览'}
                onClick={() => setPreviewOpen((open) => !open)}
              >
                <PanelRight size={15} />
              </Button>

              <div ref={menuRef} className="workspace-account-menu-wrap">
                <Button
                  variant="ghost"
                  size="icon"
                  className="workspace-icon-button"
                  type="button"
                  aria-label="更多操作"
                  title="更多操作"
                  aria-expanded={accountMenuOpen}
                  onClick={() => setAccountMenuOpen((open) => !open)}
                >
                  <MoreHorizontal size={18} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="workspace-avatar"
                  type="button"
                  aria-label={`${user.name} 的账户菜单`}
                  aria-expanded={accountMenuOpen}
                  onClick={() => setAccountMenuOpen((open) => !open)}
                >
                  {userInitials}
                </Button>

                {accountMenuOpen ? (
                  <div className="workspace-account-menu" role="menu">
                    <div className="workspace-account-summary">
                      <span className="workspace-account-avatar">{userInitials}</span>
                      <span>
                        <strong>{user.name}</strong>
                        <small>{user.email}</small>
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        createDoc();
                        openEditor();
                        setAccountMenuOpen(false);
                      }}
                    >
                      <Plus size={15} />
                      新建文章
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setSettingsOpen(true);
                        setAccountMenuOpen(false);
                      }}
                    >
                      <Settings size={15} />
                      设置
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="is-danger"
                      type="button"
                      role="menuitem"
                      disabled={isSigningOut}
                      onClick={onSignOut}
                    >
                      <LogOut size={15} />
                      {isSigningOut ? '正在退出…' : '退出登录'}
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          </header>
          {view !== 'editor' && (
            <WorkspacePanel view={view} onOpenDocument={openEditor} onNavigate={setView} />
          )}
          <div
            className="workspace-content"
            style={view !== 'editor' ? { display: 'none' } : undefined}
          >
            <div className="workspace-editor-area">
              <EditorColumn
                brandAssetLibraryOpen={brandAssetLibraryOpen}
                componentLibraryOpen={componentLibraryOpen}
                doc={currentDoc}
                onBrandAssetLibraryOpenChange={setBrandAssetLibraryOpen}
                onComponentLibraryOpenChange={setComponentLibraryOpen}
              />
              <Button
                variant="ghost"
                size="icon"
                className="workspace-help-button"
                type="button"
                onClick={() => setView('start')}
                aria-label="帮助"
                title="帮助"
              >
                ?
              </Button>
            </div>
          </div>
        </section>

        <div
          className="workspace-preview-layer"
          style={view !== 'editor' ? { display: 'none' } : undefined}
        >
          {previewOpen ? (
            <>
              <ResizeHandle
                active={activeResize === 'preview'}
                edge="preview"
                label="调整编辑区和预览区宽度"
                value={panelWidths.preview}
                min={MIN_PREVIEW_WIDTH}
                max={MAX_PREVIEW_WIDTH}
                onKeyDown={resizeWithKeyboard}
                onPointerCancel={endResize}
                onPointerDown={beginResize}
                onPointerMove={updateResize}
                onPointerUp={endResize}
              />
              <section
                id="workspace-preview-pane"
                className="workspace-preview-pane"
                aria-label="文章分享预览"
                style={{ width: panelWidths.preview, flexBasis: panelWidths.preview }}
              >
                <WeChatPreview
                  doc={currentDoc}
                  userId={user.id}
                  onClose={() => setPreviewOpen(false)}
                />
              </section>
            </>
          ) : null}
        </div>
      </main>

      <SettingsModal
        appName="Block Notes"
        appVersion="0.1.0"
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onSignOut={onSignOut}
        user={user}
      />
    </>
  );
}

interface ResizeHandleProps {
  active: boolean;
  edge: ResizeEdge;
  label: string;
  value: number;
  min: number;
  max: number;
  onKeyDown: (edge: ResizeEdge, event: KeyboardEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerDown: (edge: ResizeEdge, event: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
}

function ResizeHandle({
  active,
  edge,
  label,
  value,
  min,
  max,
  onKeyDown,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: ResizeHandleProps) {
  return (
    <div
      className={`workspace-resize-handle workspace-${edge}-resizer ${active ? 'is-active' : ''}`}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      onKeyDown={(event) => onKeyDown(edge, event)}
      onPointerCancel={onPointerCancel}
      onPointerDown={(event) => onPointerDown(edge, event)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}

function readStoredWidth(key: string, fallback: number) {
  if (typeof window === 'undefined') return fallback;

  const storedValue = Number(window.localStorage.getItem(key));
  return Number.isFinite(storedValue) && storedValue > 0 ? storedValue : fallback;
}

function fitPanelWidths(
  widths: PanelWidths,
  availableWidth: number,
  sidebarOpen: boolean,
  previewOpen: boolean,
): PanelWidths {
  let sidebar = clamp(widths.sidebar, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
  let preview = clamp(widths.preview, MIN_PREVIEW_WIDTH, MAX_PREVIEW_WIDTH);
  const handleWidth =
    Number(sidebarOpen) * RESIZE_HANDLE_WIDTH + Number(previewOpen) * RESIZE_HANDLE_WIDTH;
  const sidePanelBudget = Math.max(0, availableWidth - MIN_EDITOR_WIDTH - handleWidth);

  if (sidebarOpen && previewOpen && sidebar + preview > sidePanelBudget) {
    preview = Math.max(MIN_PREVIEW_WIDTH, sidePanelBudget - sidebar);
    sidebar = Math.max(MIN_SIDEBAR_WIDTH, sidePanelBudget - preview);
  } else if (sidebarOpen && sidebar > sidePanelBudget) {
    sidebar = Math.max(MIN_SIDEBAR_WIDTH, sidePanelBudget);
  } else if (previewOpen && preview > sidePanelBudget) {
    preview = Math.max(MIN_PREVIEW_WIDTH, sidePanelBudget);
  }

  return { sidebar, preview };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getUserInitials(user: AuthUser): string {
  const displayName = user.name.trim() || user.email.split('@')[0] || 'U';
  const words = displayName.split(/\s+/).filter(Boolean);

  if (words.length > 1) {
    return words
      .slice(0, 2)
      .map((word) => Array.from(word)[0])
      .join('')
      .toUpperCase();
  }

  return Array.from(displayName).slice(0, 2).join('').toUpperCase();
}
