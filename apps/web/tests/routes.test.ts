import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemoryRouter, matchRoutes } from 'react-router-dom';
import {
  articlePath,
  loginPath,
  paths,
  safeReturnTo,
  workspaceRoutes,
} from '../src/routing/routes';

test('workspace entry points have distinct routes and invalid pages do not match', () => {
  const urls = Object.values(paths);
  assert.equal(new Set(urls).size, urls.length);
  for (const route of workspaceRoutes)
    assert.ok(matchRoutes(workspaceRoutes, route.path.replace(':articleId', 'article-a')));
  for (const url of ['/unknown', '/articles/a/unknown', '/templates/unknown'])
    assert.equal(matchRoutes(workspaceRoutes, url), null);
});

test('article links preserve IDs, including encoded path characters', () => {
  for (const id of ['article-a', '子页面', 'a/b?#%']) {
    for (const panel of [undefined, 'assets', 'components'] as const) {
      const matches = matchRoutes(workspaceRoutes, articlePath(id, panel));
      assert.equal(matches?.[0].params.articleId, id);
      assert.equal(matches?.[0].route.panel, panel);
    }
  }
});

test('login return destinations preserve article panels and reject external or auth URLs', () => {
  const destination = articlePath('article-a', 'assets') + '?panel=settings#title';
  assert.equal(safeReturnTo(destination), destination);
  assert.equal(
    new URL(loginPath(destination), 'https://app.example').searchParams.get('returnTo'),
    destination,
  );
  for (const value of [
    null,
    '',
    '//evil.example',
    'https://evil.example',
    '/\\evil.example',
    '/login',
    '/register?returnTo=/login',
    '/unknown',
    '/workspace' + String.fromCharCode(10),
  ]) {
    assert.equal(safeReturnTo(value), paths.home);
  }
});

test('browser history restores the article and panel selected by the URL', async () => {
  const router = createMemoryRouter(
    workspaceRoutes.map((route) => ({ ...route, element: null })),
    {
      initialEntries: [articlePath('article-a')],
    },
  );
  try {
    await router.navigate(articlePath('article-b'));
    assert.equal(router.state.matches[0].params.articleId, 'article-b');
    await router.navigate(articlePath('article-b', 'assets'));
    assert.equal(router.state.matches[0].route.path, '/articles/:articleId/assets');
    await router.navigate(-1);
    assert.equal(router.state.location.pathname, articlePath('article-b'));
    await router.navigate(-1);
    assert.equal(router.state.matches[0].params.articleId, 'article-a');
    await router.navigate(1);
    assert.equal(router.state.matches[0].params.articleId, 'article-b');
  } finally {
    router.dispose();
  }
});
