import { authenticatedRequest } from './auth-api';

export interface WechatConfig {
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
  mimeType: 'image/jpeg' | 'image/png' | 'image/gif';
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

export interface WechatPublishSubmission {
  publishId: string;
  draftMediaId: string;
  messageDataId: string | null;
  state: 'publishing';
  submittedAt: string;
}

export interface WechatPublishStatus {
  publishId: string;
  state: 'publishing' | 'published' | 'failed';
  statusCode: number;
  articleId: string | null;
  articleUrl: string | null;
  failedArticleIndexes: number[];
  message: string;
}

export function getWechatConfig(): Promise<WechatConfig> {
  return authenticatedRequest<WechatConfig>('/api/wechat/config');
}

export function saveWechatConfig(input: SaveWechatConfigInput): Promise<WechatConfig> {
  return authenticatedRequest<WechatConfig>('/api/wechat/config', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function deleteWechatConfig(): Promise<void> {
  return authenticatedRequest<void>('/api/wechat/config', { method: 'DELETE' });
}

export function publishWechatArticle(
  input: PublishWechatArticleInput,
): Promise<WechatPublishSubmission> {
  return authenticatedRequest<WechatPublishSubmission>('/api/wechat/publish', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getWechatPublishStatus(publishId: string): Promise<WechatPublishStatus> {
  return authenticatedRequest<WechatPublishStatus>(
    `/api/wechat/publish/${encodeURIComponent(publishId)}`,
  );
}
