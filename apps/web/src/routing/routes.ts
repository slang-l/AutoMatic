export type WorkspaceView = 'editor' | 'home' | 'start' | 'templates' | 'history' | 'trash' | 'pro';
export type EditorPanel = 'assets' | 'components';
export const paths = {
  login: '/login',
  register: '/register',
  home: '/workspace',
  start: '/workspace/start',
  editor: '/articles',
  templates: '/templates',
  history: '/publishing/history',
  trash: '/trash',
  pro: '/workspace/plan',
} as const;
export const workspaceRoutes: { path: string; view: WorkspaceView; panel?: EditorPanel }[] = [
  ...(['home', 'start', 'templates', 'history', 'trash', 'pro'] as const).map((view) => ({
    path: paths[view],
    view,
  })),
  { path: '/articles/:articleId', view: 'editor' },
  { path: '/articles/:articleId/assets', view: 'editor', panel: 'assets' },
  { path: '/articles/:articleId/components', view: 'editor', panel: 'components' },
];
export const viewLabels: Record<WorkspaceView, string> = {
  editor: '文章创作',
  home: '首页',
  start: '快速开始',
  templates: '模板中心',
  history: '发布记录',
  trash: '回收站',
  pro: '版本与空间',
};
export function articlePath(id: string, panel?: EditorPanel): string {
  return paths.editor + '/' + encodeURIComponent(id) + (panel ? '/' + panel : '');
}
/** Login may return only to known application routes, never an external URL. */
export function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f]/.test(value))
    return paths.home;
  const pathname = value.split(/[?#]/)[0];
  if (
    Object.entries(paths).some(
      ([key, path]) => key !== 'login' && key !== 'register' && path === pathname,
    ) ||
    /^\/articles\/[^/]+(?:\/(?:assets|components))?$/.test(pathname)
  )
    return value;
  return paths.home;
}
export function loginPath(returnTo: string): string {
  return paths.login + '?returnTo=' + encodeURIComponent(safeReturnTo(returnTo));
}
