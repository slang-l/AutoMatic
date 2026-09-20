export type CollaborationRole = 'owner' | 'editor' | 'viewer';

export interface CollaborationDocument {
  id: string;
  ownerId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CollaborationDocumentAccess extends CollaborationDocument {
  role: CollaborationRole;
  memberCount: number;
  latestSequence: string | null;
}

export interface CollaborationMember {
  documentId: string;
  userId: string;
  email: string;
  name: string;
  role: CollaborationRole;
  createdAt: Date;
  updatedAt: Date;
}

export interface CollaborationUpdate {
  sequence: string;
  documentId: string;
  operationId: string;
  actorId: string;
  actorName: string;
  updateData: Buffer;
  createdAt: Date;
}

export interface CollaborationPresence {
  documentId: string;
  sessionId: string;
  userId: string;
  userName: string;
  state: Record<string, unknown>;
  updatedAt: Date;
}

export interface CreateCollaborationDocumentInput {
  id: string;
  ownerId: string;
  title: string;
  initialUpdate?: {
    operationId: string;
    updateData: Buffer;
  };
}

export interface AppendCollaborationUpdateInput {
  documentId: string;
  operationId: string;
  actorId: string;
  updateData: Buffer;
}

export interface UpsertCollaborationPresenceInput {
  documentId: string;
  sessionId: string;
  userId: string;
  state: Record<string, unknown>;
}
