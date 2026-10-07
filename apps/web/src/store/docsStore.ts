import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createStarterDoc } from '../data/mockDocs';
import { AuthApiError } from '../services/auth-api';
import {
  getArticleWorkspace,
  saveArticleWorkspace,
  type ArticleWorkspaceWrite,
} from '../services/articles-api';
import { recoverLocalArticles } from './article-recovery';
import type {
  AppDoc,
  ArticleWorkspaceData,
  NormalizedBlock,
  PublishRecord,
} from '../types/document';
import { nowIso } from '../utils/date';

export type { PublishRecord } from '../types/document';

const LEGACY_DOCS_STORAGE_KEY = 'block-notes-docs';
const DOCS_STORAGE_PREFIX = 'block-notes-docs-user';
const EMPTY_DOCS_STORAGE_KEY = 'block-notes-docs-no-session';
const LEGACY_OWNER_STORAGE_KEY = 'block-notes-docs-legacy-owner';

let activeDocsOwnerId: string | null = null;
let activeDocsOwnerLoaded = false;
let legacyImportOwnerId: string | null = null;
let docsHydrationPromise: Promise<void> | null = null;
let syncGeneration = 0;
let syncController = new AbortController();
let applyingWorkspace = false;
let changeSequence = 0;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = 3000;
let savingPromise: Promise<boolean> | null = null;
let pendingWrite: { input: ArticleWorkspaceWrite; sequence: number } | null = null;

interface EditorFlusher {
  flush: () => Promise<void>;
  isDirty: () => boolean;
}
const editorFlushers = new Set<EditorFlusher>();

function reportCacheFailure(): void {
  queueMicrotask(() => {
    if (!useDocsStore.getState().cacheError) {
      useDocsStore.setState({ cacheError: '浏览器缓存不可用，未保存的修改暂存在当前页面。' });
    }
  });
}

function readCache(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    reportCacheFailure();
    return null;
  }
}

function writeCache(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    reportCacheFailure();
  }
}

function removeCache(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    reportCacheFailure();
  }
}

export function registerArticleEditor(flusher: EditorFlusher): () => void {
  editorFlushers.add(flusher);
  return () => {
    editorFlushers.delete(flusher);
  };
}

export function hasUnsavedDocs(): boolean {
  return (
    useDocsStore.getState().hasPendingChanges ||
    [...editorFlushers].some((editor) => editor.isDirty())
  );
}

export function getDocsOwnerId() {
  return activeDocsOwnerId;
}

interface DocsState {
  serverRevision: number | null;
  hasPendingChanges: boolean;
  syncStatus: 'loading' | 'saved' | 'pending' | 'saving' | 'error' | 'conflict';
  syncError: string | null;
  cacheError: string | null;
  editorGeneration: number;
  publishRecords: PublishRecord[];
  savePublishRecord: (record: PublishRecord, ownerId?: string | null) => void;
  restoreDoc: (id: string) => void;
  permanentlyDeleteDoc: (id: string) => void;
  moveDoc: (id: string, parentId: string | null) => void;
  docs: AppDoc[];
  currentDocId: string;
  createDoc: (parentId?: string) => string;
  deleteDoc: (id: string) => void;
  setCurrentDocId: (id: string) => void;
  renameDoc: (id: string, title: string) => void;
  updateDocBlocks: (id: string, blocks: NormalizedBlock[]) => void;
}

export function descendantIds(docs: AppDoc[], id: string): Set<string> {
  const ids = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const doc of docs) {
      if (doc.parentId && ids.has(doc.parentId) && !ids.has(doc.id)) {
        ids.add(doc.id);
        changed = true;
      }
    }
  }
  return ids;
}

function touchDoc(doc: AppDoc, patch: Partial<AppDoc>): AppDoc {
  return {
    ...doc,
    ...patch,
    updatedAt: nowIso(),
  };
}

