import type { Pool, QueryResultRow } from 'pg';
import type { Article, ArticleWorkspace } from '../type/article.js';
import { emptyArticleWorkspace } from '../type/article.js';
import {
  checkWorkspaceWrite,
  workspaceWriteHash,
  type ArticleRepository,
} from './article.repository.js';

interface WorkspaceRow extends QueryResultRow {
  revision: number;
  currentDocId: string;
  publishRecords: ArticleWorkspace['publishRecords'];
  docs: Article[];
}

export function createPostgresArticleRepository(pool: Pool): ArticleRepository {
  return {
    async getWorkspace(userId) {
      // One SQL statement gives the workspace revision and articles from the
      // same MVCC snapshot, even while another connection commits a save.
      const result = await pool.query<WorkspaceRow>(
        `
        SELECT w.revision, w.current_doc_id AS "currentDocId",
          w.publish_records AS "publishRecords",
          COALESCE((SELECT jsonb_agg(
            jsonb_strip_nulls(jsonb_build_object(
              'id', a.id, 'title', a.title,
              'status', a.status, 'author', a.author, 'location', a.location,
              'createdAt', to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'updatedAt', to_char(a.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'deletedAt', to_char(a.deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            )) || jsonb_build_object('parentId', a.parent_id, 'blocks', a.blocks)
            ORDER BY a.position)
            FROM articles a WHERE a.user_id = w.user_id), '[]'::jsonb) AS docs
        FROM article_workspaces w WHERE w.user_id = $1
      `,
        [userId],
      );
      return result.rows[0] ?? emptyArticleWorkspace();
    },
    async saveWorkspace(userId, input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO article_workspaces(user_id) VALUES ($1)
          ON CONFLICT (user_id) DO NOTHING`,
          [userId],
        );
        const result = await client.query<{
          revision: number;
          writeId: string | null;
          writeHash: string | null;
        }>(
          `
          SELECT revision, last_write_id AS "writeId", last_write_hash AS "writeHash"
          FROM article_workspaces WHERE user_id = $1 FOR UPDATE
        `,
          [userId],
        );
        const row = result.rows[0];
        if (!row) throw new Error('Article workspace not found');
        const hash = workspaceWriteHash(input);
        if (checkWorkspaceWrite(row, input, hash) === 'retry') {
          await client.query('COMMIT');
          return { revision: row.revision };
        }
        // Hierarchy changes, trash, permanent deletions, body data and metadata
        // commit together. Deferred parent FKs allow arbitrary client ordering.
        await client.query('DELETE FROM articles WHERE user_id = $1', [userId]);
        await client.query(
          `
          INSERT INTO articles(user_id, id, parent_id, position, title, blocks,
            status, author, location, created_at, updated_at, deleted_at)
          SELECT $1, item->>'id', item->>'parentId', ordinal - 1,
            item->>'title', item->'blocks', item->>'status', item->>'author',
            item->>'location', (item->>'createdAt')::timestamptz,
            (item->>'updatedAt')::timestamptz, (item->>'deletedAt')::timestamptz
          FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS data(item, ordinal)
        `,
          [userId, JSON.stringify(input.docs)],
        );
        const revision = row.revision + 1;
        await client.query(
          `UPDATE article_workspaces SET revision = $2,
          current_doc_id = $3, publish_records = $4::jsonb, last_write_id = $5,
          last_write_hash = $6, updated_at = now() WHERE user_id = $1`,
          [
            userId,
            revision,
            input.currentDocId,
            JSON.stringify(input.publishRecords),
            input.writeId,
            hash,
          ],
        );
        await client.query('COMMIT');
        return { revision };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
