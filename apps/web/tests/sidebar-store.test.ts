import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { ArticleServer, installBrowserStorage } from './helpers/article-server';

const { entries, storage } = installBrowserStorage();
let server = new ArticleServer();
globalThis.fetch = (input, init) => server.fetch(input, init);
const { login } = await import('../src/services/auth-api');
const {
  useDocsStore: store,
  loadDocsForUser: loadWorkspace,
  clearDocsFromMemory,
} = await import('../src/store/docsStore');
async function loadDocsForUser(owner: string) {
  await login({ email: owner, password: 'unused' });
  await loadWorkspace(owner);
}
const { buildPageTree, filterPageTree } = await import('../src/components/sidebar/page-tree-data');

beforeEach(async () => {
  clearDocsFromMemory();
  entries.clear();
  server = new ArticleServer();
  await loadDocsForUser('test-owner');
  store.setState({ docs: [], currentDocId: '', publishRecords: [] });
});
afterEach(() => clearDocsFromMemory());

test('deleting a branch preserves contents and restoring it restores the hierarchy', () => {
  const root = store.getState().createDoc();
  const child = store.getState().createDoc(root);
  store
    .getState()
    .updateDocBlocks(child, [{ id: 'content', type: 'paragraph', text: 'Keep this content' }]);
  store.getState().deleteDoc(root);
  assert.equal(store.getState().docs.filter((doc) => doc.deletedAt).length, 2);
  assert.ok(
    store.getState().docs.find((doc) => doc.id === store.getState().currentDocId && !doc.deletedAt),
  );
  store.getState().restoreDoc(root);
  const restored = store.getState().docs.find((doc) => doc.id === child)!;
  assert.equal(restored.parentId, root);
  assert.equal(restored.deletedAt, undefined);
  assert.equal(restored.blocks[0].text, 'Keep this content');
});

test('restoring a child whose parent remains deleted moves it to the root', () => {
  const root = store.getState().createDoc();
  const child = store.getState().createDoc(root);
  store.getState().deleteDoc(root);
  store.getState().restoreDoc(child);
  assert.equal(store.getState().docs.find((doc) => doc.id === child)?.parentId, null);
  store.getState().permanentlyDeleteDoc(root);
  assert.ok(store.getState().docs.find((doc) => doc.id === child));
});

test('moving pages rejects cycles and deleted or missing destinations', () => {
  const root = store.getState().createDoc();
  const child = store.getState().createDoc(root);
  for (const invalid of [root, child, 'missing']) store.getState().moveDoc(root, invalid);
  assert.ok(!store.getState().docs.find((doc) => doc.id === root)?.parentId);
  store.getState().deleteDoc(child);
  store.getState().moveDoc(root, child);
  assert.ok(!store.getState().docs.find((doc) => doc.id === root)?.parentId);
});

test('permanent deletion removes only trashed branches and cannot delete active pages', () => {
  const root = store.getState().createDoc();
  const child = store.getState().createDoc(root);
  store.getState().permanentlyDeleteDoc(root);
  assert.equal(store.getState().docs.length, 2);
  store.getState().deleteDoc(root);
  store.getState().permanentlyDeleteDoc(root);
  assert.ok(!store.getState().docs.some((doc) => doc.id === root || doc.id === child));
});

test('search retains ancestors of matching nested pages', () => {
  const root = store.getState().createDoc();
  const child = store.getState().createDoc(root);
  store.getState().renameDoc(child, 'Redis tutorial');
  const result = filterPageTree(buildPageTree(store.getState().docs), ' redis ');
  assert.equal(result[0].id, root);
  assert.equal(result[0].children[0].id, child);
  assert.deepEqual(filterPageTree(result, 'not found'), []);
});

test('trash and publication history survive reload and remain isolated between accounts', async () => {
  const id = store.getState().createDoc();
  store.getState().deleteDoc(id);
  const record = {
    publishId: 'publish-1',
    docId: id,
    title: 'Article',
    submittedAt: new Date().toISOString(),
    state: 'publishing' as const,
  };
  store.getState().savePublishRecord(record);
  store.getState().savePublishRecord({ ...record, state: 'published' });
  assert.equal(store.getState().publishRecords.length, 1);
  clearDocsFromMemory();
  await loadDocsForUser('another-owner');
  assert.equal(store.getState().publishRecords.length, 0);
  assert.ok(!store.getState().docs.some((doc) => doc.id === id));
  clearDocsFromMemory();
  await loadDocsForUser('test-owner');
  assert.ok(store.getState().docs.find((doc) => doc.id === id)?.deletedAt);
  assert.equal(store.getState().publishRecords[0].state, 'published');
});

test('legacy workspaces without publication records do not inherit another account history', async () => {
  store.getState().savePublishRecord({
    publishId: 'old',
    docId: 'doc',
    title: 'Other account',
    submittedAt: new Date().toISOString(),
    state: 'publishing',
  });
  storage.setItem(
    'block-notes-docs-user:legacy-owner',
    JSON.stringify({ version: 1, state: { docs: store.getState().docs, currentDocId: '' } }),
  );
  await loadDocsForUser('legacy-owner');
  assert.deepEqual(store.getState().publishRecords, []);
});

test('late publication responses cannot write into a newly signed-in account', async () => {
  await loadDocsForUser('next-owner');
  store.getState().savePublishRecord(
    {
      publishId: 'late',
      docId: 'doc',
      title: 'Previous account',
      submittedAt: new Date().toISOString(),
      state: 'published',
    },
    'test-owner',
  );
  assert.deepEqual(store.getState().publishRecords, []);
});
