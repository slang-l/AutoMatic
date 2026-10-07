export type NormalizedBlockType =
  | 'heading'
  | 'paragraph'
  | 'quote'
  | 'code'
  | 'image'
  | 'bulleted-list'
  | 'numbered-list'
  | 'todo-list'
  | 'divider';

export interface InlineTextAttributes {
  bold?: true | null;
  italic?: true | null;
  underline?: true | null;
  strike?: true | null;
  code?: true | null;
  link?: string | null;
  color?: string | null;
  background?: string | null;
}

export interface InlineTextDelta {
  insert: string;
  attributes?: InlineTextAttributes;
}

export interface NormalizedBlock {
  id: string;
  type: NormalizedBlockType;
  text?: string;
  delta?: InlineTextDelta[];
  level?: 1 | 2 | 3;
  language?: string;
  url?: string;
  alt?: string;
  caption?: string;
  items?: string[];
  itemDeltas?: InlineTextDelta[][];
  checked?: boolean[];
}

export interface AppDoc {
  deletedAt?: string;
  id: string;
  title: string;
  blocks: NormalizedBlock[];
  parentId?: string | null;
  status?: 'active' | 'review';
  author: string;
  location: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublishRecord {
  publishId: string;
  docId: string;
  title: string;
  submittedAt: string;
  state: 'publishing' | 'published' | 'failed';
  articleUrl?: string | null;
  message?: string;
}

export interface ArticleWorkspaceData {
  docs: AppDoc[];
  currentDocId: string;
  publishRecords: PublishRecord[];
}