export const useDocsStore = create<DocsState>()(
  persist(
    (set, get) => ({
      serverRevision: null,
      hasPendingChanges: false,
      syncStatus: 'loading',
      syncError: null,
      cacheError: null,
      editorGeneration: 0,
      publishRecords: [],
      savePublishRecord: (record, ownerId) => {
        if (ownerId !== undefined && ownerId !== activeDocsOwnerId) return;
        set((state) => ({
          publishRecords: [
            record,
            ...state.publishRecords.filter((item) => item.publishId !== record.publishId),
          ],
        }));
      },
      moveDoc: (id, parentId) => {
        const docs = get().docs;
        if (
          parentId &&
          (!docs.some((doc) => doc.id === parentId && !doc.deletedAt) ||
            descendantIds(docs, id).has(parentId))
        )
          return;
        set({ docs: docs.map((doc) => (doc.id === id ? touchDoc(doc, { parentId }) : doc)) });
      },
      restoreDoc: (id) => {
        const docs = get().docs;
        const ids = descendantIds(docs, id);
        set({
          docs: docs.map((doc) =>
            ids.has(doc.id)
              ? {
                  ...doc,
                  deletedAt: undefined,
                  parentId:
                    doc.parentId &&
                    !ids.has(doc.parentId) &&
                    !docs.some((parent) => parent.id === doc.parentId && !parent.deletedAt)
                      ? null
                      : doc.parentId,
                }
              : doc,
          ),
        });
      },
      permanentlyDeleteDoc: (id) => {
        const docs = get().docs;
        if (!docs.find((doc) => doc.id === id)?.deletedAt) return;
        const ids = descendantIds(docs, id);
        set({ docs: docs.filter((doc) => !ids.has(doc.id) || !doc.deletedAt) });
      },
      docs: [],
      currentDocId: '',
      createDoc: (parentId) => {
        const doc = createStarterDoc(parentId);
        set((state) => ({
          docs: [doc, ...state.docs],
          currentDocId: doc.id,
        }));
        return doc.id;
      },
      deleteDoc: (id) => {
        const state = get();
        if (!state.docs.some((doc) => doc.id === id && !doc.deletedAt)) return;
        const ids = descendantIds(state.docs, id);
        const nextDocs = state.docs.map((doc) =>
          ids.has(doc.id) ? { ...doc, deletedAt: nowIso() } : doc,
        );
        let nextActive = nextDocs.find((doc) => !doc.deletedAt);
        if (!nextActive) {
          nextActive = createStarterDoc();
          nextDocs.unshift(nextActive);
        }
        const deletedCurrent = ids.has(state.currentDocId);
        set({
          docs: nextDocs,
          currentDocId: deletedCurrent ? nextActive.id : state.currentDocId,
        });
      },
      setCurrentDocId: (id) => {
        if (get().docs.some((doc) => doc.id === id && !doc.deletedAt)) {
          set({ currentDocId: id });
        }
      },
      renameDoc: (id, title) => {
        set((state) => ({
          docs: state.docs.map((doc) => {
            if (doc.id !== id || doc.title === title) {
              return doc;
            }

            const firstBlock = doc.blocks[0];
            const shouldSyncLegacyTitle =
              firstBlock?.type === 'heading' &&
              firstBlock.level === 1 &&
              firstBlock.text?.trim() === doc.title.trim();

            return touchDoc(doc, {
              title,
              blocks: shouldSyncLegacyTitle
                ? [{ ...firstBlock, text: title }, ...doc.blocks.slice(1)]
                : doc.blocks,
            });
          }),
        }));
      },
      updateDocBlocks: (id, blocks) => {
        set((state) => ({
          docs: state.docs.map((doc) => (doc.id === id ? touchDoc(doc, { blocks }) : doc)),
        }));
      },
    }),
    {
      name: EMPTY_DOCS_STORAGE_KEY,
      storage: createJSONStorage(() => ({
        getItem: readCache,
        removeItem: removeCache,
        setItem: writeCache,
      })),
      version: 1,
      skipHydration: true,
      merge: (persisted, current) => {
        const cached = persisted as Partial<DocsState> | undefined;
        if (
          !cached ||
          !Array.isArray(cached.docs) ||
          !cached.docs.every(
            (doc) =>
              doc &&
              typeof doc.id === 'string' &&
              typeof doc.title === 'string' &&
              Array.isArray(doc.blocks),
          ) ||
          (cached.publishRecords !== undefined && !Array.isArray(cached.publishRecords))
        ) {
          throw new Error('Invalid cached article workspace');
        }
        return {
          ...current,
          docs: cached.docs,
          currentDocId: cached.docs.some((doc) => doc.id === cached.currentDocId && !doc.deletedAt)
            ? cached.currentDocId!
            : (cached.docs.find((doc) => !doc.deletedAt)?.id ?? ''),
          publishRecords: cached.publishRecords ?? [],
          serverRevision:
            typeof cached.serverRevision === 'number' &&
            Number.isInteger(cached.serverRevision) &&
            cached.serverRevision >= 0
              ? cached.serverRevision
              : null,
          hasPendingChanges: cached.hasPendingChanges === true,
        };
      },
      partialize: (state) => ({
        publishRecords: state.publishRecords,
        docs: state.docs,
        currentDocId: state.currentDocId,
        serverRevision: state.serverRevision,
        hasPendingChanges: state.hasPendingChanges,
      }),
    },
  ),
);

