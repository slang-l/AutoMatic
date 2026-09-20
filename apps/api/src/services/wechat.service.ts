import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

import { AppError, UpstreamServiceError } from '../errors.js';
import type { WechatRepository } from '../repositories/wechat.repository.js';
import type { WechatAccount, WechatPublishState } from '../type/wechat.js';

const WECHAT_API_ORIGIN = 'https://api.weixin.qq.com';
const CREDENTIAL_VERSION = 'v1';
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_COVER_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CONTENT_IMAGE_BYTES = 1024 * 1024;

const imageMimeTypes = ['image/jpeg', 'image/png', 'image/gif'] as const;
type ImageMimeType = (typeof imageMimeTypes)[number];

export interface WechatPublicConfig {
  configured: boolean;
  appId?: string;
  defaultAuthor?: string;
  defaultDigest?: string;
  updatedAt?: string;
}

export interface SaveWechatConfigInput {
  appId: string;
  appSecret?: string;
  defaultAuthor: string;
  defaultDigest: string;
}

export interface EncodedWechatImage {
  data: string;
  mimeType: ImageMimeType;
  filename: string;
}

export interface WechatContentImage extends EncodedWechatImage {
  placeholder: string;
}

export interface PublishWechatArticleInput {
  title: string;
  author: string;
  digest: string;
  content: string;
  sourceUrl?: string;
  coverImage: EncodedWechatImage;
  contentImages: WechatContentImage[];
  showCoverPic: boolean;
  needOpenComment: boolean;
  onlyFansCanComment: boolean;
}

export interface SubmitWechatPublishResult {
  publishId: string;
  draftMediaId: string;
  messageDataId: string | null;
  state: 'publishing';
  submittedAt: string;
}

export interface WechatPublishStatusResult {
  publishId: string;
  state: WechatPublishState;
  statusCode: number;
  articleId: string | null;
  articleUrl: string | null;
  failedArticleIndexes: number[];
  message: string;
}

interface CachedAccessToken {
  appId: string;
  value: string;
  expiresAt: number;
}

interface WechatJson {
  errcode?: unknown;
  errmsg?: unknown;
  [key: string]: unknown;
}

