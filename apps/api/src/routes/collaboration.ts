import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';

import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { CollaborationService } from '../services/collaboration.service.js';
import { createVerifyRequestOrigin } from './auth.js';

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const updateSchema = z
  .object({
    operationId: uuid,
    data: z
      .string()
      .min(4)
      .max(1_398_104)
      .refine((value) => {
        const bytes = Buffer.from(value, 'base64');
        return bytes.length > 0 && bytes.length <= 1_048_576 && bytes.toString('base64') === value;
      }),
  })
  .strict();
const documentSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    initialUpdate: updateSchema.optional(),
  })
  .strict();
const roleSchema = z.object({ role: z.enum(['editor', 'viewer']) }).strict();
const memberSchema = roleSchema.extend({
  email: z
    .string()
    .trim()
    .max(254)
    .email()
    .transform((value) => value.toLowerCase()),
});
const cursorSchema = z
  .object({
    after: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,18})$/)
      .refine(
        (value) =>
          /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n,
      )
      .default('0'),
    limit: z
      .string()
      .regex(/^[1-9][0-9]{0,2}$/)
      .transform(Number)
      .refine((value) => value <= 100)
      .default(100),
  })
  .strict();
const presenceSchema = z
  .object({
    // Leave room for PostgreSQL jsonb's whitespace expansion within its 8 KiB limit.
    state: z.record(z.string(), z.unknown()).refine((value) => {
      const json = JSON.stringify(value);
      return (
        Buffer.byteLength(json, 'utf8') + (json.match(/[,:]/g)?.length ?? 0) <= 8192 &&
        !/\\u0000/i.test(json)
      );
    }),
  })
  .strict();

export function createCollaborationRouter({
  config,
  requireAuth,
  service,
}: {
  config: AppConfig;
  requireAuth: RequestHandler;
  service: CollaborationService;
}) {
  const router = Router();
  router.use((_request, response, next) => {
    response.setHeader('cache-control', 'no-store');
    next();
  });
  router.use(createVerifyRequestOrigin(config), requireAuth);
  const user = (request: Request) => request.auth!.user.id;
  const doc = (request: Request) => parse(uuid, request.params.documentId);

  router.get('/documents', async (req, res) => {
    res.json(await service.list(user(req)));
  });
  router.post('/documents', async (req, res) => {
    res.status(201).json(await service.create(user(req), parse(documentSchema, req.body)));
  });
  router.get('/documents/:documentId', async (req, res) => {
    res.json(await service.get(user(req), doc(req)));
  });
  router.delete('/documents/:documentId', async (req, res) => {
    await service.delete(user(req), doc(req));
    res.status(204).end();
  });
  router.get('/documents/:documentId/members', async (req, res) => {
    res.json(await service.members(user(req), doc(req)));
  });
  router.post('/documents/:documentId/members', async (req, res) => {
    const input = parse(memberSchema, req.body);
    res.status(201).json(await service.addMember(user(req), doc(req), input.email, input.role));
  });
  router.patch('/documents/:documentId/members/:userId', async (req, res) => {
    res.json(
      await service.updateMember(
        user(req),
        doc(req),
        parse(uuid, req.params.userId),
        parse(roleSchema, req.body).role,
      ),
    );
  });
  router.delete('/documents/:documentId/members/:userId', async (req, res) => {
    await service.removeMember(user(req), doc(req), parse(uuid, req.params.userId));
    res.status(204).end();
  });
  router.get('/documents/:documentId/updates', async (req, res) => {
    const input = parse(cursorSchema, req.query);
    res.json(await service.updates(user(req), doc(req), input.after, input.limit));
  });
  router.post('/documents/:documentId/updates', async (req, res) => {
    res.json(await service.append(user(req), doc(req), parse(updateSchema, req.body)));
  });
  router.get('/documents/:documentId/presence', async (req, res) => {
    res.json(await service.presence(user(req), doc(req)));
  });
  router.put('/documents/:documentId/presence/:sessionId', async (req, res) => {
    res.json(
      await service.heartbeat(
        user(req),
        doc(req),
        parse(uuid, req.params.sessionId),
        parse(presenceSchema, req.body).state,
      ),
    );
  });
  router.delete('/documents/:documentId/presence/:sessionId', async (req, res) => {
    await service.leave(user(req), doc(req), parse(uuid, req.params.sessionId));
    res.status(204).end();
  });
  return router;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(400, 'INVALID_REQUEST', 'Invalid collaboration request');
  return result.data;
}