function workspaceData(): ArticleWorkspaceData {
  const { docs, currentDocId, publishRecords } = useDocsStore.getState();
  return { docs, currentDocId, publishRecords };
}

function cancelSaveTimers(): void {
  clearTimeout(saveTimer);
  clearTimeout(maxWaitTimer);
  saveTimer = maxWaitTimer = undefined;
}

function resetSync(): void {
  syncGeneration++;
  syncController.abort();
  syncController = new AbortController();
  cancelSaveTimers();
  savingPromise = null;
  pendingWrite = null;
  retryDelay = 3000;
  changeSequence = 0;
}

function applyWorkspace(data: Partial<DocsState>): void {
  applyingWorkspace = true;
  try {
    useDocsStore.setState(data);
  } finally {
    applyingWorkspace = false;
  }
}

function describeSyncError(error: unknown): string {
  if (error instanceof AuthApiError) {
    if (error.status === 409)
      return '另一窗口或设备已修改文章，本地修改已保留。请恢复本地草稿后继续保存。';
    if (error.status === 413) return '文章和图片总量超过单次保存限制，请减少图片后重试。';
    if (error.status === 401) return '登录已过期，请刷新页面重新登录，未上传的修改已保留。';
    if (error.status === 400) return '文章数据无法保存，请检查内容后重试。';
  }
  return '暂时无法保存文章，修改已保留。请检查网络后重试。';
}

function markSyncFailure(error: unknown): void {
  useDocsStore.setState({
    syncStatus: error instanceof AuthApiError && error.status === 409 ? 'conflict' : 'error',
    syncError: describeSyncError(error),
  });
}

async function reconcileWorkspace(generation: number): Promise<void> {
  const remote = await getArticleWorkspace(syncController.signal);
  if (generation !== syncGeneration) return;
  const local = useDocsStore.getState();
  if (
    local.hasPendingChanges &&
    local.serverRevision !== null &&
    local.serverRevision !== remote.revision
  ) {
    useDocsStore.setState({
      syncStatus: 'conflict',
      syncError: describeSyncError(new AuthApiError(409, 'ARTICLE_REVISION_CONFLICT', 'Conflict')),
    });
    return;
  }
  if (local.serverRevision === null && local.docs.length > 0) {
    // First import into an empty cloud workspace, or merge legacy drafts as
    // copies when this account already has articles on another device.
    applyWorkspace({
      ...recoverLocalArticles(remote, workspaceData()),
      serverRevision: remote.revision,
      hasPendingChanges: true,
      syncStatus: 'pending',
      syncError: null,
    });
  } else if (local.hasPendingChanges) {
    useDocsStore.setState({ syncStatus: 'pending', syncError: null });
  } else if (remote.revision === 0) {
    const doc = createStarterDoc();
    applyWorkspace({
      docs: [doc],
      currentDocId: doc.id,
      publishRecords: [],
      serverRevision: 0,
      hasPendingChanges: true,
      syncStatus: 'pending',
      syncError: null,
    });
  } else {
    const { revision, ...data } = remote;
    const needsStarter = !data.docs.some((doc) => !doc.deletedAt);
    if (needsStarter) {
      const doc = createStarterDoc();
      data.docs = [doc, ...data.docs];
      data.currentDocId = doc.id;
    }
    applyWorkspace({
      ...data,
      serverRevision: revision,
      hasPendingChanges: needsStarter,
      syncStatus: needsStarter ? 'pending' : 'saved',
      syncError: null,
      editorGeneration: local.editorGeneration + (activeDocsOwnerLoaded ? 1 : 0),
    });
  }
}

/** Load from PostgreSQL on every new session. localStorage is an account-scoped
 * fallback/outbox; a clean cache never replaces newer server articles. */
