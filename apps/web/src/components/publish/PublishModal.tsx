import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { getDocsOwnerId, useDocsStore } from '../../store/docsStore';
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  ImagePlus,
  LoaderCircle,
  Radio,
  Save,
  Send,
  Settings2,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import {
  deleteWechatConfig,
  getWechatConfig,
  getWechatPublishStatus,
  publishWechatArticle,
  saveWechatConfig,
  type EncodedWechatImage,
  type WechatConfig,
  type WechatContentImage,
  type WechatPublishStatus,
  type WechatPublishSubmission,
} from '../../services/wechat-api';
import { AuthApiError } from '../../services/auth-api';
import type { AppDoc } from '../../types/document';
import { formatDateTime } from '../../utils/date';

const MAX_COVER_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CONTENT_IMAGE_BYTES = 1024 * 1024;
const MAX_ENCODED_IMAGES_LENGTH = 14_000_000;
const COVER_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif']);
const CONTENT_IMAGE_TYPES = new Set(['image/jpeg', 'image/png']);

interface PublishModalProps {
  content: string;
  doc: AppDoc;
  open: boolean;
  onClose: () => void;
  onCopyLink: (url: string) => void;
}

type BusyAction =
  'loading' | 'saving-config' | 'deleting-config' | 'preparing' | 'publishing' | null;

