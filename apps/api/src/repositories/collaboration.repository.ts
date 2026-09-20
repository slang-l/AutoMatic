import type {
  AppendCollaborationUpdateInput,
  CollaborationDocumentAccess,
  CollaborationMember,
  CollaborationPresence,
  CollaborationRole,
  CollaborationUpdate,
  CreateCollaborationDocumentInput,
  UpsertCollaborationPresenceInput,
} from '../type/collaboration.js';

export interface CollaborationRepository {
  listDocuments(userId: string): Promise<CollaborationDocumentAccess[]>;
  findDocumentAccess(
    documentId: string,
    userId: string,
  ): Promise<CollaborationDocumentAccess | null>;
  createDocument(input: CreateCollaborationDocumentInput): Promise<CollaborationDocumentAccess>;
  deleteDocument(documentId: string): Promise<boolean>;
  listMembers(documentId: string): Promise<CollaborationMember[]>;
  addMember(
    documentId: string,
    userId: string,
    role: Exclude<CollaborationRole, 'owner'>,
  ): Promise<CollaborationMember | null>;
  updateMemberRole(
    documentId: string,
    userId: string,
    role: Exclude<CollaborationRole, 'owner'>,
  ): Promise<CollaborationMember | null>;
  removeMember(documentId: string, userId: string): Promise<boolean>;
  appendUpdate(input: AppendCollaborationUpdateInput): Promise<CollaborationUpdate>;
  listUpdates(
    documentId: string,
    afterSequence: string,
    limit: number,
  ): Promise<CollaborationUpdate[]>;
  upsertPresence(input: UpsertCollaborationPresenceInput): Promise<CollaborationPresence>;
  listPresence(documentId: string, activeSince: Date): Promise<CollaborationPresence[]>;
  removePresence(documentId: string, sessionId: string, userId: string): Promise<boolean>;
}
