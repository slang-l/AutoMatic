import { randomUUID } from 'node:crypto';

import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import helmet from 'helmet';

import { loadConfig, type AppConfig } from './config.js';
import type { ArticleRepository } from './repositories/article.repository.js';
import { createMemoryArticleRepository } from './repositories/memory-article.repository.js';
import { createArticleService } from './services/article.service.js';
import { createArticleRouter } from './routes/articles.js';
import { AppError, UpstreamServiceError, createErrorResponse } from './errors.js';
import { createRequireAuth } from './middlewares/auth.middleware.js';
import type { AuthRepository } from './repositories/auth.repository.js';
import type { BrandAssetRepository } from './repositories/brand-asset.repository.js';
import { createMemoryBrandAssetRepository } from './repositories/memory-brand-asset.repository.js';
import { createMemoryAuthRepository } from './repositories/memory.repository.js';
import { createMemoryWechatRepository } from './repositories/memory-wechat.repository.js';
import type { WechatRepository } from './repositories/wechat.repository.js';
import { createAuthRouter } from './routes/auth.js';
import { createBrandAssetRouter } from './routes/brand-assets.js';
import { healthRouter } from './routes/health.js';
import { createWechatRouter } from './routes/wechat.js';
import { createAuthService } from './services/auth.service.js';
import { createBrandAssetService } from './services/brand-asset.service.js';
import {
  createRegistrationVerificationService,
  type RegistrationVerificationService,
} from './services/registration-verification.service.js';
import type { RegistrationVerificationCodeSender } from './services/registration-verification-sender.service.js';
import { createTokenService } from './services/token.service.js';
import { createWechatService } from './services/wechat.service.js';
import type { CollaborationRepository } from './repositories/collaboration.repository.js';
import { createMemoryCollaborationRepository } from './repositories/memory-collaboration.repository.js';
import { createCollaborationService } from './services/collaboration.service.js';
import { createCollaborationRouter } from './routes/collaboration.js';

export interface BuildAppOptions {
  articleRepository?: ArticleRepository;
  config?: AppConfig;
  logger?: Pick<Console, 'error'> | false;
  authRepository?: AuthRepository;
  collaborationRepository?: CollaborationRepository;
  brandAssetRepository?: BrandAssetRepository;
  wechatRepository?: WechatRepository;
  wechatFetch?: typeof fetch;
  registrationVerificationService?: RegistrationVerificationService;
  registrationVerificationCodeSender?: RegistrationVerificationCodeSender;
  passwordHashRounds?: number;
}

type ErrorWithStatus = Error & {
  code?: string;
  status?: number;
  statusCode?: number;
  headers?: Record<string, number | string | string[] | undefined>;
};

function requestId(request: express.Request): string {
  return request.get('x-request-id') ?? randomUUID();
}

function createRequestIdMiddleware(): RequestHandler {
  return (request, response, next) => {
    const id = requestId(request);
    response.locals.requestId = id;
    response.setHeader('x-request-id', id);
    next();
  };
}

function forwardErrorHeaders(error: ErrorWithStatus, response: express.Response): void {
  if (!error.headers) return;

  for (const [name, value] of Object.entries(error.headers)) {
    if (value !== undefined) {
      response.setHeader(name, value);
    }
  }
}

export function registerErrorHandlers(
  app: Express,
  logger: Pick<Console, 'error'> | false = console,
): void {
  app.use((_request, response) => {
    response
      .status(404)
      .json(
        createErrorResponse(
          response.locals.requestId,
          'NOT_FOUND',
          'The requested resource was not found',
        ),
      );
  });

  const errorHandler: ErrorRequestHandler = (error: ErrorWithStatus, request, response, _next) => {
    const id = response.locals.requestId ?? requestId(request);

    if (error instanceof AppError) {
      response.status(error.statusCode).json(createErrorResponse(id, error.code, error.message));
      return;
    }

    if (error instanceof UpstreamServiceError) {
      response.status(error.statusCode).json(createErrorResponse(id, error.code, error.message));
      return;
    }

    const statusCode = error.statusCode ?? error.status;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      forwardErrorHeaders(error, response);
      response
        .status(statusCode)
        .json(createErrorResponse(id, error.code ?? 'BAD_REQUEST', error.message));
      return;
    }

    if (logger) {
      logger.error('Unhandled request error', error);
    }

    response
      .status(500)
      .json(createErrorResponse(id, 'INTERNAL_SERVER_ERROR', 'Internal server error'));
  };

  app.use(errorHandler);
}

export function buildApp(options: BuildAppOptions = {}): Express {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? (config.nodeEnv === 'test' ? false : console);
  const repository = options.authRepository ?? createMemoryAuthRepository();
  const brandAssetRepository = options.brandAssetRepository ?? createMemoryBrandAssetRepository();
  const wechatRepository = options.wechatRepository ?? createMemoryWechatRepository();
  const tokenService = createTokenService(config);
  const registrationVerificationService =
    options.registrationVerificationService ??
    createRegistrationVerificationService({
      // 开发/测试环境在页面展示测试码；生产响应永远不包含验证码。
      exposeTestCode: config.nodeEnv !== 'production',
    });
  const authService = createAuthService({
    config,
    repository,
    registrationVerificationService,
    tokenService,
    passwordHashRounds: options.passwordHashRounds,
    registrationVerificationCodeSender: options.registrationVerificationCodeSender,
  });
  const requireAuth = createRequireAuth(tokenService, repository);
  const brandAssetService = createBrandAssetService(brandAssetRepository);
  const wechatService = createWechatService({
    repository: wechatRepository,
    encryptionSecret: config.jwtAccessSecret,
    fetchImpl: options.wechatFetch,
  });
  const app = express();

  app.disable('x-powered-by');
  app.use(createRequestIdMiddleware());
  app.use(helmet());
  app.use(
    cors({
      origin: config.corsOrigins,
      credentials: true,
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: '16mb' }));
  app.use(express.urlencoded({ extended: true, limit: '16mb' }));
  app.use('/api', healthRouter);
  app.use('/api/auth', createAuthRouter({ config, authService, requireAuth }));
  app.use(
    '/api/articles',
    createArticleRouter({
      config,
      requireAuth,
      service: createArticleService(options.articleRepository ?? createMemoryArticleRepository()),
    }),
  );
  app.use(
    '/api/brand-assets',
    createBrandAssetRouter({ config, requireAuth, service: brandAssetService }),
  );
  app.use('/api/wechat', createWechatRouter({ config, requireAuth, wechatService }));
  app.use(
    '/api/collaboration',
    createCollaborationRouter({
      config,
      requireAuth,
      service: createCollaborationService(
        options.collaborationRepository ?? createMemoryCollaborationRepository(repository),
        repository,
      ),
    }),
  );
  registerErrorHandlers(app, logger);

  return app;
}
