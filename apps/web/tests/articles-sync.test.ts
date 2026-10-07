import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { ArticleServer, installBrowserStorage } from './helpers/article-server';

const { entries, storage } = installBrowserStorage();
let server = new ArticleServer();
globalThis.fetch = (input, init) => server.fetch(input, init);
const { login } = await import('../src/services/auth-api');
const { authenticatedRequest, AuthApiError } = await import('../src/services/auth-api');
const {
  useDocsStore: store,
  loadDocsForUser,
  clearDocsFromMemory,
  flushDocsToServer,
  recoverDocsConflict,
  retryDocsSync,
  registerArticleEditor,
} = await import('../src/store/docsStore');

async function signIn(owner = 'owner') {
  await login({ email: owner, password: 'unused' });
  await loadDocsForUser(owner);
}

beforeEach(async () => {
  clearDocsFromMemory();
  entries.clear();
  server = new ArticleServer();
  await signIn();
});
afterEach(() => clearDocsFromMemory());

test('articles load from the server in a fresh browser and an old clean cache cannot restore a deleted article', async () => {
  const id = store.getState().currentDocId;
  store.getState().renameDoc(id, 'Persistent article');
  const blocks = [
    {
      id: 'rich',
      type: 'paragraph' as const,
      text: 'Last edit',
      delta: [{ insert: 'Last edit', attributes: { bold: true as const } }],
    },
    { id: 'image', type: 'image' as const, url: 'data:image/png;base64,aGVsbG8=' },
  ];
  store.getState().updateDocBlocks(id, blocks);
  assert.equal(await flushDocsToServer(), true);
  const oldCache = storage.getItem('block-notes-docs-user:owner')!;
  clearDocsFromMemory();
  entries.clear();
  await signIn();
  assert.equal(store.getState().docs[0].title, 'Persistent article');
  assert.deepEqual(store.getState().docs[0].blocks, blocks);
  store.getState().deleteDoc(id);
  store.getState().permanentlyDeleteDoc(id);
  await flushDocsToServer();
  clearDocsFromMemory();
  storage.setItem('block-notes-docs-user:owner', oldCache);
  await signIn();
  assert.ok(!store.getState().docs.some((doc) => doc.id === id));
});

test('legacy local drafts migrate once and a conflicting legacy tree imports as copies', async () => {
  const remote = server.workspaces.get('owner')!;
  const id = remote.docs[0].id;
  const child = { ...remote.docs[0], id: 'legacy-child', parentId: id, title: 'Legacy child' };
  clearDocsFromMemory();
  entries.clear();
  storage.setItem(
    'block-notes-docs',
    JSON.stringify({
      version: 1,
      state: {
        docs: [{ ...remote.docs[0], title: 'Local version' }, child],
        currentDocId: 'legacy-child',
      },
    }),
  );
  await signIn();
  const cloud = server.workspaces.get('owner')!;
  assert.equal(cloud.docs.length, 3);
  assert.equal(cloud.docs.find((doc) => doc.id === id)?.title, remote.docs[0].title);
  const imported = cloud.docs.find((doc) => doc.title === 'Local version')!;
  assert.notEqual(imported.id, id);
  assert.equal(cloud.docs.find((doc) => doc.id === child.id)?.parentId, imported.id);
  assert.equal(storage.getItem('block-notes-docs'), null);
  clearDocsFromMemory();
  await signIn();
  assert.equal(store.getState().docs.length, 3);
});

test('offline changes survive sign-out/reload and retry; failed saves never show saved', async () => {
  const id = store.getState().currentDocId;
  server.failPut = true;
  store.getState().renameDoc(id, 'Offline draft');
  assert.equal(await flushDocsToServer(), false);
  assert.equal(store.getState().syncStatus, 'error');
  assert.equal(store.getState().hasPendingChanges, true);
  clearDocsFromMemory();
  server.failGet = true;
  await signIn();
  assert.equal(store.getState().docs.find((doc) => doc.id === id)?.title, 'Offline draft');
  server.failGet = server.failPut = false;
  assert.equal(await retryDocsSync(), true);
  assert.equal(server.workspaces.get('owner')!.docs[0].title, 'Offline draft');
  assert.equal(store.getState().syncStatus, 'saved');
});

test('an acknowledged database commit with a lost response retries the same write and then saves newer edits', async () => {
  const id = store.getState().currentDocId;
  server.loseResponse = true;
  store.getState().renameDoc(id, 'Committed');
  assert.equal(await flushDocsToServer(), false);
  const lost = server.writes.at(-1)!;
  store.getState().renameDoc(id, 'Newer edit');
  assert.equal(await flushDocsToServer(), true);
  assert.equal(server.writes.at(-2)!.writeId, lost.writeId);
  assert.equal(server.workspaces.get('owner')!.docs[0].title, 'Newer edit');
  assert.equal(store.getState().hasPendingChanges, false);
});

