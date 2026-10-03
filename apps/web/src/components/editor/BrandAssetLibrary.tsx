import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Check,
  ImageOff,
  Images,
  LoaderCircle,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  brandAssetCategories,
  createBrandAsset,
  deleteBrandAsset,
  listBrandAssets,
  updateBrandAsset,
  type BrandAsset,
  type BrandAssetCategory,
  type BrandAssetMetadata,
} from '../../services/brand-assets-api';
import { AuthApiError } from '../../services/auth-api';

const MAX_IMAGE_SIZE = 1_500_000;
const acceptedMimeTypes = ['image/jpeg', 'image/png', 'image/gif'] as const;
const focusableSelector = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const categoryOptions: Array<{ id: 'all' | BrandAssetCategory; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'logo', label: 'Logo' },
  { id: 'qr-code', label: '二维码' },
  { id: 'avatar', label: '头像' },
  { id: 'product', label: '产品' },
  { id: 'other', label: '其他' },
];

interface BrandAssetLibraryProps {
  open: boolean;
  onInsert: (asset: BrandAsset) => boolean;
  onOpenChange: (open: boolean) => void;
}

interface AssetDraft extends BrandAssetMetadata {
  mode: 'create' | 'edit';
  assetId?: string;
  dataUrl?: string;
  mimeType?: BrandAsset['mimeType'];
  tagsText: string;
}