export function loadDocsForUser(userId: string): Promise<void> {
  if (activeDocsOwnerId === userId) {
    if (docsHydrationPromise) return docsHydrationPromise;
    if (activeDocsOwnerLoaded) return Promise.resolve();
  }
  resetSync();
  const generation = syncGeneration;
  activeDocsOwnerId = userId;
  activeDocsOwnerLoaded = false;
  useDocsStore.persist.setOptions({ name: EMPTY_DOCS_STORAGE_KEY });
  applyWorkspace({
    docs: [],
    currentDocId: '',
    publishRecords: [],
    serverRevision: null,
    hasPendingChanges: false,
    syncStatus: 'loading',
    syncError: null,
    cacheError: null,
  });
  const storageKey = `${DOCS_STORAGE_PREFIX}:${userId}`;
  let cached = readCache(storageKey);
  let hydrationKey = storageKey;
  const legacyOwner = readCache(LEGACY_OWNER_STORAGE_KEY);
  legacyImportOwnerId = legacyOwner === userId ? userId : null;
  if (cached === null) {
    const legacy = readCache(LEGACY_DOCS_STORAGE_KEY);
    if (legacy !== null && (legacyOwner === null || legacyOwner === userId)) {
      // Read the original entry directly. Duplicating a large image workspace
      // first can exhaust localStorage quota before it reaches PostgreSQL.
      hydrationKey = LEGACY_DOCS_STORAGE_KEY;
      legacyImportOwnerId = userId;
      writeCache(LEGACY_OWNER_STORAGE_KEY, userId);
      cached = legacy;
    }
  }
  useDocsStore.persist.setOptions({ name: hydrationKey });
  const hydration = (async () => {
    let usableCache = cached !== null;
    if (cached !== null) {
      // Zustand reports hydration errors through this callback instead of
      // rejecting rehydrate(), so propagate corrupted caches explicitly.
      let hydrationError: unknown;
      useDocsStore.persist.setOptions({
        onRehydrateStorage: () => (_state, error) => {
          hydrationError = error;
        },
      });
      await useDocsStore.persist.rehydrate();
      if (generation !== syncGeneration) return;
      useDocsStore.persist.setOptions({ name: storageKey });
      if (hydrationError) {
        usableCache = false;
        // Preserve the raw entry for recovery, while still allowing a valid
        // cloud workspace to load instead of blocking account sign-in.
        writeCache(`block-notes-docs-recovery:${userId}`, cached);
        useDocsStore.setState({
          cacheError: '本地缓存无法读取，已保留原始副本并尝试载入已保存的文章。',
        });
      }
      if (
        useDocsStore.getState().serverRevision === null &&
        useDocsStore.getState().docs.length > 0
      ) {
        useDocsStore.setState({ hasPendingChanges: true });
      }
    }
    try {
      await reconcileWorkspace(generation);
    } catch (error) {
      if (generation !== syncGeneration) return;
      if (!usableCache) throw error;
      markSyncFailure(error);
    }
    if (generation !== syncGeneration) return;
    activeDocsOwnerLoaded = true;
    if (
      useDocsStore.getState().hasPendingChanges &&
      useDocsStore.getState().syncStatus !== 'conflict'
    ) {
      await savePendingWorkspace();
    }
  })().finally(() => {
    if (docsHydrationPromise === hydration) docsHydrationPromise = null;
  });
  docsHydrationPromise = hydration;
  return hydration;
}

function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void savePendingWorkspace();
  }, 700);
  maxWaitTimer ??= setTimeout(() => {
    void savePendingWorkspace();
  }, 5000);
}

