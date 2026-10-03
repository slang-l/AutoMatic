import {
  Check,
  CheckCircle2,
  Code2,
  Copy,
  Monitor,
  Palette,
  Send,
  SlidersHorizontal,
  Smartphone,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Toast, type ToastState } from '../common/Toast';
import { PublishModal } from '../publish/PublishModal';
import { renderMarkdown } from '../../renderers/markdown-renderer';
import { renderWechatHtml } from '../../renderers/wechat-renderer';
import {
  createDefaultVisualThemeSettings,
  createVisualWechatTheme,
  type VisualThemeSettings,
} from '../../renderers/visual-theme';
import {
  defaultWechatThemeId,
  getWechatTheme,
  wechatThemes,
  type WechatThemeId,
} from '../../renderers/wechat-themes';
import type { AppDoc } from '../../types/document';
import { copyRichHtmlToClipboard, copyToClipboard } from '../../utils/clipboard';
import { VisualThemeEditor } from './VisualThemeEditor';
import {
  MAX_SAVED_VISUAL_THEMES,
  createInitialActiveTheme,
  loadVisualThemeWorkspace,
  parseImportedVisualTheme,
  saveVisualThemeWorkspace,
  serializeVisualTheme,
  type SavedVisualTheme,
} from './visual-theme-storage';

type PreviewMode = 'desktop' | 'mobile';

interface WeChatPreviewProps {
  doc: AppDoc;
  onClose?: () => void;
  userId: string;
}

