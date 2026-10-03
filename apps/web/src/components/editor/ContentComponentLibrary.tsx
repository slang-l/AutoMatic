import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  BellRing,
  ExternalLink,
  Gift,
  Heart,
  LibraryBig,
  ListChecks,
  ListOrdered,
  MessageCircleQuestion,
  Plus,
  QrCode,
  Quote,
  Search,
  SeparatorHorizontal,
  Sparkles,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  contentComponentCategories,
  contentComponents,
  type ContentComponentCategory,
  type ContentComponentDefinition,
  type ContentComponentIcon,
} from './content-components';

interface ContentComponentLibraryProps {
  open: boolean;
  onInsert: (component: ContentComponentDefinition) => boolean;
  onOpenChange: (open: boolean) => void;
}

type CategoryFilter = 'all' | ContentComponentCategory;

const componentIcons: Record<ContentComponentIcon, LucideIcon> = {
  author: UserRound,
  chapter: SeparatorHorizontal,
  follow: QrCode,
  gift: Gift,
  intro: Sparkles,
  notice: BellRing,
  points: ListChecks,
  question: MessageCircleQuestion,
  quote: Quote,
  'read-more': ExternalLink,
  steps: ListOrdered,
  support: Heart,
  summary: ListChecks,
};

const focusableSelector = [
  'button:not([disabled])',
  'input:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function ContentComponentLibrary({
  open,
  onInsert,
  onOpenChange,
}: ContentComponentLibraryProps) {
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [query, setQuery] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const filteredComponents = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();

    return contentComponents.filter((component) => {
      if (category !== 'all' && component.category !== category) return false;
      if (!normalizedQuery) return true;

      return [component.name, component.description, ...component.keywords]
        .join(' ')
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    });
  }, [category, query]);

  useEffect(() => {
    if (!open) return undefined;

    const previousActiveElement = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.setTimeout(() => searchRef.current?.focus(), 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onOpenChange(false);
        return;
      }

      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector),
      ).filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousActiveElement?.focus();
    };
  }, [onOpenChange, open]);

  if (!open) return null;

  return createPortal(
    <div
      className="content-library-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <section
        ref={dialogRef}
        className="content-library-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="content-library-title"
      >
        <header className="content-library-header">
          <div className="content-library-heading">
            <span className="content-library-heading-icon" aria-hidden="true">
              <LibraryBig size={19} />
            </span>
            <div>
              <h2 id="content-library-title">内容组件</h2>
              <p>{contentComponents.length} 个可复用内容模块</p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="content-library-close"
            type="button"
            aria-label="关闭内容组件"
            title="关闭"
            onClick={() => onOpenChange(false)}
          >
            <X size={18} />
          </Button>
        </header>

        <div className="content-library-controls">
          <Label className="content-library-search">
            <Search size={16} aria-hidden="true" />
            <Input
              ref={searchRef}
              type="search"
              value={query}
              placeholder="搜索组件"
              aria-label="搜索内容组件"
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
              <Button
                variant="ghost"
                size="icon"
                type="button"
                aria-label="清除搜索"
                onClick={() => setQuery('')}
              >
                <X size={14} />
              </Button>
            ) : null}
          </Label>

          <div className="content-library-categories" role="tablist" aria-label="组件分类">
            {contentComponentCategories.map((option) => (
              <Button
                variant="ghost"
                size="sm"
                key={option.id}
                type="button"
                role="tab"
                aria-selected={category === option.id}
                className={category === option.id ? 'is-active' : ''}
                onClick={() => setCategory(option.id)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="content-library-results" aria-live="polite">
          {filteredComponents.length > 0 ? (
            <div className="content-library-grid">
              {filteredComponents.map((component) => (
                <ComponentCard
                  key={component.id}
                  component={component}
                  onInsert={() => {
                    onInsert(component);
                    onOpenChange(false);
                  }}
                />
              ))}
            </div>
          ) : (
            <div className="content-library-empty">
              <Search size={20} />
              <strong>没有找到相关组件</strong>
              <span>换一个关键词或分类试试</span>
            </div>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function ComponentCard({
  component,
  onInsert,
}: {
  component: ContentComponentDefinition;
  onInsert: () => void;
}) {
  const Icon = componentIcons[component.icon];

  return (
    <Button
      variant="ghost"
      size="sm"
      className="content-component-card"
      type="button"
      onClick={onInsert}
    >
      <span className="content-component-card-icon" aria-hidden="true">
        <Icon size={18} />
      </span>
      <span className="content-component-card-copy">
        <strong>{component.name}</strong>
        <span>{component.description}</span>
      </span>
      <span className="content-component-card-action" aria-hidden="true">
        <Plus size={15} />
      </span>
    </Button>
  );
}