export function BrandAssetLibrary({ open, onInsert, onOpenChange }: BrandAssetLibraryProps) {
  const [assets, setAssets] = useState<BrandAsset[]>([]);
  const [limit, setLimit] = useState(100);
  const [category, setCategory] = useState<'all' | BrandAssetCategory>('all');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<AssetDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const draftRef = useRef<AssetDraft | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  draftRef.current = draft;

  const filteredAssets = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return assets.filter((asset) => {
      if (category !== 'all' && asset.category !== category) return false;
      if (!normalizedQuery) return true;
      return [asset.name, ...asset.tags].join(' ').toLocaleLowerCase().includes(normalizedQuery);
    });
  }, [assets, category, query]);

  useEffect(() => {
    if (!open) return undefined;

    let active = true;
    const previousActiveElement = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    setLoading(true);
    setError('');
    void listBrandAssets()
      .then((result) => {
        if (!active) return;
        setAssets(result.assets);
        setLimit(result.limit);
      })
      .catch((cause: unknown) => {
        if (active) setError(describeError(cause, '素材加载失败，请稍后重试'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    window.setTimeout(() => searchRef.current?.focus(), 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (draftRef.current) setDraft(null);
        else onOpenChange(false);
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
      active = false;
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousActiveElement?.focus();
    };
  }, [onOpenChange, open]);

  if (!open) return null;

  const handleFileChange = async (file?: File) => {
    if (!file) return;
    setError('');

    if (!acceptedMimeTypes.includes(file.type as (typeof acceptedMimeTypes)[number])) {
      setError('仅支持 JPG、PNG 和 GIF 图片');
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      setError('单张图片不能超过 1.5 MB');
      return;
    }

    try {
      const dataUrl = await readFileAsDataUrl(file);
      setDraft({
        mode: 'create',
        name: file.name.replace(/\.[^.]+$/, '').slice(0, 80) || '未命名素材',
        category: inferCategory(file.name),
        tags: [],
        tagsText: '',
        dataUrl,
        mimeType: file.type as BrandAsset['mimeType'],
      });
    } catch {
      setError('无法读取这张图片，请重新选择');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSave = async () => {
    if (!draft || saving) return;
    const metadata = draftToMetadata(draft);
    if (!metadata.name) {
      setError('请填写素材名称');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const saved =
        draft.mode === 'create'
          ? await createBrandAsset(metadata, {
              dataUrl: draft.dataUrl ?? '',
              mimeType: draft.mimeType ?? 'image/png',
            })
          : await updateBrandAsset(draft.assetId ?? '', metadata);
      setAssets((current) => [saved, ...current.filter((asset) => asset.id !== saved.id)]);
      setDraft(null);
    } catch (cause) {
      setError(describeError(cause, '素材保存失败，请稍后重试'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (assetId: string) => {
    if (confirmDeleteId !== assetId) {
      setConfirmDeleteId(assetId);
      return;
    }

    setDeletingId(assetId);
    setError('');
    try {
      await deleteBrandAsset(assetId);
      setAssets((current) => current.filter((asset) => asset.id !== assetId));
      setConfirmDeleteId(null);
      if (draft?.assetId === assetId) setDraft(null);
    } catch (cause) {
      setError(describeError(cause, '素材删除失败，请稍后重试'));
    } finally {
      setDeletingId(null);
    }
  };

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
        className="content-library-dialog brand-asset-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="brand-asset-title"
      >
        <header className="content-library-header">
          <div className="content-library-heading">
            <span
              className="content-library-heading-icon brand-asset-heading-icon"
              aria-hidden="true"
            >
              <Images size={19} />
            </span>
            <div>
              <h2 id="brand-asset-title">品牌素材库</h2>
              <p>
                {assets.length} / {limit} 张图片
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="content-library-close"
            type="button"
            aria-label="关闭品牌素材库"
            title="关闭"
            onClick={() => onOpenChange(false)}
          >
            <X size={18} />
          </Button>
        </header>

        <div className="content-library-controls brand-asset-controls">
          <Label className="content-library-search">
            <Search size={16} aria-hidden="true" />
            <Input
              ref={searchRef}
              type="search"
              value={query}
              placeholder="搜索名称或标签"
              aria-label="搜索品牌素材"
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

          <div className="content-library-categories" role="tablist" aria-label="素材分类">
            {categoryOptions.map((option) => (
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

          <Button
            variant="ghost"
            size="sm"
            className="brand-asset-upload-button"
            type="button"
            disabled={assets.length >= limit || saving}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload size={15} />
            <span>上传</span>
          </Button>
          <input
            ref={fileInputRef}
            className="brand-asset-file-input"
            type="file"
            accept="image/jpeg,image/png,image/gif"
            onChange={(event) => void handleFileChange(event.target.files?.[0])}
          />
        </div>

        {draft ? (
          <AssetDraftEditor
            draft={draft}
            saving={saving}
            onCancel={() => setDraft(null)}
            onChange={setDraft}
            onSave={() => void handleSave()}
          />
        ) : null}

        {error ? (
          <div className="brand-asset-error" role="alert">
            <ImageOff size={15} />
            <span>{error}</span>
            <Button
              variant="ghost"
              size="icon"
              type="button"
              aria-label="关闭错误提示"
              onClick={() => setError('')}
            >
              <X size={14} />
            </Button>
          </div>
        ) : null}

        <div className="content-library-results brand-asset-results" aria-live="polite">
          {loading ? (
            <div className="content-library-empty">
              <LoaderCircle className="animate-spin" size={20} />
              <strong>正在加载素材</strong>
            </div>
          ) : filteredAssets.length > 0 ? (
            <div className="brand-asset-grid">
              {filteredAssets.map((asset) => (
                <article className="brand-asset-card" key={asset.id}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="brand-asset-preview"
                    type="button"
                    title={`插入「${asset.name}」`}
                    onClick={() => {
                      if (onInsert(asset)) onOpenChange(false);
                    }}
                  >
                    <img src={asset.dataUrl} alt="" />
                    <span>
                      <Plus size={15} />
                      插入文章
                    </span>
                  </Button>
                  <div className="brand-asset-card-info">
                    <div>
                      <strong title={asset.name}>{asset.name}</strong>
                      <small>
                        {categoryLabel(asset.category)} · {formatFileSize(asset.sizeBytes)}
                      </small>
                    </div>
                    <div className="brand-asset-card-actions">
                      <Button
                        variant="ghost"
                        size="icon"
                        type="button"
                        title="编辑素材"
                        aria-label={`编辑 ${asset.name}`}
                        onClick={() => {
                          setConfirmDeleteId(null);
                          setDraft({
                            mode: 'edit',
                            assetId: asset.id,
                            name: asset.name,
                            category: asset.category,
                            tags: asset.tags,
                            tagsText: asset.tags.join(', '),
                          });
                        }}
                      >
                        <Pencil size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className={confirmDeleteId === asset.id ? 'is-confirming' : ''}
                        type="button"
                        title={confirmDeleteId === asset.id ? '再次点击确认删除' : '删除素材'}
                        aria-label={
                          confirmDeleteId === asset.id
                            ? `确认删除 ${asset.name}`
                            : `删除 ${asset.name}`
                        }
                        disabled={deletingId === asset.id}
                        onBlur={() =>
                          setConfirmDeleteId((current) => (current === asset.id ? null : current))
                        }
                        onClick={() => void handleDelete(asset.id)}
                      >
                        {deletingId === asset.id ? (
                          <LoaderCircle className="animate-spin" size={14} />
                        ) : confirmDeleteId === asset.id ? (
                          <Check size={14} />
                        ) : (
                          <Trash2 size={14} />
                        )}
                      </Button>
                    </div>
                  </div>
                  {asset.tags.length > 0 ? (
                    <div className="brand-asset-tags" aria-label="素材标签">
                      {asset.tags.slice(0, 3).map((tag) => (
                        <span key={tag}>{tag}</span>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          ) : (
            <div className="content-library-empty">
              <Images size={21} />
              <strong>{assets.length === 0 ? '还没有品牌素材' : '没有找到相关素材'}</strong>
              <span>
                {assets.length === 0 ? '上传常用图片，写作时可直接插入' : '换一个关键词或分类试试'}
              </span>
              {assets.length === 0 && !draft ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="brand-asset-empty-upload"
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload size={15} />
                  上传图片
                </Button>
              ) : null}
            </div>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function AssetDraftEditor({
  draft,
  saving,
  onCancel,
  onChange,
  onSave,
}: {
  draft: AssetDraft;
  saving: boolean;
  onCancel: () => void;
  onChange: (draft: AssetDraft) => void;
  onSave: () => void;
}) {
  return (
    <section
      className="brand-asset-editor"
      aria-label={draft.mode === 'create' ? '添加素材' : '编辑素材'}
    >
      {draft.dataUrl ? (
        <img className="brand-asset-editor-preview" src={draft.dataUrl} alt="" />
      ) : null}
      <Label>
        <span>名称</span>
        <Input
          autoFocus
          maxLength={80}
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
      </Label>
      <Label>
        <span>分类</span>
        <select
          value={draft.category}
          onChange={(event) =>
            onChange({ ...draft, category: event.target.value as BrandAssetCategory })
          }
        >
          {brandAssetCategories.map((item) => (
            <option key={item} value={item}>
              {categoryLabel(item)}
            </option>
          ))}
        </select>
      </Label>
      <Label className="brand-asset-tags-field">
        <span>标签</span>
        <Input
          maxLength={160}
          placeholder="多个标签用逗号分隔"
          value={draft.tagsText}
          onChange={(event) => onChange({ ...draft, tagsText: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onSave();
            }
          }}
        />
      </Label>
      <div className="brand-asset-editor-actions">
        <Button variant="ghost" size="sm" type="button" onClick={onCancel}>
          取消
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="is-primary"
          type="button"
          disabled={saving}
          onClick={onSave}
        >
          {saving ? <LoaderCircle className="animate-spin" size={14} /> : <Check size={14} />}
          保存
        </Button>
      </div>
    </section>
  );
}

function draftToMetadata(draft: AssetDraft): BrandAssetMetadata {
  const tags = [
    ...new Set(
      draft.tagsText
        .split(/[,，]/)
        .map((tag) => tag.trim().toLocaleLowerCase().slice(0, 20))
        .filter(Boolean),
    ),
  ].slice(0, 8);

  return {
    name: draft.name.trim().slice(0, 80),
    category: draft.category,
    tags,
  };
}

function inferCategory(filename: string): BrandAssetCategory {
  if (/二维码|qr[-_\s]?code|qrcode/i.test(filename)) return 'qr-code';
  if (/logo|标志|商标/i.test(filename)) return 'logo';
  if (/头像|avatar|portrait/i.test(filename)) return 'avatar';
  if (/产品|product|商品/i.test(filename)) return 'product';
  return 'other';
}

function categoryLabel(category: BrandAssetCategory) {
  return categoryOptions.find((option) => option.id === category)?.label ?? '其他';
}

function formatFileSize(bytes: number) {
  return bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1_000))} KB`;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result ?? '')));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

function describeError(error: unknown, fallback: string) {
  if (error instanceof AuthApiError) {
    if (error.code === 'BRAND_ASSET_LIMIT_REACHED') return '素材库已达到 100 张上限';
    if (error.code === 'INVALID_BRAND_ASSET_IMAGE') return '图片内容无效，请重新选择';
    if (error.status === 401) return '登录状态已失效，请重新登录';
  }
  return fallback;
}