test('edits made while a save is in flight are saved in the next revision', async () => {
  const id = store.getState().currentDocId;
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  server.beforePut = () =>
    new Promise<void>((resolve) => {
      release = resolve;
      entered();
    });
  store.getState().renameDoc(id, 'First edit');
  const saving = flushDocsToServer();
  await started;
  store.getState().renameDoc(id, 'Final edit');
  server.beforePut = null;
  release();
  assert.equal(await saving, true);
  assert.equal(server.workspaces.get('owner')!.docs[0].title, 'Final edit');
  assert.equal(store.getState().serverRevision, 3);
});

test('conflicts preserve local changes and recovery saves them as copies without overwriting cloud content', async () => {
  const id = store.getState().currentDocId;
  const cloud = structuredClone(server.workspaces.get('owner')!);
  cloud.revision++;
  cloud.docs[0].title = 'Other device';
  server.workspaces.set('owner', cloud);
  store.getState().renameDoc(id, 'Local edit');
  assert.equal(await flushDocsToServer(), false);
  assert.equal(store.getState().syncStatus, 'conflict');
  assert.equal(store.getState().docs[0].title, 'Local edit');
  assert.equal(await recoverDocsConflict(), true);
  assert.equal(
    server.workspaces.get('owner')!.docs.find((doc) => doc.id === id)!.title,
    'Other device',
  );
  assert.ok(
    server.workspaces.get('owner')!.docs.some((doc) => doc.title === 'Local edit（恢复的草稿）'),
  );
  assert.equal(store.getState().editorGeneration, 1);
});

test('a stale pending cache after reload reports a conflict and remains intact', async () => {
  store.getState().renameDoc(store.getState().currentDocId, 'Unsent draft');
  clearDocsFromMemory();
  const cloud = structuredClone(server.workspaces.get('owner')!);
  cloud.revision++;
  cloud.docs[0].title = 'Remote draft';
  server.workspaces.set('owner', cloud);
  await signIn();
  assert.equal(store.getState().syncStatus, 'conflict');
  assert.equal(store.getState().docs[0].title, 'Unsent draft');
});

test('delayed responses from a previous account cannot alter the new account cache or revision', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  server.beforePut = () =>
    new Promise<void>((resolve) => {
      release = resolve;
      entered();
    });
  store.getState().renameDoc(store.getState().currentDocId, 'First account draft');
  const saving = flushDocsToServer();
  await started;
  clearDocsFromMemory();
  server.beforePut = null;
  await signIn('other');
  const other = structuredClone(store.getState().docs);
  release();
  await saving;
  assert.deepEqual(store.getState().docs, other);
  assert.equal(store.getState().serverRevision, 1);
});

test('manual save waits for the active editor serialization before uploading', async () => {
  const id = store.getState().currentDocId;
  const unregister = registerArticleEditor({
    isDirty: () => true,
    flush: async () => {
      await Promise.resolve();
      store
        .getState()
        .updateDocBlocks(id, [{ id: 'last', type: 'paragraph', text: 'Last keystroke' }]);
    },
  });
  try {
    assert.equal(await flushDocsToServer(), true);
    assert.equal(server.workspaces.get('owner')!.docs[0].blocks[0].text, 'Last keystroke');
  } finally {
    unregister();
  }
});

test('editing automatically saves after the debounce without a manual save', async () => {
  store.getState().renameDoc(store.getState().currentDocId, 'Autosaved article');
  await new Promise((resolve) => setTimeout(resolve, 850));
  assert.equal(server.workspaces.get('owner')!.docs[0].title, 'Autosaved article');
  assert.equal(store.getState().syncStatus, 'saved');
});

test('a rejected save can be corrected instead of indefinitely retrying the rejected payload', async () => {
  const id = store.getState().currentDocId;
  server.rejectPut = 413;
  store.getState().renameDoc(id, 'Rejected content');
  assert.equal(await flushDocsToServer(), false);
  const rejectedId = server.writes.at(-1)!.writeId;
  server.rejectPut = null;
  store.getState().renameDoc(id, 'Corrected content');
  assert.equal(await flushDocsToServer(), true);
  assert.notEqual(server.writes.at(-1)!.writeId, rejectedId);
  assert.equal(server.workspaces.get('owner')!.docs[0].title, 'Corrected content');
});

