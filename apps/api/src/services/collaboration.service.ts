import { randomUUID } from 'node:crypto';

import { AppError } from '../errors.js';
import type { AuthRepository } from '../repositories/auth.repository.js';
import type { CollaborationRepository } from '../repositories/collaboration.repository.js';
import type { CollaborationRole, CollaborationUpdate } from '../type/collaboration.js';

export const PRESENCE_TTL_MS = 60_000;

export function createCollaborationService(
  repository: CollaborationRepository,
  authRepository: AuthRepository,
) {
  async function access(userId: string, documentId: string, roles?: CollaborationRole[]) {
    const document = await repository.findDocumentAccess(documentId, userId);
    if (!document) {
      throw new AppError(404, 'COLLABORATION_DOCUMENT_NOT_FOUND', 'Document not found');
    }
    if (roles && !roles.includes(document.role)) {
      throw new AppError(403, 'COLLABORATION_FORBIDDEN', 'Insufficient document permissions');
    }
    return document;
  }

  return {
    list: (userId: string) => repository.listDocuments(userId),
    get: access,
    async create(
      userId: string,
      input: { title: string; initialUpdate?: { operationId: string; data: string } },
    ) {
      return repository.createDocument({
        id: randomUUID(),
        ownerId: userId,
        title: input.title,
        initialUpdate: input.initialUpdate && {
          operationId: input.initialUpdate.operationId,
          updateData: Buffer.from(input.initialUpdate.data, 'base64'),
        },
      });
    },
    async delete(userId: string, documentId: string) {
      await access(userId, documentId, ['owner']);
      await repository.deleteDocument(documentId);
    },
    async members(userId: string, documentId: string) {
      await access(userId, documentId);
      return repository.listMembers(documentId);
    },
    async addMember(userId: string, documentId: string, email: string, role: 'editor' | 'viewer') {
      await access(userId, documentId, ['owner']);
      const user = await authRepository.findUserByEmail(email);
      if (!user || user.status !== 'active') {
        throw new AppError(404, 'COLLABORATION_USER_NOT_FOUND', 'Active user not found');
      }
      const member = await repository.addMember(documentId, user.id, role);
      if (!member)
        throw new AppError(409, 'COLLABORATION_MEMBER_EXISTS', 'User is already a member');
      return member;
    },
    async updateMember(
      userId: string,
      documentId: string,
      memberId: string,
      role: 'editor' | 'viewer',
    ) {
      const document = await access(userId, documentId, ['owner']);
      if (memberId === document.ownerId)
        throw new AppError(403, 'COLLABORATION_OWNER_PROTECTED', 'Cannot change the owner');
      const member = await repository.updateMemberRole(documentId, memberId, role);
      if (!member) throw new AppError(404, 'COLLABORATION_MEMBER_NOT_FOUND', 'Member not found');
      return member;
    },
    async removeMember(userId: string, documentId: string, memberId: string) {
      const document = await access(userId, documentId, ['owner']);
      if (memberId === document.ownerId)
        throw new AppError(403, 'COLLABORATION_OWNER_PROTECTED', 'Cannot remove the owner');
      if (!(await repository.removeMember(documentId, memberId))) {
        throw new AppError(404, 'COLLABORATION_MEMBER_NOT_FOUND', 'Member not found');
      }
    },
    async append(userId: string, documentId: string, input: { operationId: string; data: string }) {
      await access(userId, documentId, ['owner', 'editor']);
      return serializeUpdate(
        await repository.appendUpdate({
          documentId,
          actorId: userId,
          operationId: input.operationId,
          updateData: Buffer.from(input.data, 'base64'),
        }),
      );
    },
    async updates(userId: string, documentId: string, after: string, limit: number) {
      await access(userId, documentId);
      const rows = await repository.listUpdates(documentId, after, limit + 1);
      const updates = rows.slice(0, limit);
      return {
        updates: updates.map(serializeUpdate),
        nextCursor: updates.at(-1)?.sequence ?? after,
        hasMore: rows.length > limit,
      };
    },
    async presence(userId: string, documentId: string) {
      await access(userId, documentId);
      return repository.listPresence(documentId, new Date(Date.now() - PRESENCE_TTL_MS));
    },
    async heartbeat(
      userId: string,
      documentId: string,
      sessionId: string,
      state: Record<string, unknown>,
    ) {
      await access(userId, documentId);
      return repository.upsertPresence({ documentId, userId, sessionId, state });
    },
    async leave(userId: string, documentId: string, sessionId: string) {
      await access(userId, documentId);
      await repository.removePresence(documentId, sessionId, userId);
    },
  };
}

function serializeUpdate({ updateData, ...update }: CollaborationUpdate) {
  return { ...update, data: updateData.toString('base64') };
}

export type CollaborationService = ReturnType<typeof createCollaborationService>;
