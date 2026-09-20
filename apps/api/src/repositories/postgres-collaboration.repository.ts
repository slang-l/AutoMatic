import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { AppError } from '../errors.js';

import type { CollaborationRepository } from './collaboration.repository.js';
import type {
  CollaborationDocumentAccess,
  CollaborationMember,
  CollaborationPresence,
  CollaborationRole,
  CollaborationUpdate,
} from '../type/collaboration.js';

interface DocumentAccessRow extends QueryResultRow {
  id: string;
  ownerId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  role: CollaborationRole;
  memberCount: string;
  latestSequence: string | null;
}

interface MemberRow extends QueryResultRow {
  documentId: string;
  userId: string;
  email: string;
  name: string;
  role: CollaborationRole;
  createdAt: Date;
  updatedAt: Date;
}

interface UpdateRow extends QueryResultRow {
  sequence: string;
  documentId: string;
  operationId: string;
  actorId: string;
  actorName: string;
  updateData: Buffer;
  createdAt: Date;
}

interface PresenceRow extends QueryResultRow {
  documentId: string;
  sessionId: string;
  userId: string;
  userName: string;
  state: Record<string, unknown>;
  updatedAt: Date;
}

const DOCUMENT_ACCESS_COLUMNS = `
  d.id,
  d.owner_id AS "ownerId",
  d.title,
  d.created_at AS "createdAt",
  d.updated_at AS "updatedAt",
  member.role,
  (SELECT count(*) FROM collaboration_members count_member
    WHERE count_member.document_id = d.id) AS "memberCount",
  (SELECT max(sequence)::text FROM collaboration_updates latest_update
    WHERE latest_update.document_id = d.id) AS "latestSequence"
`;

const MEMBER_COLUMNS = `
  member.document_id AS "documentId",
  member.user_id AS "userId",
  app_user.email,
  app_user.name,
  member.role,
  member.created_at AS "createdAt",
  member.updated_at AS "updatedAt"
`;

const UPDATE_COLUMNS = `
  collab_update.sequence::text AS sequence,
  collab_update.document_id AS "documentId",
  collab_update.operation_id AS "operationId",
  collab_update.actor_id AS "actorId",
  actor.name AS "actorName",
  collab_update.update_data AS "updateData",
  collab_update.created_at AS "createdAt"
`;

const PRESENCE_COLUMNS = `
  presence.document_id AS "documentId",
  presence.session_id AS "sessionId",
  presence.user_id AS "userId",
  app_user.name AS "userName",
  presence.state,
  presence.updated_at AS "updatedAt"
`;

