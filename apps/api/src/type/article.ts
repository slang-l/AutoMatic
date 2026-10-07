import { z } from 'zod';

const id = z.string().min(1).max(128);
const timestamp = z.iso.datetime({ offset: true });
const attributes = z
  .object({
    bold: z.literal(true).nullable().optional(),
    italic: z.literal(true).nullable().optional(),
    underline: z.literal(true).nullable().optional(),
    strike: z.literal(true).nullable().optional(),
    code: z.literal(true).nullable().optional(),
    link: z.string().max(8192).nullable().optional(),
    color: z.string().max(128).nullable().optional(),
    background: z.string().max(128).nullable().optional(),
  })
  .strict();
const delta = z
  .array(
    z
      .object({
        insert: z.string().max(1_000_000),
        attributes: attributes.optional(),
      })
      .strict(),
  )
  .max(20_000);

// Keep this wire format compatible with web/src/types/document.ts. Images use
// data URLs, so their bytes survive browser and device changes along with text.
export const articleBlockSchema = z
  .object({
    id,
    type: z.enum([
      'heading',
      'paragraph',
      'quote',
      'code',
      'image',
      'bulleted-list',
      'numbered-list',
      'todo-list',
      'divider',
    ]),
    text: z.string().max(1_000_000).optional(),
    delta: delta.optional(),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    language: z.string().max(128).optional(),
    url: z
      .string()
      .max(2_100_000)
      .refine((value) => !value.startsWith('blob:'), 'Temporary blob URLs cannot be persisted')
      .optional(),
    alt: z.string().max(10_000).optional(),
    caption: z.string().max(10_000).optional(),
    items: z.array(z.string().max(1_000_000)).max(20_000).optional(),
    itemDeltas: z.array(delta).max(20_000).optional(),
    checked: z.array(z.boolean()).max(20_000).optional(),
  })
  .strict();

export const articleSchema = z
  .object({
    id,
    title: z.string().max(10_000),
    blocks: z.array(articleBlockSchema).max(20_000),
    parentId: id.nullable().optional(),
    status: z.enum(['active', 'review']).optional(),
    author: z.string().max(1000),
    location: z.string().max(1000),
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: timestamp.optional(),
  })
  .strict();

const publishRecordSchema = z
  .object({
    publishId: z.string().min(1).max(256),
    docId: id,
    title: z.string().max(10_000),
    submittedAt: timestamp,
    state: z.enum(['publishing', 'published', 'failed']),
    articleUrl: z.string().max(8192).nullable().optional(),
    message: z.string().max(20_000).optional(),
  })
  .strict();

export const saveArticleWorkspaceSchema = z
  .object({
    revision: z.number().int().min(0).max(2_147_483_646),
    writeId: z.uuid(),
    docs: z.array(articleSchema).max(2000),
    currentDocId: z.string().max(128),
    publishRecords: z.array(publishRecordSchema).max(10_000),
  })
  .strict();

export type Article = z.infer<typeof articleSchema>;
export type SaveArticleWorkspace = z.infer<typeof saveArticleWorkspaceSchema>;
export type ArticleWorkspace = Omit<SaveArticleWorkspace, 'writeId'>;

export function emptyArticleWorkspace(): ArticleWorkspace {
  return { revision: 0, docs: [], currentDocId: '', publishRecords: [] };
}