test('an initialized workspace with no active articles opens an editable new article', async () => {
  clearDocsFromMemory();
  entries.clear();
  server.workspaces.set('owner', { revision: 7, docs: [], currentDocId: '', publishRecords: [] });
  await signIn();
  assert.equal(store.getState().docs.length, 1);
  assert.equal(store.getState().currentDocId, store.getState().docs[0].id);
  assert.equal(server.workspaces.get('owner')!.revision, 8);
});

test('cloud articles remain usable when browser caching is disabled', async () => {
  clearDocsFromMemory();
  const getItem = storage.getItem;
  const setItem = storage.setItem;
  storage.getItem = () => {
    throw new DOMException('Storage blocked', 'SecurityError');
  };
  storage.setItem = () => {
    throw new DOMException('Storage blocked', 'SecurityError');
  };
  try {
    await signIn();
    const id = store.getState().currentDocId;
    store.getState().renameDoc(id, 'Saved without browser storage');
    assert.equal(await flushDocsToServer(), true);
    assert.equal(server.workspaces.get('owner')!.docs[0].title, 'Saved without browser storage');
  } finally {
    storage.getItem = getItem;
    storage.setItem = setItem;
  }
});

test('legacy drafts can migrate without duplicating the original entry when browser storage is full', async () => {
  const local = structuredClone(server.workspaces.get('owner')!);
  clearDocsFromMemory();
  entries.clear();
  server.workspaces.delete('owner');
  storage.setItem('block-notes-docs', JSON.stringify({ version: 1, state: local }));
  const setItem = storage.setItem;
  storage.setItem = () => {
    throw new DOMException('Storage full', 'QuotaExceededError');
  };
  try {
    await signIn();
    assert.equal(server.workspaces.get('owner')!.docs[0].id, local.docs[0].id);
    assert.equal(storage.getItem('block-notes-docs'), null);
  } finally {
    storage.setItem = setItem;
  }
});

test('a legacy workspace imports into an empty database with its original IDs and trash', async () => {
  const local = structuredClone(server.workspaces.get('owner')!);
  const deleted = { ...local.docs[0], id: 'trashed-legacy', deletedAt: new Date().toISOString() };
  local.docs.push(deleted);
  clearDocsFromMemory();
  server.workspaces.delete('owner');
  entries.clear();
  storage.setItem(
    'block-notes-docs-user:owner',
    JSON.stringify({
      version: 1,
      state: {
        docs: local.docs,
        currentDocId: local.currentDocId,
      },
    }),
  );
  await signIn();
  assert.equal(server.workspaces.get('owner')!.revision, 1);
  assert.deepEqual(
    server.workspaces.get('owner')!.docs.map((doc) => doc.id),
    local.docs.map((doc) => doc.id),
  );
  assert.equal(server.workspaces.get('owner')!.docs.at(-1)!.deletedAt, deleted.deletedAt);
});

test('an unreadable browser cache is archived and does not prevent loading cloud articles', async () => {
  clearDocsFromMemory();
  storage.setItem('block-notes-docs-user:owner', '{bad json');
  await signIn();
  assert.deepEqual(store.getState().docs, server.workspaces.get('owner')!.docs);
  assert.equal(storage.getItem('block-notes-docs-recovery:owner'), '{bad json');
});

test('retrying a failed cloud read refreshes a clean cache and remounts the editor', async () => {
  const previousGeneration = store.getState().editorGeneration;
  clearDocsFromMemory();
  server.failGet = true;
  await signIn();
  assert.equal(store.getState().syncStatus, 'error');
  const cloud = structuredClone(server.workspaces.get('owner')!);
  cloud.revision++;
  cloud.docs[0].blocks = [{ id: 'remote', type: 'paragraph', text: 'Another device body' }];
  server.workspaces.set('owner', cloud);
  server.failGet = false;
  assert.equal(await retryDocsSync(), true);
  assert.equal(store.getState().docs[0].blocks[0].text, 'Another device body');
  assert.equal(store.getState().editorGeneration, previousGeneration + 1);
});

test('an old request that receives 401 after account switching cannot retry with the new account token', async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const previousFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input) !== '/protected-old-request') return previousFetch(input, init);
    attempts++;
    await new Promise<void>((resolve) => {
      release = resolve;
      entered();
    });
    return new Response(JSON.stringify({ error: { code: 'INVALID_ACCESS_TOKEN' } }), {
      status: 401,
    });
  };
  try {
    const result = authenticatedRequest('/protected-old-request').catch((error: unknown) => error);
    await started;
    await login({ email: 'other', password: 'unused' });
    release();
    const error = await result;
    assert.ok(error instanceof AuthApiError);
    assert.equal(error.code, 'SESSION_INVALIDATED');
    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
