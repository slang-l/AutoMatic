import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';

import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { WechatService } from '../services/wechat.service.js';
import { createVerifyRequestOrigin } from './auth.js';

const imageFields = {
  data: z.string().min(4),
  filename: z.string().trim().min(1).max(120),
};

const coverImageSchema = z
  .object({
    ...imageFields,
    data: imageFields.data.max(14_000_000),
    mimeType: z.enum(['image/jpeg', 'image/png', 'image/gif']),
  })
  .strict();

const contentImageSchema = z
  .object({
    ...imageFields,
    data: imageFields.data.max(1_400_000),
    mimeType: z.enum(['image/jpeg', 'image/png']),
    placeholder: z.string().regex(/^automatic-image:\/\/\d+$/),
  })
  .strict();

const saveConfigSchema = z
  .object({
    appId: z
      .string()
      .trim()
      .regex(/^wx[A-Za-z0-9]{16}$/),
    appSecret: z.string().trim().min(16).max(128).optional(),
    defaultAuthor: z.string().trim().max(32),
    defaultDigest: z.string().trim().max(120),
  })
  .strict();

const publishArticleSchema = z
  .object({
    title: z.string().trim().min(1).max(64),
    author: z.string().trim().max(32),
    digest: z.string().trim().max(120),
    content: z.string().trim().min(1).max(1_000_000),
    sourceUrl: z.string().trim().url().max(1_024).optional(),
    coverImage: coverImageSchema,
    contentImages: z.array(contentImageSchema).max(20),
    showCoverPic: z.boolean(),
    needOpenComment: z.boolean(),
    onlyFansCanComment: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const encodedImageBytes =
      value.coverImage.data.length +
      value.contentImages.reduce((total, image) => total + image.data.length, 0);
    if (encodedImageBytes > 14_000_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Encoded images exceed the request limit',
        path: ['contentImages'],
      });
    }

    const placeholders = new Set(value.contentImages.map((image) => image.placeholder));
    if (placeholders.size !== value.contentImages.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Content image placeholders must be unique',
        path: ['contentImages'],
      });
    }
  });

const publishIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export interface CreateWechatRouterOptions {
  config: AppConfig;
  requireAuth: RequestHandler;
  wechatService: WechatService;
}

export function createWechatRouter({
  config,
  requireAuth,
  wechatService,
}: CreateWechatRouterOptions): Router {
  const router = Router();

  router.use((_request, response, next) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('pragma', 'no-cache');
    next();
  });
  router.use(createVerifyRequestOrigin(config));
  router.use(requireAuth);

  router.get('/config', async (request, response) => {
    const result = await wechatService.getConfig(getAuthenticatedUserId(request));
    response.json(result);
  });

  router.put('/config', async (request, response) => {
    const input = parseRequestBody(saveConfigSchema, request.body);
    const result = await wechatService.saveConfig(getAuthenticatedUserId(request), input);
    response.json(result);
  });

  router.delete('/config', async (request, response) => {
    await wechatService.deleteConfig(getAuthenticatedUserId(request));
    response.status(204).end();
  });

  router.post('/publish', async (request, response) => {
    const input = parseRequestBody(publishArticleSchema, request.body);
    const result = await wechatService.publishArticle(getAuthenticatedUserId(request), input);
    response.status(202).json(result);
  });

  router.get('/publish/:publishId', async (request, response) => {
    const parsedPublishId = publishIdSchema.safeParse(request.params.publishId);
    if (!parsedPublishId.success) {
      throw new AppError(400, 'INVALID_REQUEST', 'Invalid publish ID');
    }

    const result = await wechatService.getPublishStatus(
      getAuthenticatedUserId(request),
      parsedPublishId.data,
    );
    response.json(result);
  });

  return router;
}

function getAuthenticatedUserId(request: Request): string {
  if (!request.auth) {
    throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication required');
  }
  return request.auth.user.id;
}

function parseRequestBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError(400, 'INVALID_REQUEST', 'Invalid request body');
  }
  return result.data;
}
