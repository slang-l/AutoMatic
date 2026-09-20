import type { AuthRepository } from './auth.repository.js';
import { AppError } from '../errors.js';
import type { CollaborationRepository } from './collaboration.repository.js';
import type {
  CollaborationDocument,
  CollaborationDocumentAccess,
  CollaborationMember,
  CollaborationPresence,
  CollaborationRole,
  CollaborationUpdate,
} from '../type/collaboration.js';

interface StoredMember {
  documentId: string;
  userId: string;
  role: CollaborationRole;
  createdAt: Date;
  updatedAt: Date;
}

export function createMemoryCollaborationRepository(
  authRepository: AuthRepository,
): CollaborationRepository {
  const documents = new Map<string, CollaborationDocument>();
  const members = new Map<string, StoredMember>();
  const updates = new Map<string, CollaborationUpdate[]>();
  const presence = new Map<string, CollaborationPresence>();
  let nextSequence = 1n;

  const memberKey = (documentId: string, userId: string) => `${documentId}:${userId}`;
  const presenceKey = (documentId: string, sessionId: string) => `${documentId}:${sessionId}`;

  function toAccess(
    document: CollaborationDocument,
    member: StoredMember,
  ): CollaborationDocumentAccess {
    const documentUpdates = updates.get(document.id) ?? [];
    return {
      ...cloneDocument(document),
      role: member.role,
      memberCount: [...members.values()].filter((candidate) => candidate.documentId === document.id)
        .length,
      latestSequence: documentUpdates.at(-1)?.sequence ?? null,
    };
  }

  async function toMember(member: StoredMember): Promise<CollaborationMember> {
    const user = await authRepository.findUserById(member.userId);
    if (!user) throw new Error('Collaboration member references a missing user');
    return {
      ...cloneStoredMember(member),
      email: user.email,
      name: user.name,
    };
  }

  return {
    async listDocuments(userId) {
      return [...members.values()]
        .filter((member) => member.userId === userId)
        .flatMap((member) => {
          const document = documents.get(member.documentId);
          return document ? [toAccess(document, member)] : [];
        })
        .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
    },

    async findDocumentAccess(documentId, userId) {
      const document = documents.get(documentId);
      const member = members.get(memberKey(documentId, userId));
      return document && member ? toAccess(document, member) : null;
    },

    async createDocument(input) {
      if (documents.has(input.id)) throw new Error('COLLABORATION_DOCUMENT_ALREADY_EXISTS');
      const now = new Date();
      const document: CollaborationDocument = {
        id: input.id,
        ownerId: input.ownerId,
        title: input.title,
        createdAt: now,
        updatedAt: now,
      };
      const owner: StoredMember = {
        documentId: input.id,
        userId: input.ownerId,
        role: 'owner',
        createdAt: now,
        updatedAt: now,
      };
      documents.set(document.id, document);
      members.set(memberKey(document.id, owner.userId), owner);
      updates.set(document.id, []);

      if (input.initialUpdate) {
        const update: CollaborationUpdate = {
          sequence: String(nextSequence++),
          documentId: document.id,
          operationId: input.initialUpdate.operationId,
          actorId: input.ownerId,
          actorName: (await authRepository.findUserById(input.ownerId))?.name ?? '',
          updateData: Buffer.from(input.initialUpdate.updateData),
          createdAt: now,
        };
        updates.get(document.id)?.push(update);
      }

      return toAccess(document, owner);
    },

    async deleteDocument(documentId) {
      if (!documents.delete(documentId)) return false;
      updates.delete(documentId);
      for (const [key, member] of members) {
        if (member.documentId === documentId) members.delete(key);
      }
      for (const [key, entry] of presence) {
        if (entry.documentId === documentId) presence.delete(key);
      }
      return true;
    },

    async listMembers(documentId) {
      const result = await Promise.all(
        [...members.values()].filter((member) => member.documentId === documentId).map(toMember),
      );
      return result.sort((left, right) => {
        if (left.role === 'owner') return -1;
        if (right.role === 'owner') return 1;
        return left.createdAt.getTime() - right.createdAt.getTime();
      });
    },

    async addMember(documentId, userId, role) {
      if (!documents.has(documentId) || members.has(memberKey(documentId, userId))) return null;
      const now = new Date();
      const member: StoredMember = {
        documentId,
        userId,
        role,
        createdAt: now,
        updatedAt: now,
      };
      members.set(memberKey(documentId, userId), member);
      return toMember(member);
    },

    async updateMemberRole(documentId, userId, role) {
      const key = memberKey(documentId, userId);
      const member = members.get(key);
      if (!member || member.role === 'owner') return null;
      const updated = { ...member, role, updatedAt: new Date() };
      members.set(key, updated);
      return toMember(updated);
    },

    async removeMember(documentId, userId) {
      const key = memberKey(documentId, userId);
      const member = members.get(key);
      if (!member || member.role === 'owner') return false;
      const deleted = members.delete(key);
      for (const [key, entry] of presence) {
        if (entry.documentId === documentId && entry.userId === userId) presence.delete(key);
      }
      return deleted;
    },

    async appendUpdate(input) {
      const actor = await authRepository.findUserById(input.actorId);
      const member = members.get(memberKey(input.documentId, input.actorId));
      if (!member || member.role === 'viewer') {
        throw new AppError(403, 'COLLABORATION_FORBIDDEN', 'Insufficient document permissions');
      }
      const documentUpdates = updates.get(input.documentId);
      if (!documentUpdates) throw new Error('COLLABORATION_DOCUMENT_NOT_FOUND');
      const existing = documentUpdates.find((update) => update.operationId === input.operationId);
      if (existing) {
        if (existing.actorId !== input.actorId || !existing.updateData.equals(input.updateData)) {
          throw new AppError(
            409,
            'COLLABORATION_OPERATION_CONFLICT',
            'Operation ID already has different content or author',
          );
        }
        return cloneUpdate(existing);
      }

      const now = new Date();
      const update: CollaborationUpdate = {
        sequence: String(nextSequence++),
        documentId: input.documentId,
        operationId: input.operationId,
        actorId: input.actorId,
        actorName: actor?.name ?? '',
        updateData: Buffer.from(input.updateData),
        createdAt: now,
      };
      documentUpdates.push(update);
      const document = documents.get(input.documentId);
      if (document) document.updatedAt = now;
      return cloneUpdate(update);
    },

    async listUpdates(documentId, afterSequence, limit) {
      const cursor = BigInt(afterSequence);
      return (updates.get(documentId) ?? [])
        .filter((update) => BigInt(update.sequence) > cursor)
        .slice(0, limit)
        .map(cloneUpdate);
    },

    async upsertPresence(input) {
      const user = await authRepository.findUserById(input.userId);
      if (!user) throw new Error('Collaboration presence references a missing user');
      if (!members.has(memberKey(input.documentId, input.userId))) {
        throw new AppError(403, 'COLLABORATION_FORBIDDEN', 'Insufficient document permissions');
      }
      const existing = presence.get(presenceKey(input.documentId, input.sessionId));
      if (existing && existing.userId !== input.userId) {
        throw new AppError(
          409,
          'COLLABORATION_SESSION_CONFLICT',
          'Session belongs to another user',
        );
      }
      for (const [key, entry] of presence) {
        if (
          entry.documentId === input.documentId &&
          entry.updatedAt.getTime() < Date.now() - 60_000
        )
          presence.delete(key);
      }
      const entry: CollaborationPresence = {
        ...input,
        userName: user.name,
        state: structuredClone(input.state),
        updatedAt: new Date(),
      };
      presence.set(presenceKey(input.documentId, input.sessionId), entry);
      return clonePresence(entry);
    },

    async listPresence(documentId, activeSince) {
      return [...presence.values()]
        .filter((entry) => entry.documentId === documentId && entry.updatedAt >= activeSince)
        .sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime())
        .map(clonePresence);
    },

    async removePresence(documentId, sessionId, userId) {
      const key = presenceKey(documentId, sessionId);
      const entry = presence.get(key);
      return entry?.userId === userId ? presence.delete(key) : false;
    },
  };
}

function cloneDocument(document: CollaborationDocument): CollaborationDocument {
  return {
    ...document,
    createdAt: new Date(document.createdAt),
    updatedAt: new Date(document.updatedAt),
  };
}

function cloneStoredMember(member: StoredMember): StoredMember {
  return {
    ...member,
    createdAt: new Date(member.createdAt),
    updatedAt: new Date(member.updatedAt),
  };
}

function cloneUpdate(update: CollaborationUpdate): CollaborationUpdate {
  return {
    ...update,
    updateData: Buffer.from(update.updateData),
    createdAt: new Date(update.createdAt),
  };
}

function clonePresence(entry: CollaborationPresence): CollaborationPresence {
  return {
    ...entry,
    state: structuredClone(entry.state),
    updatedAt: new Date(entry.updatedAt),
  };
}