interface WechatServiceOptions {
  repository: WechatRepository;
  encryptionSecret: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface WechatService {
  getConfig(userId: string): Promise<WechatPublicConfig>;
  saveConfig(userId: string, input: SaveWechatConfigInput): Promise<WechatPublicConfig>;
  deleteConfig(userId: string): Promise<void>;
  publishArticle(
    userId: string,
    input: PublishWechatArticleInput,
  ): Promise<SubmitWechatPublishResult>;
  getPublishStatus(userId: string, publishId: string): Promise<WechatPublishStatusResult>;
}

class WechatResponseError extends Error {
  constructor(
    public readonly errorCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'WechatResponseError';
  }
}

export function createWechatService({
  repository,
  encryptionSecret,
  fetchImpl = fetch,
  now = Date.now,
}: WechatServiceOptions): WechatService {
  const encryptionKey = createHmac('sha256', encryptionSecret)
    .update('automatic:wechat-credential:v1')
    .digest();
  const accessTokens = new Map<string, CachedAccessToken>();

  async function requestWechat(url: URL, init: RequestInit): Promise<WechatJson> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof WechatResponseError || error instanceof UpstreamServiceError)
        throw error;
      throw new UpstreamServiceError('WECHAT_UNAVAILABLE', '无法连接微信接口，请稍后重试');
    }

    let payload: WechatJson;
    try {
      payload = (await response.json()) as WechatJson;
    } catch {
      throw new UpstreamServiceError('WECHAT_INVALID_RESPONSE', '微信接口返回了无法识别的响应');
    }

    if (!response.ok) {
      throw new UpstreamServiceError(
        'WECHAT_UNAVAILABLE',
        `微信接口请求失败（HTTP ${response.status}）`,
      );
    }

    const errorCode = typeof payload.errcode === 'number' ? payload.errcode : 0;
    if (errorCode !== 0) {
      throw new WechatResponseError(errorCode, wechatErrorMessage(errorCode, payload.errmsg));
    }

    return payload;
  }

  async function requestStableToken(appId: string, appSecret: string): Promise<CachedAccessToken> {
    const payload = await requestWechat(new URL('/cgi-bin/stable_token', WECHAT_API_ORIGIN), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credential',
        appid: appId,
        secret: appSecret,
        force_refresh: false,
      }),
    });
    const accessToken = readRequiredString(payload, 'access_token');
    const expiresIn = readPositiveNumber(payload, 'expires_in');

    return {
      appId,
      value: accessToken,
      expiresAt: now() + expiresIn * 1_000,
    };
  }

  async function getAccount(userId: string): Promise<WechatAccount> {
    const account = await repository.findAccountByUserId(userId);
    if (!account) {
      throw new AppError(409, 'WECHAT_NOT_CONFIGURED', '请先配置公众号 AppID 和 AppSecret');
    }
    return account;
  }

  function decryptSecret(account: WechatAccount): string {
    try {
      return decryptCredential(
        account.encryptedAppSecret,
        encryptionKey,
        credentialAssociatedData(account.userId, account.appId),
      );
    } catch {
      throw new AppError(409, 'WECHAT_CONFIG_INVALID', '公众号凭据已失效，请重新配置');
    }
  }

  async function getAccessToken(
    userId: string,
    account: WechatAccount,
    forceRefresh = false,
  ): Promise<string> {
    const cached = accessTokens.get(userId);
    if (
      !forceRefresh &&
      cached?.appId === account.appId &&
      cached.expiresAt - ACCESS_TOKEN_REFRESH_MARGIN_MS > now()
    ) {
      return cached.value;
    }

    const nextToken = await requestStableToken(account.appId, decryptSecret(account));
    accessTokens.set(userId, nextToken);
    return nextToken.value;
  }

  async function withAccessToken<T>(
    userId: string,
    account: WechatAccount,
    request: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    let forceRefresh = false;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const accessToken = await getAccessToken(userId, account, forceRefresh);
        return await request(accessToken);
      } catch (error) {
        if (
          attempt === 0 &&
          error instanceof WechatResponseError &&
          [40014, 42001].includes(error.errorCode)
        ) {
          accessTokens.delete(userId);
          forceRefresh = true;
          continue;
        }
        throw normalizeWechatError(error);
      }
    }

    throw new UpstreamServiceError('WECHAT_TOKEN_INVALID', '微信 Access Token 已失效');
  }

  async function postJson(
    userId: string,
    account: WechatAccount,
    pathname: string,
    body: unknown,
  ): Promise<WechatJson> {
    return withAccessToken(userId, account, (accessToken) => {
      const url = wechatApiUrl(pathname, accessToken);
      return requestWechat(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    });
  }

  async function uploadImage(
    userId: string,
    account: WechatAccount,
    image: EncodedWechatImage,
    kind: 'cover' | 'content',
  ): Promise<WechatJson> {
    const bytes = decodeImage(image, kind);

    return withAccessToken(userId, account, (accessToken) => {
      const pathname =
        kind === 'cover' ? '/cgi-bin/material/add_material' : '/cgi-bin/media/uploadimg';
      const url = wechatApiUrl(pathname, accessToken);
      if (kind === 'cover') url.searchParams.set('type', 'image');

      const body = new FormData();
      body.append(
        'media',
        new Blob([new Uint8Array(bytes)], { type: image.mimeType }),
        safeFilename(image),
      );
      return requestWechat(url, { method: 'POST', body });
    });
  }

  return {
    async getConfig(userId) {
      const account = await repository.findAccountByUserId(userId);
      return account ? toPublicConfig(account) : { configured: false };
    },

    async saveConfig(userId, input) {
      const existingAccount = await repository.findAccountByUserId(userId);
      const appSecret = input.appSecret?.trim()
        ? input.appSecret
        : existingAccount?.appId === input.appId
          ? decryptSecret(existingAccount)
          : null;
      if (!appSecret) {
        throw new AppError(
          400,
          'WECHAT_APP_SECRET_REQUIRED',
          '首次配置或更换 AppID 时必须填写 AppSecret',
        );
      }

      let verifiedToken: CachedAccessToken;
      try {
        verifiedToken = await requestStableToken(input.appId, appSecret);
      } catch (error) {
        throw normalizeWechatError(error);
      }

      const account = await repository.upsertAccount({
        userId,
        appId: input.appId,
        encryptedAppSecret: encryptCredential(
          appSecret,
          encryptionKey,
          credentialAssociatedData(userId, input.appId),
        ),
        defaultAuthor: input.defaultAuthor,
        defaultDigest: input.defaultDigest,
      });
      accessTokens.set(userId, verifiedToken);
      return toPublicConfig(account);
    },

    async deleteConfig(userId) {
      accessTokens.delete(userId);
      await repository.deleteAccount(userId);
    },

    async publishArticle(userId, input) {
      const account = await getAccount(userId);
      let content = input.content;

      for (const image of input.contentImages) {
        if (!content.includes(image.placeholder)) {
          throw new AppError(400, 'INVALID_CONTENT_IMAGE', '正文图片占位符与文章内容不匹配');
        }
        const result = await uploadImage(userId, account, image, 'content');
        const imageUrl = readRequiredString(result, 'url');
        content = content.replaceAll(image.placeholder, imageUrl);
      }

      if (/automatic-image:\/\/\d+/.test(content)) {
        throw new AppError(400, 'MISSING_CONTENT_IMAGE', '正文中仍有未上传的图片');
      }

      const coverResult = await uploadImage(userId, account, input.coverImage, 'cover');
      const coverMediaId = readRequiredString(coverResult, 'media_id');
      const article = {
        title: input.title,
        author: input.author || account.defaultAuthor,
        digest: input.digest || account.defaultDigest,
        content,
        content_source_url: input.sourceUrl ?? '',
        thumb_media_id: coverMediaId,
        show_cover_pic: input.showCoverPic ? 1 : 0,
        need_open_comment: input.needOpenComment ? 1 : 0,
        only_fans_can_comment: input.onlyFansCanComment ? 1 : 0,
      };
      const draftResult = await postJson(userId, account, '/cgi-bin/draft/add', {
        articles: [article],
      });
      const draftMediaId = readRequiredString(draftResult, 'media_id');
      const publishResult = await postJson(userId, account, '/cgi-bin/freepublish/submit', {
        media_id: draftMediaId,
      });

      return {
        publishId: readRequiredIdentifier(publishResult, 'publish_id'),
        draftMediaId,
        messageDataId: readOptionalString(publishResult, 'msg_data_id'),
        state: 'publishing',
        submittedAt: new Date(now()).toISOString(),
      };
    },

    async getPublishStatus(userId, publishId) {
      const account = await getAccount(userId);
      const result = await postJson(userId, account, '/cgi-bin/freepublish/get', {
        publish_id: publishId,
      });
      const statusCode = readNumber(result, 'publish_status');
      const articleDetail = isRecord(result.article_detail) ? result.article_detail : null;
      const items = articleDetail && Array.isArray(articleDetail.item) ? articleDetail.item : [];
      const firstArticle = items.find(isRecord);
      const failedArticleIndexes = Array.isArray(result.fail_idx)
        ? result.fail_idx.filter((value): value is number => Number.isInteger(value))
        : [];
      const state: WechatPublishState =
        statusCode === 0 ? 'published' : statusCode === 1 ? 'publishing' : 'failed';

      return {
        publishId,
        state,
        statusCode,
        articleId: readOptionalString(result, 'article_id'),
        articleUrl: firstArticle ? readOptionalString(firstArticle, 'article_url') : null,
        failedArticleIndexes,
        message: publishStatusMessage(statusCode),
      };
    },
  };
}