export function WeChatPreview({ doc, onClose, userId }: WeChatPreviewProps) {
  const [themeWorkspace, setThemeWorkspace] = useState(() => loadVisualThemeWorkspace(userId));
  const [toast, setToast] = useState<ToastState>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [previewMode, setPreviewMode] = useState<PreviewMode>('desktop');
  const [themeEditorOpen, setThemeEditorOpen] = useState(false);
  const [savingTheme, setSavingTheme] = useState(false);
  const themePopoverRef = useRef<HTMLDivElement>(null);
  const themeTriggerRef = useRef<HTMLButtonElement>(null);

  const closeThemeEditor = useCallback(() => {
    setThemeEditorOpen(false);
    themeTriggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!themeEditorOpen) return;
    themePopoverRef.current?.focus();
    const handleOutsideClick = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (
        !themePopoverRef.current?.contains(event.target) &&
        !themeTriggerRef.current?.contains(event.target)
      ) {
        setThemeEditorOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeThemeEditor();
    };
    document.addEventListener('pointerdown', handleOutsideClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('pointerdown', handleOutsideClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [themeEditorOpen, closeThemeEditor]);
  const theme = useMemo(
    () =>
      themeWorkspace.active
        ? createVisualWechatTheme(themeWorkspace.active.baseThemeId, themeWorkspace.active.settings)
        : getWechatTheme(themeWorkspace.themeId),
    [themeWorkspace.active, themeWorkspace.themeId],
  );
  const activeThemeDirty = useMemo(() => {
    const active = themeWorkspace.active;
    if (!active) return false;
    const saved = active.savedId
      ? themeWorkspace.savedThemes.find((item) => item.id === active.savedId)
      : undefined;
    return (
      !saved ||
      saved.name !== active.name.trim().replace(/\s+/g, ' ') ||
      saved.baseThemeId !== active.baseThemeId ||
      JSON.stringify(saved.settings) !== JSON.stringify(active.settings)
    );
  }, [themeWorkspace.active, themeWorkspace.savedThemes]);
  const html = useMemo(() => renderWechatHtml(doc, theme), [doc, theme]);
  const publishHtml = useMemo(
    () => renderWechatHtml(doc, theme, { includePreviewFooter: false }),
    [doc, theme],
  );
  const markdown = useMemo(() => renderMarkdown(doc), [doc]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 1800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const notify = useCallback((message: string, tone: 'success' | 'error' = 'success') => {
    setToast({ message, tone });
  }, []);

  useEffect(() => {
    try {
      saveVisualThemeWorkspace(userId, themeWorkspace);
    } catch {
      notify('主题保存空间不足，请删除不再使用的主题', 'error');
    }
  }, [notify, themeWorkspace, userId]);

  const handleCopyText = useCallback(
    async (value: string, label: string) => {
      try {
        await copyToClipboard(value);
        notify(`${label}已复制`);
      } catch {
        notify(`${label}复制失败`, 'error');
      }
    },
    [notify],
  );

  const handleCopyToWechat = useCallback(async () => {
    try {
      await copyRichHtmlToClipboard(html);
      notify('已复制富文本，可直接粘贴到公众号');
    } catch {
      notify('富文本复制失败，请检查剪贴板权限', 'error');
    }
  }, [html, notify]);

  const selectBuiltinTheme = (themeId: WechatThemeId) => {
    setThemeWorkspace((current) => ({
      ...current,
      themeId,
      active: createInitialActiveTheme(themeId),
    }));
  };

  const selectSavedTheme = (savedTheme: SavedVisualTheme) => {
    setThemeWorkspace((current) => ({
      ...current,
      themeId: savedTheme.baseThemeId,
      active: {
        baseThemeId: savedTheme.baseThemeId,
        name: savedTheme.name,
        savedId: savedTheme.id,
        settings: { ...savedTheme.settings },
      },
    }));
  };

  const openThemeEditor = () => {
    if (themeEditorOpen) {
      setThemeEditorOpen(false);
      return;
    }
    setThemeWorkspace((current) =>
      current.active ? current : { ...current, active: createInitialActiveTheme(current.themeId) },
    );
    setThemeEditorOpen(true);
  };

  const updateActiveSettings = (settings: VisualThemeSettings) => {
    setThemeWorkspace((current) =>
      current.active ? { ...current, active: { ...current.active, settings } } : current,
    );
  };

  const changeBaseTheme = (baseThemeId: WechatThemeId) => {
    setThemeWorkspace((current) => ({
      ...current,
      themeId: baseThemeId,
      active: {
        ...(current.active ?? createInitialActiveTheme(baseThemeId)),
        baseThemeId,
        settings: createDefaultVisualThemeSettings(baseThemeId),
      },
    }));
  };

  const saveActiveTheme = () => {
    const active = themeWorkspace.active;
    if (!active || !active.name.trim()) return;
    if (!active.savedId && themeWorkspace.savedThemes.length >= MAX_SAVED_VISUAL_THEMES) {
      notify(`最多保存 ${MAX_SAVED_VISUAL_THEMES} 个自定义主题`, 'error');
      return;
    }

    setSavingTheme(true);
    const now = new Date().toISOString();
    setThemeWorkspace((current) => {
      if (!current.active) return current;
      const normalizedName = current.active.name.trim().replace(/\s+/g, ' ').slice(0, 40);
      const existing = current.active.savedId
        ? current.savedThemes.find((item) => item.id === current.active?.savedId)
        : undefined;
      const savedTheme: SavedVisualTheme = {
        id: existing?.id ?? crypto.randomUUID(),
        name: normalizedName,
        baseThemeId: current.active.baseThemeId,
        settings: { ...current.active.settings },
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      return {
        ...current,
        themeId: savedTheme.baseThemeId,
        active: {
          baseThemeId: savedTheme.baseThemeId,
          name: savedTheme.name,
          savedId: savedTheme.id,
          settings: { ...savedTheme.settings },
        },
        savedThemes: [
          savedTheme,
          ...current.savedThemes.filter((item) => item.id !== savedTheme.id),
        ],
      };
    });
    window.setTimeout(() => setSavingTheme(false), 180);
    notify(active.savedId ? '主题已更新' : '主题已保存');
  };

  const deleteActiveTheme = () => {
    const active = themeWorkspace.active;
    if (!active?.savedId) return;
    setThemeWorkspace((current) => ({
      ...current,
      themeId: active.baseThemeId,
      active: null,
      savedThemes: current.savedThemes.filter((item) => item.id !== active.savedId),
    }));
    setThemeEditorOpen(false);
    notify('主题已删除');
  };

  const exportActiveTheme = () => {
    const active = themeWorkspace.active;
    if (!active) return;
    const blob = new Blob([serializeVisualTheme(active)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeFilename(active.name)}.automatic-theme.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    notify('主题文件已导出');
  };

  const importTheme = async (file: File) => {
    if (file.size > 100_000) {
      notify('主题文件不能超过 100 KB', 'error');
      return;
    }
    if (themeWorkspace.savedThemes.length >= MAX_SAVED_VISUAL_THEMES) {
      notify(`最多保存 ${MAX_SAVED_VISUAL_THEMES} 个自定义主题`, 'error');
      return;
    }

    try {
      const imported = parseImportedVisualTheme(await file.text());
      const now = new Date().toISOString();
      const savedTheme: SavedVisualTheme = {
        ...imported,
        id: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
      };
      setThemeWorkspace((current) => ({
        ...current,
        themeId: savedTheme.baseThemeId,
        active: {
          baseThemeId: savedTheme.baseThemeId,
          name: savedTheme.name,
          savedId: savedTheme.id,
          settings: { ...savedTheme.settings },
        },
        savedThemes: [savedTheme, ...current.savedThemes],
      }));
      notify('主题已导入');
    } catch (error) {
      notify(error instanceof Error ? error.message : '主题导入失败', 'error');
    }
  };

  return (
    <>
      <Toast toast={toast} />
      <aside className="preview-pane flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--ui-surface-subtle)]">
        <header className="preview-toolbar">
          <div className="preview-heading flex min-w-0 items-center gap-2.5">
            <div className="min-w-0">
              <h2 className="m-0 truncate text-[12px] font-medium text-[var(--ui-text)]">
                微信预览
              </h2>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <div
              className="preview-device-switch flex shrink-0 items-center rounded-[5px] bg-[var(--ui-subtle)] p-0.5"
              aria-label="预览设备"
            >
              <DeviceButton
                active={previewMode === 'desktop'}
                label="桌面预览"
                icon={<Monitor size={15} />}
                onClick={() => setPreviewMode('desktop')}
              />
              <DeviceButton
                active={previewMode === 'mobile'}
                label="手机预览"
                icon={<Smartphone size={15} />}
                onClick={() => setPreviewMode('mobile')}
              />
            </div>
          </div>
          <div className="preview-actions flex max-w-full shrink-0 items-center justify-end gap-2">
            <ActionButton
              icon={<Copy size={15} />}
              label="复制到微信"
              onClick={handleCopyToWechat}
            />
            <ActionButton
              icon={<Code2 size={15} />}
              label="复制 Markdown"
              onClick={() => handleCopyText(markdown, 'Markdown')}
            />
            <ActionButton
              icon={<Send size={15} />}
              label="一键发布"
              primary
              onClick={() => setPublishOpen(true)}
            />
          </div>
          <button
            className={`preview-theme-editor-trigger ${themeEditorOpen ? 'is-active' : ''}`}
            ref={themeTriggerRef}
            aria-haspopup="dialog"
            type="button"
            aria-controls="preview-settings-popover"
            aria-expanded={themeEditorOpen}
            aria-label="可视化配置"
            title="可视化配置"
            onClick={openThemeEditor}
          >
            <SlidersHorizontal size={15} />
          </button>
          {onClose ? (
            <button
              className="preview-pane-close ui-pressable"
              type="button"
              aria-label="关闭预览"
              title="关闭预览"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          ) : null}
        </header>

        {themeEditorOpen && themeWorkspace.active ? (
          <div
            id="preview-settings-popover"
            ref={themePopoverRef}
            className="preview-settings-popover"
            role="dialog"
            aria-label="可视化配置"
            tabIndex={-1}
          >
            <VisualThemeEditor
              themeSelector={
                <div className="preview-theme-picker">
                  <div className="flex shrink-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--ui-text-muted)]">
                    <Palette size={14} />
                    主题
                  </div>
                  <div className="preview-theme-list flex min-w-0 flex-wrap gap-1.5">
                    {wechatThemes.map((themeOption) => {
                      const active =
                        !themeWorkspace.active?.savedId &&
                        themeOption.id === themeWorkspace.themeId;

                      return (
                        <button
                          key={themeOption.id}
                          className={`ui-pressable flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] border px-2.5 text-xs ${
                            active
                              ? 'border-[var(--ui-accent-border)] bg-[var(--ui-accent-soft)] font-medium text-[var(--ui-accent)]'
                              : 'border-[var(--ui-line)] bg-[var(--ui-surface)] text-[var(--ui-text-secondary)] hover:border-[var(--ui-line-strong)] hover:bg-[var(--ui-subtle)]'
                          }`}
                          type="button"
                          title={themeOption.description}
                          aria-pressed={active}
                          onClick={() => selectBuiltinTheme(themeOption.id)}
                        >
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-sm border border-black/10"
                            style={{ backgroundColor: themeOption.swatch }}
                            aria-hidden="true"
                          />
                          {themeOption.label}
                          <span className="grid h-3 w-3 place-items-center">
                            {active ? <Check size={11} /> : null}
                          </span>
                        </button>
                      );
                    })}
                    {themeWorkspace.savedThemes.map((savedTheme) => {
                      const active = themeWorkspace.active?.savedId === savedTheme.id;
                      return (
                        <button
                          key={savedTheme.id}
                          className={`ui-pressable flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] border px-2.5 text-xs ${
                            active
                              ? 'border-[var(--ui-accent-border)] bg-[var(--ui-accent-soft)] font-medium text-[var(--ui-accent)]'
                              : 'border-[var(--ui-line)] bg-[var(--ui-surface)] text-[var(--ui-text-secondary)] hover:border-[var(--ui-line-strong)] hover:bg-[var(--ui-subtle)]'
                          }`}
                          type="button"
                          aria-pressed={active}
                          title={savedTheme.name}
                          onClick={() => selectSavedTheme(savedTheme)}
                        >
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-sm border border-black/10"
                            style={{ backgroundColor: savedTheme.settings.accentColor }}
                          />
                          <span className="max-w-24 truncate">{savedTheme.name}</span>
                          <span className="grid h-3 w-3 place-items-center">
                            {active ? <Check size={11} /> : null}
                          </span>
                        </button>
                      );
                    })}
                    {themeWorkspace.active && activeThemeDirty ? (
                      <span className="preview-unsaved-theme">
                        <span
                          style={{ backgroundColor: themeWorkspace.active.settings.accentColor }}
                        />
                        {themeWorkspace.active.savedId ? '有更改' : '未保存'}
                      </span>
                    ) : null}
                  </div>
                </div>
              }
              active={themeWorkspace.active}
              dirty={activeThemeDirty}
              savedCount={themeWorkspace.savedThemes.length}
              saving={savingTheme}
              onBaseChange={changeBaseTheme}
              onChange={updateActiveSettings}
              onClose={closeThemeEditor}
              onDelete={themeWorkspace.active.savedId ? deleteActiveTheme : undefined}
              onExport={exportActiveTheme}
              onImport={importTheme}
              onNameChange={(name) =>
                setThemeWorkspace((current) =>
                  current.active ? { ...current, active: { ...current.active, name } } : current,
                )
              }
              onReset={() =>
                updateActiveSettings(
                  createDefaultVisualThemeSettings(
                    themeWorkspace.active?.baseThemeId ?? defaultWechatThemeId,
                  ),
                )
              }
              onSave={saveActiveTheme}
            />
          </div>
        ) : null}

        <div className="preview-stage min-h-0 flex-1 overflow-auto p-5 lg:p-6">
          <div
            className={`preview-paper mx-auto overflow-hidden bg-[var(--ui-surface)] ${
              previewMode === 'mobile' ? 'preview-paper-mobile' : 'preview-paper-desktop'
            }`}
          >
            <div className="preview-paper-bar">
              <span className="preview-publication-avatar" aria-hidden="true">
                A
              </span>
              <div className="preview-publication-meta">
                <strong>{doc.author || 'AutoMatic'}</strong>
                <span>{previewMode === 'mobile' ? '手机预览' : '桌面预览'}</span>
              </div>
              <CheckCircle2 size={14} className="text-[var(--ui-success)]" />
            </div>
            <article
              className={`preview-paper-content ${previewMode === 'mobile' ? 'px-5 py-7' : 'px-9 py-9'}`}
              style={{ backgroundColor: theme.preview.background }}
            >
              <div dangerouslySetInnerHTML={{ __html: html }} />
            </article>
          </div>
        </div>
      </aside>
      <PublishModal
        content={publishHtml}
        doc={doc}
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        onCopyLink={(url) => handleCopyText(url, '链接')}
      />
    </>
  );
}

function safeFilename(value: string) {
  return (
    value
      .trim()
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
      .slice(0, 60) || 'automatic-theme'
  );
}

function DeviceButton({
  active,
  label,
  icon,
  onClick,
}: {
  active: boolean;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className={`ui-pressable ui-icon-button h-7 w-8 ${
        active
          ? 'bg-[var(--ui-surface)] text-[var(--ui-text)] shadow-[var(--ui-shadow-xs)]'
          : 'text-[var(--ui-muted)] hover:text-[var(--ui-text)]'
      }`}
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

function ActionButton({
  icon,
  label,
  primary = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`preview-action-button ui-pressable flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-[5px] border px-3 text-xs font-medium ${
        primary
          ? 'is-primary border-[var(--ui-accent)] bg-[var(--ui-accent)] text-white hover:border-[var(--ui-accent-hover)] hover:bg-[var(--ui-accent-hover)]'
          : 'border-[var(--ui-line)] bg-[var(--ui-surface)] text-[var(--ui-text-secondary)] hover:border-[var(--ui-line-strong)] hover:bg-[var(--ui-subtle)]'
      }`}
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {icon}
      <span className="preview-action-label min-w-0 truncate">{label}</span>
    </button>
  );
}