export function PublishModal({ content, doc, open, onClose, onCopyLink }: PublishModalProps) {
  const docsOwnerId = getDocsOwnerId();
  const [config, setConfig] = useState<WechatConfig | null>(null);
  const [editingConfig, setEditingConfig] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [defaultAuthor, setDefaultAuthor] = useState('');
  const [defaultDigest, setDefaultDigest] = useState('');
  const [title, setTitle] = useState(doc.title);
  const [author, setAuthor] = useState(doc.author);
  const [digest, setDigest] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreviewUrl, setCoverPreviewUrl] = useState('');
  const [showCoverPic, setShowCoverPic] = useState(true);
  const [needOpenComment, setNeedOpenComment] = useState(true);
  const [onlyFansCanComment, setOnlyFansCanComment] = useState(false);
  const [submission, setSubmission] = useState<WechatPublishSubmission | null>(null);
  const [publishStatus, setPublishStatus] = useState<WechatPublishStatus | null>(null);

  useEffect(() => {
    if (!open) return undefined;

    let cancelled = false;
    setBusyAction('loading');
    setErrorMessage('');
    setSubmission(null);
    setPublishStatus(null);
    setConfirmDelete(false);
    setTitle(doc.title);
    setAuthor(doc.author);
    setDigest('');
    setSourceUrl('');
    setCoverFile(null);

    void getWechatConfig()
      .then((nextConfig) => {
        if (cancelled) return;
        setConfig(nextConfig);
        setEditingConfig(!nextConfig.configured);
        setAppId(nextConfig.appId ?? '');
        setAppSecret('');
        setDefaultAuthor(nextConfig.defaultAuthor ?? doc.author);
        setDefaultDigest(nextConfig.defaultDigest ?? '');
        setAuthor(nextConfig.defaultAuthor || doc.author);
        setDigest(nextConfig.defaultDigest ?? '');
      })
      .catch((error: unknown) => {
        if (!cancelled) setErrorMessage(getErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setBusyAction(null);
      });

    return () => {
      cancelled = true;
    };
  }, [doc.author, doc.id, doc.title, open]);

  useEffect(() => {
    if (!coverFile) {
      setCoverPreviewUrl('');
      return undefined;
    }

    const objectUrl = URL.createObjectURL(coverFile);
    setCoverPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [coverFile]);

  useEffect(() => {
    if (
      !open ||
      !submission ||
      publishStatus?.state === 'published' ||
      publishStatus?.state === 'failed'
    ) {
      return undefined;
    }

    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const nextStatus = await getWechatPublishStatus(submission.publishId);
        if (cancelled) return;
        setPublishStatus(nextStatus);
        const record = useDocsStore
          .getState()
          .publishRecords.find((item) => item.publishId === nextStatus.publishId);
        if (record)
          useDocsStore.getState().savePublishRecord(
            {
              ...record,
              state: nextStatus.state,
              articleUrl: nextStatus.articleUrl,
              message: nextStatus.message,
            },
            docsOwnerId,
          );
        setErrorMessage('');
        if (nextStatus.state === 'publishing') {
          timer = window.setTimeout(poll, 2_500);
        }
      } catch (error) {
        if (cancelled) return;
        setErrorMessage(getErrorMessage(error));
        timer = window.setTimeout(poll, 5_000);
      }
    };

    timer = window.setTimeout(poll, 1_500);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [open, publishStatus?.state, submission]);

  if (!open) return null;

  const isBusy = busyAction !== null;

  const handleSaveConfig = async (event: FormEvent) => {
    event.preventDefault();
    setErrorMessage('');
    setBusyAction('saving-config');

    try {
      const nextConfig = await saveWechatConfig({
        appId,
        ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}),
        defaultAuthor,
        defaultDigest,
      });
      setConfig(nextConfig);
      setEditingConfig(false);
      setAppSecret('');
      setShowSecret(false);
      setAuthor(defaultAuthor || doc.author);
      setDigest(defaultDigest);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeleteConfig = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }

    setErrorMessage('');
    setBusyAction('deleting-config');
    try {
      await deleteWechatConfig();
      setConfig({ configured: false });
      setEditingConfig(true);
      setAppId('');
      setAppSecret('');
      setConfirmDelete(false);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  };

  const handlePublish = async (event: FormEvent) => {
    event.preventDefault();
    setErrorMessage('');

    if (!coverFile) {
      setErrorMessage('请选择文章封面');
      return;
    }

    try {
      setBusyAction('preparing');
      const [coverImage, preparedContent] = await Promise.all([
        encodeImage(coverFile, '封面', 'cover'),
        prepareArticleContent(content),
      ]);
      const encodedLength =
        coverImage.data.length +
        preparedContent.images.reduce((total, image) => total + image.data.length, 0);
      if (encodedLength > MAX_ENCODED_IMAGES_LENGTH) {
        throw new Error('封面和正文图片总大小过大，请压缩后重试');
      }

      setBusyAction('publishing');
      const nextSubmission = await publishWechatArticle({
        title,
        author,
        digest,
        content: preparedContent.html,
        ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
        coverImage,
        contentImages: preparedContent.images,
        showCoverPic,
        needOpenComment,
        onlyFansCanComment: needOpenComment && onlyFansCanComment,
      });
      setSubmission(nextSubmission);
      useDocsStore.getState().savePublishRecord(
        {
          publishId: nextSubmission.publishId,
          docId: doc.id,
          title,
          submittedAt: nextSubmission.submittedAt,
          state: 'publishing',
        },
        docsOwnerId,
      );
      setPublishStatus({
        publishId: nextSubmission.publishId,
        state: 'publishing',
        statusCode: 1,
        articleId: null,
        articleUrl: null,
        failedArticleIndexes: [],
        message: '微信正在发布文章',
      });
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        aria-labelledby="publish-modal-title"
        className="publish-modal-dialog gap-0 p-0"
        showCloseButton={false}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <DialogDescription className="sr-only">配置公众号并确认文章发布信息</DialogDescription>
        <header className="publish-modal-header">
          <div className="publish-modal-heading">
            <span className="publish-modal-heading-icon" aria-hidden="true">
              <Radio size={18} />
            </span>
            <div>
              <DialogTitle id="publish-modal-title">一键发布到公众号</DialogTitle>
              <p>{config?.configured ? config.appId : '公众号开发配置'}</p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="publish-icon-button"
            type="button"
            aria-label="关闭"
            title="关闭"
            onClick={onClose}
          >
            <X size={18} />
          </Button>
        </header>

        {errorMessage ? (
          <div className="publish-error" role="alert">
            <XCircle size={16} />
            <span>{errorMessage}</span>
          </div>
        ) : null}

        {busyAction === 'loading' ? (
          <div className="publish-loading">
            <LoaderCircle size={20} className="animate-spin" />
            正在读取公众号配置
          </div>
        ) : editingConfig ? (
          <form className="publish-form" onSubmit={handleSaveConfig}>
            <div className="publish-form-body">
              <div className="publish-config-guide">
                <strong>发布前请在微信公众平台完成以下配置</strong>
                <ol>
                  <li>账号已认证，并具有草稿和发布接口权限</li>
                  <li>在“设置与开发 → 开发接口管理 → 基本配置”获取 AppID 和 AppSecret</li>
                  <li>在同一页面把本 API 服务的公网出口 IPv4 加入 IP 白名单</li>
                </ol>
                <p>
                  主动发布无需配置服务器地址、Token 或 EncodingAESKey。
                  <a href="https://mp.weixin.qq.com/" target="_blank" rel="noreferrer">
                    打开微信公众平台
                    <ExternalLink size={13} />
                  </a>
                </p>
              </div>
              <div className="publish-field-grid">
                <Label className="publish-field publish-field-wide">
                  <span>AppID</span>
                  <Input
                    value={appId}
                    required
                    maxLength={18}
                    pattern="wx[A-Za-z0-9]{16}"
                    placeholder="wx..."
                    autoComplete="off"
                    onChange={(event) => setAppId(event.target.value)}
                  />
                </Label>
                <Label className="publish-field publish-field-wide">
                  <span>AppSecret</span>
                  <span className="publish-secret-input">
                    <Input
                      type={showSecret ? 'text' : 'password'}
                      value={appSecret}
                      required={!config?.configured || appId !== config.appId}
                      minLength={16}
                      maxLength={128}
                      placeholder={config?.configured ? '留空则继续使用已保存的 AppSecret' : ''}
                      autoComplete="new-password"
                      onChange={(event) => setAppSecret(event.target.value)}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      type="button"
                      aria-label={showSecret ? '隐藏 AppSecret' : '显示 AppSecret'}
                      title={showSecret ? '隐藏 AppSecret' : '显示 AppSecret'}
                      onClick={() => setShowSecret((visible) => !visible)}
                    >
                      {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
                    </Button>
                  </span>
                </Label>
                <Label className="publish-field">
                  <span>默认作者</span>
                  <Input
                    value={defaultAuthor}
                    maxLength={32}
                    onChange={(event) => setDefaultAuthor(event.target.value)}
                  />
                </Label>
                <Label className="publish-field">
                  <span>默认摘要</span>
                  <Input
                    value={defaultDigest}
                    maxLength={120}
                    onChange={(event) => setDefaultDigest(event.target.value)}
                  />
                </Label>
              </div>
            </div>
            <footer className="publish-modal-footer">
              {config?.configured ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className={`publish-danger-button ${confirmDelete ? 'is-confirming' : ''}`}
                  type="button"
                  disabled={isBusy}
                  onClick={handleDeleteConfig}
                >
                  <Trash2 size={15} />
                  {confirmDelete ? '确认移除' : '移除配置'}
                </Button>
              ) : (
                <span />
              )}
              <div className="publish-footer-actions">
                {config?.configured ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="publish-secondary-button"
                    type="button"
                    disabled={isBusy}
                    onClick={() => setEditingConfig(false)}
                  >
                    取消
                  </Button>
                ) : null}
                <Button
                  variant="default"
                  size="sm"
                  className="publish-primary-button"
                  type="submit"
                  disabled={isBusy}
                >
                  {busyAction === 'saving-config' ? (
                    <LoaderCircle size={16} className="animate-spin" />
                  ) : (
                    <Save size={16} />
                  )}
                  验证并保存
                </Button>
              </div>
            </footer>
          </form>
        ) : submission && publishStatus ? (
          <PublishStatusView
            status={publishStatus}
            submission={submission}
            onClose={onClose}
            onCopyLink={onCopyLink}
            onPublishAgain={() => {
              setSubmission(null);
              setPublishStatus(null);
              setErrorMessage('');
            }}
          />
        ) : (
          <form className="publish-form" onSubmit={handlePublish}>
            <div className="publish-form-body">
              <div className="publish-account-row">
                <span>
                  <CheckCircle2 size={15} />
                  凭据验证通过
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => setEditingConfig(true)}
                >
                  <Settings2 size={14} />
                  配置
                </Button>
              </div>

              <div className="publish-compose-grid">
                <Label className={`publish-cover-field ${coverPreviewUrl ? 'has-image' : ''}`}>
                  {coverPreviewUrl ? (
                    <img src={coverPreviewUrl} alt="文章封面" />
                  ) : (
                    <ImagePlus size={24} />
                  )}
                  <span>{coverFile ? '更换封面' : '选择封面'}</span>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/gif"
                    onChange={(event) => setCoverFile(event.target.files?.[0] ?? null)}
                  />
                </Label>

                <div className="publish-field-grid">
                  <Label className="publish-field publish-field-wide">
                    <span>文章标题</span>
                    <Input
                      value={title}
                      required
                      maxLength={64}
                      onChange={(event) => setTitle(event.target.value)}
                    />
                  </Label>
                  <Label className="publish-field">
                    <span>作者</span>
                    <Input
                      value={author}
                      maxLength={32}
                      onChange={(event) => setAuthor(event.target.value)}
                    />
                  </Label>
                  <Label className="publish-field">
                    <span>原文链接</span>
                    <Input
                      type="url"
                      value={sourceUrl}
                      maxLength={1_024}
                      placeholder="https://"
                      onChange={(event) => setSourceUrl(event.target.value)}
                    />
                  </Label>
                  <Label className="publish-field publish-field-wide">
                    <span>摘要</span>
                    <Textarea
                      value={digest}
                      maxLength={120}
                      rows={3}
                      onChange={(event) => setDigest(event.target.value)}
                    />
                    <small>{digest.length}/120</small>
                  </Label>
                </div>
              </div>

              <div className="publish-options" aria-label="发布选项">
                <ToggleOption
                  label="正文显示封面"
                  checked={showCoverPic}
                  onChange={setShowCoverPic}
                />
                <ToggleOption
                  label="开启评论"
                  checked={needOpenComment}
                  onChange={setNeedOpenComment}
                />
                <ToggleOption
                  label="仅粉丝可评论"
                  checked={onlyFansCanComment}
                  disabled={!needOpenComment}
                  onChange={setOnlyFansCanComment}
                />
              </div>
            </div>

            <footer className="publish-modal-footer">
              <span className="publish-footer-meta">{config?.appId}</span>
              <div className="publish-footer-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  className="publish-secondary-button"
                  type="button"
                  disabled={isBusy}
                  onClick={onClose}
                >
                  取消
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  className="publish-primary-button"
                  type="submit"
                  disabled={isBusy}
                >
                  {isBusy ? (
                    <LoaderCircle size={16} className="animate-spin" />
                  ) : (
                    <Send size={16} />
                  )}
                  {busyAction === 'preparing'
                    ? '正在处理图片'
                    : busyAction === 'publishing'
                      ? '正在提交'
                      : '发布到公众号'}
                </Button>
              </div>
            </footer>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PublishStatusView({
  status,
  submission,
  onClose,
  onCopyLink,
  onPublishAgain,
}: {
  status: WechatPublishStatus;
  submission: WechatPublishSubmission;
  onClose: () => void;
  onCopyLink: (url: string) => void;
  onPublishAgain: () => void;
}) {
  const published = status.state === 'published';
  const failed = status.state === 'failed';

  return (
    <div className="publish-result">
      <div
        className={`publish-result-icon ${published ? 'is-success' : failed ? 'is-error' : 'is-pending'}`}
      >
        {published ? (
          <CheckCircle2 size={28} />
        ) : failed ? (
          <XCircle size={28} />
        ) : (
          <LoaderCircle size={28} className="animate-spin" />
        )}
      </div>
      <h3>{published ? '发布成功' : failed ? '发布未完成' : '已提交到微信'}</h3>
      <p>{status.message}</p>

      <dl className="publish-result-details">
        <div>
          <dt>提交时间</dt>
          <dd>{formatDateTime(submission.submittedAt)}</dd>
        </div>
        <div>
          <dt>发布 ID</dt>
          <dd>{submission.publishId}</dd>
        </div>
        {status.articleUrl ? (
          <div>
            <dt>文章链接</dt>
            <dd>
              <a href={status.articleUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={14} />
                {status.articleUrl}
              </a>
            </dd>
          </div>
        ) : null}
      </dl>

      <footer className="publish-modal-footer">
        <Button
          variant="ghost"
          size="sm"
          className="publish-secondary-button"
          type="button"
          onClick={onPublishAgain}
        >
          返回
        </Button>
        <div className="publish-footer-actions">
          <Button
            variant="ghost"
            size="sm"
            className="publish-secondary-button"
            type="button"
            onClick={onClose}
          >
            关闭
          </Button>
          {status.articleUrl ? (
            <Button
              variant="default"
              size="sm"
              className="publish-primary-button"
              type="button"
              onClick={() => onCopyLink(status.articleUrl!)}
            >
              <Copy size={16} />
              复制链接
            </Button>
          ) : null}
        </div>
      </footer>
    </div>
  );
}

function ToggleOption({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Label className={`publish-toggle ${disabled ? 'is-disabled' : ''}`}>
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="publish-toggle-track" aria-hidden="true" />
    </Label>
  );
}

async function prepareArticleContent(
  html: string,
): Promise<{ html: string; images: WechatContentImage[] }> {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const imageElements = Array.from(parsed.body.querySelectorAll<HTMLImageElement>('img[src]'));
  const images: WechatContentImage[] = [];

  for (const [index, imageElement] of imageElements.entries()) {
    const source = imageElement.getAttribute('src')?.trim();
    if (!source || isWechatHostedImage(source)) continue;

    let response: Response;
    try {
      response = await fetch(source);
    } catch {
      throw new Error(`正文第 ${index + 1} 张图片无法读取，请重新插入后发布`);
    }
    if (!response.ok) {
      throw new Error(`正文第 ${index + 1} 张图片加载失败（HTTP ${response.status}）`);
    }

    const blob = await response.blob();
    const extension = imageExtension(blob.type);
    const encoded = await encodeImage(blob, `article-image-${index + 1}.${extension}`, 'content');
    const placeholder = `automatic-image://${images.length}`;
    imageElement.setAttribute('src', placeholder);
    images.push({ ...encoded, placeholder });
  }

  return { html: parsed.body.innerHTML, images };
}

function isWechatHostedImage(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'mmbiz.qpic.cn' || url.hostname.endsWith('.mmbiz.qpic.cn'))
    );
  } catch {
    return false;
  }
}