function savePendingWorkspace(): Promise<boolean> {
  if (savingPromise) return savingPromise;
  cancelSaveTimers();
  if (!activeDocsOwnerLoaded) return Promise.resolve(false);
  if (useDocsStore.getState().syncStatus === 'conflict') return Promise.resolve(false);
  const generation = syncGeneration;
  const saving = (async () => {
    try {
      if (useDocsStore.getState().serverRevision === null) await reconcileWorkspace(generation);
      if (generation !== syncGeneration || useDocsStore.getState().syncStatus === 'conflict')
        return false;
      while (useDocsStore.getState().hasPendingChanges) {
        const state = useDocsStore.getState();
        pendingWrite ??= {
          input: {
            ...workspaceData(),
            revision: state.serverRevision!,
            writeId: crypto.randomUUID(),
          },
          sequence: changeSequence,
        };
        const write = pendingWrite;
        useDocsStore.setState({ syncStatus: 'saving', syncError: null });
        const result = await saveArticleWorkspace(write.input, syncController.signal);
        if (generation !== syncGeneration) return false;
        if (legacyImportOwnerId === activeDocsOwnerId) {
          removeCache(LEGACY_DOCS_STORAGE_KEY);
          removeCache(LEGACY_OWNER_STORAGE_KEY);
          legacyImportOwnerId = null;
        }
        pendingWrite = null;
        retryDelay = 3000;
        const hasPendingChanges = changeSequence !== write.sequence;
        useDocsStore.setState({
          serverRevision: result.revision,
          hasPendingChanges,
          syncStatus: hasPendingChanges ? 'pending' : 'saved',
          syncError: null,
        });
      }
      return true;
    } catch (error) {
      if (generation !== syncGeneration) return false;
      markSyncFailure(error);
      if (error instanceof AuthApiError && error.status < 500 && error.status !== 409) {
        // A rejected request did not commit. The next attempt must use the
        // corrected content, rather than endlessly resending a rejected body.
        pendingWrite = null;
      }
      if (!(error instanceof AuthApiError) || error.status >= 500) {
        saveTimer = setTimeout(() => {
          void savePendingWorkspace();
        }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      }
      return false;
    }
  })().finally(() => {
    if (savingPromise === saving) savingPromise = null;
  });
  savingPromise = saving;
  return saving;
}

/** Flush the editor's 120ms serialization buffer before saving or signing out. */
export async function flushDocsToServer(): Promise<boolean> {
  try {
    await Promise.all([...editorFlushers].map((editor) => editor.flush()));
  } catch (error) {
    markSyncFailure(error);
    return false;
  }
  return savePendingWorkspace();
}

export async function retryDocsSync(): Promise<boolean> {
  if (useDocsStore.getState().syncStatus === 'conflict') return false;
  try {
    await Promise.all([...editorFlushers].map((editor) => editor.flush()));
  } catch (error) {
    markSyncFailure(error);
    return false;
  }
  // Loading again is necessary when a cached workspace was opened offline,
  // including a clean cache whose first cloud read failed.
  if (!useDocsStore.getState().hasPendingChanges) {
    const generation = syncGeneration;
    try {
      await reconcileWorkspace(generation);
    } catch (error) {
      if (generation === syncGeneration) markSyncFailure(error);
      return false;
    }
  }
  return savePendingWorkspace();
}

export async function recoverDocsConflict(): Promise<boolean> {
  if (useDocsStore.getState().syncStatus !== 'conflict') return false;
  const generation = syncGeneration;
  try {
    await Promise.all([...editorFlushers].map((editor) => editor.flush()));
    const remote = await getArticleWorkspace(syncController.signal);
    if (generation !== syncGeneration) return false;
    const recovered = recoverLocalArticles(remote, workspaceData(), true);
    pendingWrite = null;
    changeSequence++;
    applyWorkspace({
      ...recovered,
      serverRevision: remote.revision,
      hasPendingChanges: true,
      syncStatus: 'pending',
      syncError: null,
      editorGeneration: useDocsStore.getState().editorGeneration + 1,
    });
    return savePendingWorkspace();
  } catch (error) {
    if (generation === syncGeneration)
      useDocsStore.setState({ syncError: describeSyncError(error) });
    return false;
  }
}

useDocsStore.subscribe((state, previous) => {
  if (applyingWorkspace || !activeDocsOwnerLoaded || !activeDocsOwnerId) return;
  if (
    state.docs === previous.docs &&
    state.publishRecords === previous.publishRecords &&
    state.currentDocId === previous.currentDocId
  )
    return;
  changeSequence++;
  useDocsStore.setState({
    hasPendingChanges: true,
    syncStatus: state.syncStatus === 'conflict' ? 'conflict' : 'pending',
  });
  if (state.syncStatus !== 'conflict') scheduleSave();
});

/** Clear memory without overwriting the previous account's cached outbox. */
export function clearDocsFromMemory(): void {
  resetSync();
  activeDocsOwnerId = null;
  activeDocsOwnerLoaded = false;
  docsHydrationPromise = null;
  useDocsStore.persist.setOptions({ name: EMPTY_DOCS_STORAGE_KEY });
  applyWorkspace({
    docs: [],
    currentDocId: '',
    publishRecords: [],
    serverRevision: null,
    hasPendingChanges: false,
    syncStatus: 'loading',
    syncError: null,
    cacheError: null,
  });
}
