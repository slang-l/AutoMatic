import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import request from 'supertest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { runMigrations } from '../src/database/migration-runner.js';
import { createMemoryAuthRepository } from '../src/repositories/memory.repository.js';
import { createMemoryArticleRepository } from '../src/repositories/memory-article.repository.js';
import { createPostgresArticleRepository } from '../src/repositories/postgres-article.repository.js';
import { createTokenService } from '../src/services/token.service.js';
import type { Article, SaveArticleWorkspace } from '../src/type/article.js';

const createdAt = '2026-08-01T12:00:00.000Z';
function article(id = 'legacy-slug', parentId: string | null = null): Article {
  return {
    id,
    parentId,
    title: '数据库里的文章',
    author: 'Author',
    location: 'Shanghai',
    createdAt,
    updatedAt: createdAt,
    status: 'review',
    blocks: [
      {
        id: 'text',
        type: 'paragraph',
        text: 'Bold link',
        delta: [
          { insert: 'Bold', attributes: { bold: true, italic: null } },
          { insert: ' link', attributes: { link: 'https://example.com', color: '#123456' } },
        ],
      },
      { id: 'image', type: 'image', url: 'data:image/png;base64,aGVsbG8=', caption: 'Caption' },
      {
        id: 'todo',
        type: 'todo-list',
        items: ['One', 'Two'],
        itemDeltas: [[{ insert: 'One' }], [{ insert: 'Two' }]],
        checked: [true, false],
      },
      { id: 'code', type: 'code', text: 'SELECT 1;', language: 'sql' },
    ],
  };
}

function input(revision = 0): SaveArticleWorkspace {
  return {
    revision,
    writeId: randomUUID(),
    docs: [article('child', 'legacy-slug'), article()],
    currentDocId: 'child',
    publishRecords: [
      {
        publishId: 'publish-1',
        docId: 'child',
        title: 'Published',
        submittedAt: createdAt,
        state: 'published',
        articleUrl: null,
      },
    ],
  };
}

async function setup() {
  const config = loadConfig({
    NODE_ENV: 'test',
    JWT_ACCESS_SECRET: 'article-tests-secret-at-least-32-characters',
    DATABASE_URL: 'postgresql://unused:unused@localhost/unused',
    JWT_ISSUER: 'automatic-test',
    JWT_AUDIENCE: 'automatic-test',
  });
  const auth = createMemoryAuthRepository();
  const users = await Promise.all(
    ['owner', 'other'].map((name) =>
      auth.upsertSystemUser({ email: `${name}@example.com`, name, passwordHash: 'unused' }),
    ),
  );
  const tokens = users.map((user) => createTokenService(config).signAccessToken(user));
  const app = buildApp({
    config,
    authRepository: auth,
    articleRepository: createMemoryArticleRepository(),
  });
  return {
    app,
    get: (i = 0) => request(app).get('/api/articles/workspace').auth(tokens[i], { type: 'bearer' }),
    put: (body: object, i = 0) =>
      request(app).put('/api/articles/workspace').auth(tokens[i], { type: 'bearer' }).send(body),
  };
}

test('article API round-trips documents and distinguishes trash from permanent deletion', async () => {
  const api = await setup();
  const original = input();
  await api.put(original).expect(200, { revision: 1 });
  const { writeId: _writeId, ...expected } = original;
  const loaded = await api.get().expect(200);
  assert.equal(loaded.headers['cache-control'], 'no-store');
  assert.deepEqual(loaded.body, { ...expected, revision: 1 });
  const trashed = input(1);
  trashed.docs = original.docs.map((doc) => ({ ...doc, deletedAt: createdAt }));
  trashed.currentDocId = '';
  await api.put(trashed).expect(200);
  assert.deepEqual((await api.get()).body.docs, trashed.docs);
  const restored = { ...input(2), docs: original.docs };
  await api.put(restored).expect(200);
  assert.equal((await api.get()).body.docs[0].deletedAt, undefined);
  await api.put({ ...input(3), docs: [], currentDocId: '' }).expect(200, { revision: 4 });
  assert.deepEqual((await api.get()).body.docs, []);
  assert.equal((await api.get()).body.publishRecords.length, 1);
});

test('articles require authentication, scope duplicate legacy IDs to each owner and reject untrusted writes', async () => {
  const api = await setup();
  await request(api.app).get('/api/articles/workspace').expect(401);
  await request(api.app).put('/api/articles/workspace').send(input()).expect(401);
  await api.put(input()).set('Origin', 'https://attacker.example').expect(403);
  await api.put(input()).expect(200);
  assert.deepEqual((await api.get(1)).body.docs, []);
  const other = input();
  other.docs[0].title = 'Other user';
  await api.put(other, 1).expect(200);
  assert.equal((await api.get()).body.docs[0].title, '数据库里的文章');
  assert.equal((await api.get(1)).body.docs[0].title, 'Other user');
  await api.put({ ...input(1), userId: 'other' }).expect(400);
});

