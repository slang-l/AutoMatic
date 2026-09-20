import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import request from 'supertest';

import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createMemoryAuthRepository } from '../src/repositories/memory.repository.js';
import { createMemoryCollaborationRepository } from '../src/repositories/memory-collaboration.repository.js';
import { createPostgresCollaborationRepository } from '../src/repositories/postgres-collaboration.repository.js';
import { createTokenService } from '../src/services/token.service.js';

test(
  'PostgreSQL collaboration persists concurrent updates and isolates presence',
  {
    skip: !process.env.COLLABORATION_TEST_DATABASE_URL,
  },
  async () => {
    const schema = `collaboration_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({
      connectionString: process.env.COLLABORATION_TEST_DATABASE_URL,
      connectionTimeoutMillis: 3000,
    });
    const pool = new pg.Pool({
      connectionString: process.env.COLLABORATION_TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
      connectionTimeoutMillis: 3000,
    });
    let created = false;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      created = true;
      for (const name of ['001_auth.sql', '004_collaboration.sql']) {
        await pool.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
      }
      const [ownerId, editorId] = [randomUUID(), randomUUID()];
      for (const id of [ownerId, editorId]) {
        await pool.query(
          'INSERT INTO users (id, email, password_hash, name) VALUES ($1, $2, $3, $4)',
          [id, `${id}@example.com`, 'unused', 'Tester'],
        );
      }
      const repository = createPostgresCollaborationRepository(pool);
      const documentId = randomUUID();
      await repository.createDocument({ id: documentId, ownerId, title: 'Concurrent document' });
      await repository.addMember(documentId, editorId, 'editor');
      const input = {
        documentId,
        actorId: editorId,
        operationId: randomUUID(),
        updateData: Buffer.from([1]),
      };
      const retries = await Promise.all(
        Array.from({ length: 10 }, () => repository.appendUpdate(input)),
      );
      assert.equal(new Set(retries.map((row) => row.sequence)).size, 1);
      await assert.rejects(repository.appendUpdate({ ...input, updateData: Buffer.from([2]) }), {
        code: 'COLLABORATION_OPERATION_CONFLICT',
      });
      await Promise.all(
        Array.from({ length: 20 }, () =>
          repository.appendUpdate({ ...input, operationId: randomUUID() }),
        ),
      );
      const updates = await repository.listUpdates(documentId, '0', 100);
      assert.equal(updates.length, 21);
      assert.ok(
        updates.every(
          (row, i) => i === 0 || BigInt(row.sequence) > BigInt(updates[i - 1].sequence),
        ),
      );
      const sessionId = randomUUID();
      await repository.upsertPresence({
        documentId,
        sessionId,
        userId: editorId,
        state: { cursor: 1 },
      });
      await assert.rejects(
        repository.upsertPresence({ documentId, sessionId, userId: ownerId, state: {} }),
        { code: 'COLLABORATION_SESSION_CONFLICT' },
      );
      assert.equal((await repository.listPresence(documentId, new Date(0))).length, 1);
      await repository.updateMemberRole(documentId, editorId, 'viewer');
      await assert.rejects(repository.appendUpdate({ ...input, operationId: randomUUID() }), {
        code: 'COLLABORATION_FORBIDDEN',
      });
      await repository.removeMember(documentId, editorId);
      assert.deepEqual(await repository.listPresence(documentId, new Date(0)), []);
      await repository.deleteDocument(documentId);
      assert.deepEqual(await repository.listUpdates(documentId, '0', 100), []);
    } finally {
      await pool.end();
      if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

async function setup() {
  const config = loadConfig({
    NODE_ENV: 'test',
    JWT_ACCESS_SECRET: 'collaboration-test-secret-at-least-32-characters',
    DATABASE_URL: 'postgresql://unused:unused@localhost/unused',
    JWT_ISSUER: 'automatic-test',
    JWT_AUDIENCE: 'automatic-test',
  });
  const auth = createMemoryAuthRepository();
  const repository = createMemoryCollaborationRepository(auth);
  const users = await Promise.all(
    ['owner', 'editor', 'viewer', 'outsider'].map((name) =>
      auth.upsertSystemUser({ email: `${name}@example.com`, name, passwordHash: 'unused' }),
    ),
  );
  const tokens = users.map((user) => createTokenService(config).signAccessToken(user));
  const app = buildApp({ config, authRepository: auth, collaborationRepository: repository });
  const api = (index: number) => ({
    get: (url: string) => request(app).get(url).auth(tokens[index], { type: 'bearer' }),
    post: (url: string, body: unknown) =>
      request(app)
        .post(url)
        .auth(tokens[index], { type: 'bearer' })
        .send(body as object),
    put: (url: string, body: unknown) =>
      request(app)
        .put(url)
        .auth(tokens[index], { type: 'bearer' })
        .send(body as object),
    patch: (url: string, body: unknown) =>
      request(app)
        .patch(url)
        .auth(tokens[index], { type: 'bearer' })
        .send(body as object),
    delete: (url: string) => request(app).delete(url).auth(tokens[index], { type: 'bearer' }),
  });
  const created = await api(0)
    .post('/api/collaboration/documents', { title: 'Shared draft' })
    .expect(201);
  const path = `/api/collaboration/documents/${created.body.id}`;
  await api(0).post(`${path}/members`, { email: users[1].email, role: 'editor' }).expect(201);
  await api(0).post(`${path}/members`, { email: users[2].email, role: 'viewer' }).expect(201);
  return { app, api, users, repository, path, id: created.body.id as string };
}

test('collaboration permissions protect documents, members and owner', async () => {
  const { app, api, path, users } = await setup();
  await request(app).get(path).expect(401);
  await api(3).get(path).expect(404);
  assert.deepEqual((await api(3).get('/api/collaboration/documents')).body, []);
  assert.equal((await api(1).get(path)).body.memberCount, 3);
  await api(1).post(`${path}/members`, { email: users[3].email, role: 'viewer' }).expect(403);
  await api(0).post(`${path}/members`, { email: users[1].email, role: 'viewer' }).expect(409);
  await api(0).patch(`${path}/members/${users[0].id}`, { role: 'viewer' }).expect(403);
  await api(0).delete(`${path}/members/${users[0].id}`).expect(403);
  await api(2).post(`${path}/updates`, { operationId: randomUUID(), data: 'AQ==' }).expect(403);
  await api(0).patch(`${path}/members/${users[1].id}`, { role: 'viewer' }).expect(200);
  await api(1).post(`${path}/updates`, { operationId: randomUUID(), data: 'AQ==' }).expect(403);
  await api(0).delete(`${path}/members/${users[1].id}`).expect(204);
  await api(1).get(`${path}/updates`).expect(404);
  await api(2).delete(path).expect(403);
  await api(0).delete(path).expect(204);
  await api(0).get(path).expect(404);
});

test('updates support concurrent retries, conflict detection and lossless pagination', async () => {
  const { api, path, repository, id, users } = await setup();
  const operationId = randomUUID();
  const retries = await Promise.all(
    Array.from({ length: 8 }, () =>
      repository.appendUpdate({
        documentId: id,
        actorId: users[1].id,
        operationId,
        updateData: Buffer.from([1]),
      }),
    ),
  );
  assert.equal(new Set(retries.map((row) => row.sequence)).size, 1);
  const replay = await api(1).post(`${path}/updates`, { operationId, data: 'AQ==' }).expect(200);
  assert.equal(replay.body.sequence, retries[0].sequence);
  await api(1).post(`${path}/updates`, { operationId, data: 'Ag==' }).expect(409);
  await api(0).post(`${path}/updates`, { operationId, data: 'AQ==' }).expect(409);
  await Promise.all(
    Array.from({ length: 6 }, () =>
      api(1)
        .post(`${path}/updates`, {
          operationId: randomUUID(),
          data: 'Aw==',
        })
        .expect(200),
    ),
  );
  let cursor = '0';
  const sequences: string[] = [];
  for (;;) {
    const page = await api(2).get(`${path}/updates?after=${cursor}&limit=2`).expect(200);
    for (const update of page.body.updates) {
      assert.equal(typeof update.data, 'string');
      assert.equal(update.updateData, undefined);
      assert.ok(BigInt(update.sequence) > BigInt(cursor));
      sequences.push(update.sequence);
    }
    cursor = page.body.nextCursor;
    if (!page.body.hasMore) break;
  }
  assert.equal(sequences.length, 7);
  assert.equal(new Set(sequences).size, 7);
  const empty = await api(1).get(`${path}/updates?after=${cursor}`).expect(200);
  assert.deepEqual(empty.body, { updates: [], nextCursor: cursor, hasMore: false });
});

test('presence isolates sessions, expires old entries and removes revoked members', async () => {
  const { api, path, users, repository, id } = await setup();
  const sessionId = randomUUID();
  await api(1)
    .put(`${path}/presence/${sessionId}`, { state: { cursor: 42 } })
    .expect(200);
  await api(2).put(`${path}/presence/${sessionId}`, { state: {} }).expect(409);
  await api(2).delete(`${path}/presence/${sessionId}`).expect(204);
  assert.equal((await api(0).get(`${path}/presence`)).body.length, 1);
  assert.deepEqual(await repository.listPresence(id, new Date(Date.now() + 60_000)), []);
  await api(0).delete(`${path}/members/${users[1].id}`).expect(204);
  assert.deepEqual((await api(0).get(`${path}/presence`)).body, []);
  await api(1).put(`${path}/presence/${sessionId}`, { state: {} }).expect(404);
  await api(2).put(`${path}/presence/${randomUUID()}`, { state: {} }).expect(200);
  await api(0).delete(path).expect(204);
  assert.deepEqual(await repository.listPresence(id, new Date(0)), []);
});

test('collaboration validates cursors, binary payloads, metadata and origins', async () => {
  const { api, path } = await setup();
  for (const query of [
    'after=-1',
    'after=9223372036854775808',
    'after=1e2',
    'limit=0',
    'limit=101',
    'after=1&after=2',
  ]) {
    await api(0).get(`${path}/updates?${query}`).expect(400);
  }
  for (const data of ['', 'AA', 'A===', 'AB==', Buffer.alloc(1_048_577).toString('base64')]) {
    await api(0).post(`${path}/updates`, { operationId: randomUUID(), data }).expect(400);
  }
  await api(0).post('/api/collaboration/documents', { title: ' ' }).expect(400);
  await api(0)
    .put(`${path}/presence/${randomUUID()}`, { state: { text: '中'.repeat(3000) } })
    .expect(400);
  await api(0).put(`${path}/presence/${randomUUID()}`, { state: [] }).expect(400);
  await api(0)
    .post(`${path}/updates`, { operationId: randomUUID(), data: 'AQ==' })
    .set('origin', 'https://untrusted.example')
    .expect(403);
  const initialUpdate = { operationId: randomUUID(), data: 'AQID' };
  const created = await api(0)
    .post('/api/collaboration/documents', { title: '  Initial  ', initialUpdate })
    .expect(201);
  assert.equal(created.body.title, 'Initial');
  const history = await api(0)
    .get(`/api/collaboration/documents/${created.body.id}/updates`)
    .expect(200);
  assert.equal(history.body.updates[0].data, initialUpdate.data);
  assert.equal(history.body.updates[0].sequence, created.body.latestSequence);
});
