import type { ArticleWorkspace, ArticleWorkspaceWrite } from '../../src/services/articles-api';

export class ArticleServer {
  workspaces = new Map<string, ArticleWorkspace>();
  writes: ArticleWorkspaceWrite[] = [];
  beforeGet: (() => Promise<void>) | null = null;
  beforePut: (() => Promise<void>) | null = null;
  failGet = false;
  failPut = false;
  rejectPut: number | null = null;
  loseResponse = false;
  private lastWrites = new Map<string, ArticleWorkspaceWrite>();
  private owner = 'test-owner';

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url === '/api/auth/login' || url === '/api/auth/refresh') {
      if (url.endsWith('login')) this.owner = JSON.parse(String(init?.body)).email;
      return json({
        accessToken: `test:${this.owner}`,
        user: {
          id: this.owner,
          email: this.owner,
          name: this.owner,
          role: 'user',
          status: 'active',
        },
      });
    }
    if (url !== '/api/articles/workspace') throw new Error(`Unexpected request: ${url}`);
    const owner = new Headers(init?.headers).get('authorization')?.replace('Bearer test:', '');
    if (!owner) return json({ error: { code: 'AUTHENTICATION_REQUIRED' } }, 401);
    if (init?.method !== 'PUT') {
      await this.beforeGet?.();
      if (this.failGet) throw new TypeError('Offline');
      return json(
        this.workspaces.get(owner) ?? {
          revision: 0,
          docs: [],
          currentDocId: '',
          publishRecords: [],
        },
      );
    }
    const write = JSON.parse(String(init.body)) as ArticleWorkspaceWrite;
    this.writes.push(structuredClone(write));
    await this.beforePut?.();
    if (this.rejectPut !== null)
      return json({ error: { code: 'INVALID_REQUEST', message: 'Rejected' } }, this.rejectPut);
    if (this.failPut) throw new TypeError('Offline');
    const current = this.workspaces.get(owner);
    if (this.lastWrites.get(owner)?.writeId === write.writeId)
      return json({ revision: current!.revision });
    if ((current?.revision ?? 0) !== write.revision)
      return json({ error: { code: 'ARTICLE_REVISION_CONFLICT', message: 'Conflict' } }, 409);
    const { writeId: _writeId, ...data } = write;
    this.workspaces.set(owner, { ...data, revision: write.revision + 1 });
    this.lastWrites.set(owner, write);
    if (this.loseResponse) {
      this.loseResponse = false;
      throw new TypeError('Connection lost after commit');
    }
    return json({ revision: write.revision + 1 });
  };
}

export function installBrowserStorage() {
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage: storage },
    configurable: true,
  });
  return { entries, storage };
}
