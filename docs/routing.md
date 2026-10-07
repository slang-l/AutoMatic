# 前端路由

前端使用 React Router 的 BrowserRouter。路由表、地址生成和登录回跳校验集中在 apps/web/src/routing/routes.ts，页面组合与登录守卫在 AppRoutes.tsx。App.tsx 负责会话恢复与退出，AppLayout.tsx 保留工作区布局。

| 页面             | 地址                            |
| ---------------- | ------------------------------- |
| 登录 / 注册      | /login、/register               |
| 首页             | /workspace                      |
| 快速开始         | /workspace/start                |
| 文章创作         | /articles/:articleId            |
| 当前文章的素材库 | /articles/:articleId/assets     |
| 当前文章的组件库 | /articles/:articleId/components |
| 模板中心         | /templates                      |
| 发布记录         | /publishing/history             |
| 回收站           | /trash                          |
| 版本与空间       | /workspace/plan                 |

根地址 / 跳转到工作区首页。/articles 跳转到最近选中的有效文章。设置沿用弹窗交互，使用当前页面的 ?panel=settings 表示打开状态，关闭时保留其他查询参数。

文章 URL 的 articleId 是编辑内容的唯一依据。currentDocId 只记忆最近选中的文章；直接访问文章地址和前进后退时，由路由同步到 store。新建、创建子页面、应用模板时，入口必须把生成的 ID 传给导航回调；文章地址统一通过 articlePath 生成并编码 ID。

未登录访问工作区会跳到 /login?returnTo=...；登录和注册切换保留回跳地址。会话及文章加载完成后才渲染业务路由，避免加载期间误判文章不存在。回跳只接受已知应用路径。不明路径显示页面不存在；缺失、无权限或已删除的文章显示文章提示。删除当前打开的文章时，跳转至 store 选择的下一篇文章。

新增页面时先在 routes.ts 增加路径和路由配置，保持导航使用 paths。编辑器与预览在工作区页面切换时保持挂载，保留编辑和预览状态；切换文章时按文章 ID 切换编辑器。

生产静态服务器必须把前端深层地址回退到 index.html，否则直接访问和刷新文章会返回服务器 404。docs/deployment.md 已配置 Nginx 的 try_files $uri $uri/ /index.html；/api 请求和静态资源继续使用各自的处理规则。

运行 pnpm --filter @automatic/web test 检查路由匹配、文章 ID 编码、登录回跳和历史导航，并运行 pnpm --filter @automatic/web build 检查类型与生产构建。