function encryptCredential(value: string, key: Buffer, associatedData: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(associatedData);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [CREDENTIAL_VERSION, iv, tag, encrypted]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join(':');
}

function decryptCredential(value: string, key: Buffer, associatedData: Buffer): string {
  const [version, ivValue, tagValue, encryptedValue] = value.split(':');
  if (version !== CREDENTIAL_VERSION || !ivValue || !tagValue || !encryptedValue) {
    throw new Error('Unsupported credential format');
  }

  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAAD(associatedData);
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function credentialAssociatedData(userId: string, appId: string): Buffer {
  return Buffer.from(`automatic:wechat:${userId}:${appId}`, 'utf8');
}

function toPublicConfig(account: WechatAccount): WechatPublicConfig {
  return {
    configured: true,
    appId: account.appId,
    defaultAuthor: account.defaultAuthor,
    defaultDigest: account.defaultDigest,
    updatedAt: account.updatedAt.toISOString(),
  };
}

function decodeImage(image: EncodedWechatImage, kind: 'cover' | 'content'): Buffer {
  if (
    !imageMimeTypes.includes(image.mimeType) ||
    (kind === 'content' && image.mimeType === 'image/gif')
  ) {
    throw new AppError(
      400,
      'INVALID_IMAGE_TYPE',
      kind === 'cover' ? '封面仅支持 JPEG、PNG 或 GIF' : '正文图片仅支持 JPEG 或 PNG',
    );
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) {
    throw new AppError(400, 'INVALID_IMAGE_DATA', '图片数据无效');
  }

  const bytes = Buffer.from(image.data, 'base64');
  const maxBytes = kind === 'cover' ? MAX_COVER_IMAGE_BYTES : MAX_CONTENT_IMAGE_BYTES;
  if (
    bytes.length === 0 ||
    bytes.length > maxBytes ||
    !matchesImageSignature(bytes, image.mimeType)
  ) {
    throw new AppError(
      400,
      'INVALID_IMAGE_DATA',
      `${kind === 'cover' ? '封面' : '正文图片'}为空、超过 ${kind === 'cover' ? '10 MB' : '1 MB'} 或格式与文件内容不一致`,
    );
  }
  return bytes;
}

function matchesImageSignature(bytes: Buffer, mimeType: ImageMimeType): boolean {
  if (mimeType === 'image/jpeg') {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return bytes.subarray(0, 4).toString('ascii') === 'GIF8';
}

function safeFilename(image: EncodedWechatImage): string {
  const extension =
    image.mimeType === 'image/png' ? 'png' : image.mimeType === 'image/gif' ? 'gif' : 'jpg';
  const basename = image.filename
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 80)
    .replace(/\.[^.]+$/, '');
  return `${basename || 'wechat-image'}.${extension}`;
}

function wechatApiUrl(pathname: string, accessToken: string): URL {
  const url = new URL(pathname, WECHAT_API_ORIGIN);
  url.searchParams.set('access_token', accessToken);
  return url;
}

function normalizeWechatError(error: unknown): Error {
  if (error instanceof AppError || error instanceof UpstreamServiceError) return error;
  if (error instanceof WechatResponseError) {
    return new UpstreamServiceError(`WECHAT_${error.errorCode}`, error.message);
  }
  return new UpstreamServiceError('WECHAT_UNAVAILABLE', '微信公众号服务暂时不可用');
}

function wechatErrorMessage(errorCode: number, rawMessage: unknown): string {
  const messages: Record<number, string> = {
    40001: 'AppSecret 无效或与 AppID 不匹配',
    40007: '封面素材无效，请重新选择封面',
    40013: 'AppID 无效，请检查公众号开发设置',
    40014: '微信 Access Token 无效',
    40125: 'AppSecret 无效，请重新配置',
    40164: '服务器 IP 未加入公众号 IP 白名单',
    41001: '微信接口缺少 Access Token',
    42001: '微信 Access Token 已过期',
    45009: '微信接口调用次数已达到上限，请稍后再试',
    45028: '草稿数量已达到上限，请先在公众号后台清理草稿',
    48001: '当前公众号没有该接口权限，请确认账号类型和认证状态',
  };
  const fallback =
    typeof rawMessage === 'string' && rawMessage.trim()
      ? `微信接口错误：${rawMessage.trim()}`
      : `微信接口返回错误码 ${errorCode}`;
  return messages[errorCode] ?? fallback;
}

function publishStatusMessage(statusCode: number): string {
  const messages: Record<number, string> = {
    0: '文章已发布',
    1: '微信正在发布文章',
    2: '原创校验失败',
    3: '发布失败',
    4: '平台审核未通过',
    5: '文章发布后已被用户删除',
    6: '文章发布后已被系统封禁',
  };
  return messages[statusCode] ?? `未知发布状态（${statusCode}）`;
}

function readRequiredString(value: WechatJson, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== 'string' || !candidate) {
    throw new UpstreamServiceError('WECHAT_INVALID_RESPONSE', `微信接口响应缺少 ${key}`);
  }
  return candidate;
}

function readRequiredIdentifier(value: WechatJson, key: string): string {
  const candidate = readOptionalString(value, key);
  if (!candidate) {
    throw new UpstreamServiceError('WECHAT_INVALID_RESPONSE', `微信接口响应缺少 ${key}`);
  }
  return candidate;
}

function readOptionalString(value: WechatJson, key: string): string | null {
  const candidate = value[key];
  if (typeof candidate === 'string' && candidate) return candidate;
  if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
  return null;
}

function readPositiveNumber(value: WechatJson, key: string): number {
  const candidate = value[key];
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= 0) {
    throw new UpstreamServiceError('WECHAT_INVALID_RESPONSE', `微信接口响应缺少 ${key}`);
  }
  return candidate;
}

function readNumber(value: WechatJson, key: string): number {
  const candidate = value[key];
  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
    throw new UpstreamServiceError('WECHAT_INVALID_RESPONSE', `微信接口响应缺少 ${key}`);
  }
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
