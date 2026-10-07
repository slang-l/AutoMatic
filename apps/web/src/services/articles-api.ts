import { authenticatedRequest } from './auth-api';
import type { ArticleWorkspaceData } from '../types/document';

export interface ArticleWorkspace extends ArticleWorkspaceData {
  revision: number;
}

export interface ArticleWorkspaceWrite extends ArticleWorkspace {
  writeId: string;
}

export function getArticleWorkspace(signal?: AbortSignal): Promise<ArticleWorkspace> {
  return authenticatedRequest('/api/articles/workspace', { signal });
}

export function saveArticleWorkspace(
  workspace: ArticleWorkspaceWrite,
  signal?: AbortSignal,
): Promise<{ revision: number }> {
  return authenticatedRequest('/api/articles/workspace', {
    method: 'PUT',
    body: JSON.stringify(workspace),
    signal,
  });
}