async function encodeImage(
  blob: Blob,
  filenameOrLabel: string,
  kind: 'cover' | 'content',
): Promise<EncodedWechatImage> {
  const supportedTypes = kind === 'cover' ? COVER_IMAGE_TYPES : CONTENT_IMAGE_TYPES;
  if (!supportedTypes.has(blob.type)) {
    throw new Error(
      `${filenameOrLabel}仅支持 ${kind === 'cover' ? 'JPEG、PNG 或 GIF' : 'JPEG 或 PNG'}`,
    );
  }
  const maxBytes = kind === 'cover' ? MAX_COVER_IMAGE_BYTES : MAX_CONTENT_IMAGE_BYTES;
  if (blob.size === 0 || blob.size > maxBytes) {
    throw new Error(`${filenameOrLabel}不能为空且不能超过 ${kind === 'cover' ? '10 MB' : '1 MB'}`);
  }

  const filename = blob instanceof File ? blob.name : filenameOrLabel;
  return {
    data: await readBlobAsBase64(blob),
    mimeType: blob.type as EncodedWechatImage['mimeType'],
    filename,
  };
}

function readBlobAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string' || !result.includes(',')) {
        reject(new Error('图片读取失败'));
        return;
      }
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function imageExtension(mimeType: string): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/gif') return 'gif';
  return 'jpg';
}

function getErrorMessage(error: unknown): string {
  if (error instanceof AuthApiError || error instanceof Error) return error.message;
  return '操作失败，请稍后重试';
}
