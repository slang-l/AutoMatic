import { Router, type RequestHandler } from 'express';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { ArticleService } from '../services/article.service.js';
import { saveArticleWorkspaceSchema } from '../type/article.js';
import { createVerifyRequestOrigin } from './auth.js';

export function createArticleRouter({
  config,
  requireAuth,
  service,
}: {
  config: AppConfig;
  requireAuth: RequestHandler;
  service: ArticleService;
}): Router {
  const router = Router();
  router.use((_request, response, next) => {
    response.setHeader('cache-control', 'no-store');
    next();
  });
  router.use(createVerifyRequestOrigin(config));
  router.use(requireAuth);
  router.get('/workspace', async (request, response) => {
    response.json(await service.getWorkspace(request.auth!.user.id));
  });
  router.put('/workspace', async (request, response) => {
    const parsed = saveArticleWorkspaceSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError(400, 'INVALID_REQUEST', 'Invalid article workspace');
    response.json(await service.saveWorkspace(request.auth!.user.id, parsed.data));
  });
  return router;
}