test('concurrent and retried saves cannot overwrite newer articles or resurrect deletions', async () => {
  const api = await setup();
  const original = input();
  await api.put(original).expect(200, { revision: 1 });
  await api.put(original).expect(200, { revision: 1 });
  const changed = structuredClone(original);
  changed.docs[0].title = 'Changed retry';
  await api.put(changed).expect(409);
  const next = input(1);
  const competitor = input(1);
  const responses = await Promise.all([api.put(next), api.put(competitor)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  await api.put({ ...input(2), docs: [], currentDocId: '' }).expect(200);
  const stale = await api.put(input(1)).expect(409);
  assert.equal(stale.body.error.code, 'ARTICLE_REVISION_CONFLICT');
  assert.deepEqual((await api.get()).body.docs, []);
});

test('invalid block shapes, temporary images, cycles, duplicate IDs and invalid selections do not mutate the workspace', async () => {
  const api = await setup();
  await api.put(input()).expect(200);
  const invalid = [
    (body: SaveArticleWorkspace) => {
      body.docs[0].parentId = 'missing';
    },
    (body: SaveArticleWorkspace) => {
      body.docs[1].parentId = 'child';
    },
    (body: SaveArticleWorkspace) => {
      body.docs[1].id = 'child';
    },
    (body: SaveArticleWorkspace) => {
      body.docs[1].deletedAt = createdAt;
    },
    (body: SaveArticleWorkspace) => {
      body.currentDocId = 'missing';
    },
    (body: SaveArticleWorkspace) => {
      body.docs[0].blocks[1].url = 'blob:temporary-image';
    },
    (body: SaveArticleWorkspace) => {
      body.publishRecords.push(body.publishRecords[0]);
    },
  ];
  for (const mutate of invalid) {
    const body = input(1);
    mutate(body);
    await api.put(body).expect(400);
    assert.equal((await api.get()).body.revision, 1);
  }
  await api
    .put({ ...input(1), docs: [{ ...article(), blocks: [{ id: 'bad', type: 'unknown' }] }] })
    .expect(400);
});

test(
  'PostgreSQL article persistence survives new connections, serializes concurrent writes and rolls back failed saves',
  {
    skip: !process.env.ARTICLE_TEST_DATABASE_URL,
  },
  async () => {
    const url = process.env.ARTICLE_TEST_DATABASE_URL;
    const schema = `articles_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 3000 });
    const pool = new pg.Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
      connectionTimeoutMillis: 3000,
    });
    const secondPool = new pg.Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
      connectionTimeoutMillis: 3000,
    });
    let created = false;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      created = true;
      assert.ok((await runMigrations(pool)).includes('005_articles.sql'));
      assert.deepEqual(await runMigrations(secondPool), []);
      const users = [randomUUID(), randomUUID()];
      for (const id of users)
        await pool.query(
          'INSERT INTO users(id, email, password_hash, name) VALUES ($1, $2, $3, $4)',
          [id, `${id}@example.com`, 'unused', 'Tester'],
        );
      const repository = createPostgresArticleRepository(pool);
      const otherConnection = createPostgresArticleRepository(secondPool);
      const original = input();
      await repository.saveWorkspace(users[0], original);
      const { writeId: _writeId, ...expected } = original;
      assert.deepEqual(await otherConnection.getWorkspace(users[0]), { ...expected, revision: 1 });
      const retries = await Promise.all(
        Array.from({ length: 8 }, () => otherConnection.saveWorkspace(users[0], original)),
      );
      assert.ok(retries.every((result) => result.revision === 1));
      await repository.saveWorkspace(users[1], input());
      const competitors = await Promise.allSettled([
        repository.saveWorkspace(users[0], input(1)),
        otherConnection.saveWorkspace(users[0], input(1)),
      ]);
      assert.equal(competitors.filter((result) => result.status === 'fulfilled').length, 1);
      const bad = input(2);
      bad.docs[0].parentId = 'missing';
      await assert.rejects(repository.saveWorkspace(users[0], bad), { code: '23503' });
      assert.equal((await otherConnection.getWorkspace(users[0])).revision, 2);
      assert.equal((await otherConnection.getWorkspace(users[0])).docs[0].parentId, 'legacy-slug');
      const trashed = {
        ...input(2),
        docs: original.docs.map((doc) => ({ ...doc, deletedAt: createdAt })),
        currentDocId: '',
      };
      await repository.saveWorkspace(users[0], trashed);
      assert.deepEqual((await otherConnection.getWorkspace(users[0])).docs, trashed.docs);
      await repository.saveWorkspace(users[0], { ...input(3), docs: [], currentDocId: '' });
      assert.deepEqual((await otherConnection.getWorkspace(users[0])).docs, []);
      assert.equal((await otherConnection.getWorkspace(users[1])).docs.length, 2);
      await pool.query('DELETE FROM users WHERE id = $1', [users[1]]);
      assert.equal(
        (await pool.query('SELECT count(*) FROM articles WHERE user_id = $1', [users[1]])).rows[0]
          .count,
        '0',
      );
    } finally {
      await Promise.all([pool.end(), secondPool.end()]);
      if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