export function createPostgresCollaborationRepository(pool: Pool): CollaborationRepository {
  async function findAccessWithExecutor(
    executor: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>,
    documentId: string,
    userId: string,
  ): Promise<CollaborationDocumentAccess | null> {
    const result = await executor.query<DocumentAccessRow>(
      `SELECT ${DOCUMENT_ACCESS_COLUMNS}
       FROM collaboration_documents d
       JOIN collaboration_members member
         ON member.document_id = d.id AND member.user_id = $2
       WHERE d.id = $1`,
      [documentId, userId],
    );
    return result.rows[0] ? toDocumentAccess(result.rows[0]) : null;
  }

  return {
    async listDocuments(userId) {
      const result = await pool.query<DocumentAccessRow>(
        `SELECT ${DOCUMENT_ACCESS_COLUMNS}
         FROM collaboration_documents d
         JOIN collaboration_members member
           ON member.document_id = d.id AND member.user_id = $1
         ORDER BY d.updated_at DESC, d.id`,
        [userId],
      );
      return result.rows.map(toDocumentAccess);
    },

    findDocumentAccess(documentId, userId) {
      return findAccessWithExecutor(pool, documentId, userId);
    },

    async createDocument(input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO collaboration_documents (id, owner_id, title)
           VALUES ($1, $2, $3)`,
          [input.id, input.ownerId, input.title],
        );
        await client.query(
          `INSERT INTO collaboration_members (document_id, user_id, role)
           VALUES ($1, $2, 'owner')`,
          [input.id, input.ownerId],
        );
        if (input.initialUpdate) {
          await client.query(
            `INSERT INTO collaboration_updates (
               document_id, operation_id, actor_id, update_data
             ) VALUES ($1, $2, $3, $4)`,
            [
              input.id,
              input.initialUpdate.operationId,
              input.ownerId,
              input.initialUpdate.updateData,
            ],
          );
        }
        const document = await findAccessWithExecutor(client, input.id, input.ownerId);
        if (!document) throw new Error('Failed to create collaboration document');
        await client.query('COMMIT');
        return document;
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async deleteDocument(documentId) {
      const result = await pool.query('DELETE FROM collaboration_documents WHERE id = $1', [
        documentId,
      ]);
      return result.rowCount === 1;
    },

    async listMembers(documentId) {
      const result = await pool.query<MemberRow>(
        `SELECT ${MEMBER_COLUMNS}
         FROM collaboration_members member
         JOIN users app_user ON app_user.id = member.user_id
         WHERE member.document_id = $1
         ORDER BY CASE member.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,
                  member.created_at,
                  member.user_id`,
        [documentId],
      );
      return result.rows;
    },

    async addMember(documentId, userId, role) {
      const result = await pool.query<MemberRow>(
        `WITH inserted AS (
           INSERT INTO collaboration_members (document_id, user_id, role)
           VALUES ($1, $2, $3)
           ON CONFLICT (document_id, user_id) DO NOTHING
           RETURNING *
         )
         SELECT
           inserted.document_id AS "documentId",
           inserted.user_id AS "userId",
           app_user.email,
           app_user.name,
           inserted.role,
           inserted.created_at AS "createdAt",
           inserted.updated_at AS "updatedAt"
         FROM inserted
         JOIN users app_user ON app_user.id = inserted.user_id`,
        [documentId, userId, role],
      );
      return result.rows[0] ?? null;
    },

    async updateMemberRole(documentId, userId, role) {
      const result = await pool.query<MemberRow>(
        `WITH updated AS (
           UPDATE collaboration_members
           SET role = $3, updated_at = now()
           WHERE document_id = $1 AND user_id = $2 AND role <> 'owner'
           RETURNING *
         )
         SELECT
           updated.document_id AS "documentId",
           updated.user_id AS "userId",
           app_user.email,
           app_user.name,
           updated.role,
           updated.created_at AS "createdAt",
           updated.updated_at AS "updatedAt"
         FROM updated
         JOIN users app_user ON app_user.id = updated.user_id`,
        [documentId, userId, role],
      );
      return result.rows[0] ?? null;
    },

    async removeMember(documentId, userId) {
      const result = await pool.query(
        `WITH removed AS (
           DELETE FROM collaboration_members
           WHERE document_id = $1 AND user_id = $2 AND role <> 'owner'
           RETURNING user_id
         ), cleaned AS (
           DELETE FROM collaboration_presence
           WHERE document_id = $1 AND user_id IN (SELECT user_id FROM removed)
         ) SELECT user_id FROM removed`,
        [documentId, userId],
      );
      return result.rowCount === 1;
    },

    async appendUpdate(input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Allocate sequence numbers only after taking the document lock: commit order
        // must match sequence order so polling clients never skip an in-flight update.
        await client.query('SELECT id FROM collaboration_documents WHERE id = $1 FOR UPDATE', [
          input.documentId,
        ]);
        const membership = await client.query(
          `SELECT role FROM collaboration_members
           WHERE document_id = $1 AND user_id = $2 AND role IN ('owner', 'editor') FOR SHARE`,
          [input.documentId, input.actorId],
        );
        if (!membership.rowCount)
          throw new AppError(403, 'COLLABORATION_FORBIDDEN', 'Insufficient document permissions');
        const inserted = await client.query<UpdateRow>(
          `WITH inserted AS (
             INSERT INTO collaboration_updates (
               document_id, operation_id, actor_id, update_data
             ) VALUES ($1, $2, $3, $4)
             ON CONFLICT (document_id, operation_id) DO NOTHING
             RETURNING *
           )
           SELECT ${UPDATE_COLUMNS}
           FROM inserted collab_update
           JOIN users actor ON actor.id = collab_update.actor_id`,
          [input.documentId, input.operationId, input.actorId, input.updateData],
        );
        let update = inserted.rows[0];
        if (update) {
          await client.query(
            'UPDATE collaboration_documents SET updated_at = now() WHERE id = $1',
            [input.documentId],
          );
        } else {
          const existing = await client.query<UpdateRow>(
            `SELECT ${UPDATE_COLUMNS}
             FROM collaboration_updates collab_update
             JOIN users actor ON actor.id = collab_update.actor_id
             WHERE collab_update.document_id = $1 AND collab_update.operation_id = $2`,
            [input.documentId, input.operationId],
          );
          update = existing.rows[0];
        }
        if (!update) throw new Error('Failed to append collaboration update');
        if (update.actorId !== input.actorId || !update.updateData.equals(input.updateData)) {
          throw new AppError(
            409,
            'COLLABORATION_OPERATION_CONFLICT',
            'Operation ID already has different content or author',
          );
        }
        await client.query('COMMIT');
        return update;
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async listUpdates(documentId, afterSequence, limit) {
      const result = await pool.query<UpdateRow>(
        `SELECT ${UPDATE_COLUMNS}
         FROM collaboration_updates collab_update
         JOIN users actor ON actor.id = collab_update.actor_id
         WHERE collab_update.document_id = $1 AND collab_update.sequence > $2::bigint
         ORDER BY collab_update.sequence
         LIMIT $3`,
        [documentId, afterSequence, limit],
      );
      return result.rows;
    },

    async upsertPresence(input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const membership = await client.query(
          'SELECT role FROM collaboration_members WHERE document_id = $1 AND user_id = $2 FOR SHARE',
          [input.documentId, input.userId],
        );
        if (!membership.rowCount)
          throw new AppError(403, 'COLLABORATION_FORBIDDEN', 'Insufficient document permissions');
        const result = await client.query<PresenceRow>(
          `WITH saved AS (
           INSERT INTO collaboration_presence (
             document_id, session_id, user_id, state
           ) VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (document_id, session_id) DO UPDATE SET
             user_id = EXCLUDED.user_id,
             state = EXCLUDED.state,
             updated_at = now()
           WHERE collaboration_presence.user_id = EXCLUDED.user_id
           RETURNING *
         )
         SELECT
           saved.document_id AS "documentId",
           saved.session_id AS "sessionId",
           saved.user_id AS "userId",
           app_user.name AS "userName",
           saved.state,
           saved.updated_at AS "updatedAt"
         FROM saved
         JOIN users app_user ON app_user.id = saved.user_id`,
          [input.documentId, input.sessionId, input.userId, JSON.stringify(input.state)],
        );
        const entry = result.rows[0];
        if (!entry)
          throw new AppError(
            409,
            'COLLABORATION_SESSION_CONFLICT',
            'Session belongs to another user',
          );
        await client.query(
          "DELETE FROM collaboration_presence WHERE document_id = $1 AND updated_at < now() - interval '60 seconds'",
          [input.documentId],
        );
        await client.query('COMMIT');
        return entry;
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async listPresence(documentId, activeSince) {
      const result = await pool.query<PresenceRow>(
        `SELECT ${PRESENCE_COLUMNS}
         FROM collaboration_presence presence
         JOIN users app_user ON app_user.id = presence.user_id
         JOIN collaboration_members member ON member.document_id = presence.document_id AND member.user_id = presence.user_id
         WHERE presence.document_id = $1 AND presence.updated_at >= $2
         ORDER BY presence.updated_at, presence.session_id`,
        [documentId, activeSince],
      );
      return result.rows;
    },

    async removePresence(documentId, sessionId, userId) {
      const result = await pool.query(
        `DELETE FROM collaboration_presence
         WHERE document_id = $1 AND session_id = $2 AND user_id = $3`,
        [documentId, sessionId, userId],
      );
      return result.rowCount === 1;
    },
  };
}

function toDocumentAccess(row: DocumentAccessRow): CollaborationDocumentAccess {
  return {
    ...row,
    memberCount: Number(row.memberCount),
  };
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original database error.
  }
}
