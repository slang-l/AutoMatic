import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { runMigrations } from './database/migration-runner.js';
import { createPostgresPool } from './database/postgres.js';
import { createPostgresAuthRepository } from './repositories/postgres.repository.js';
import { createPostgresBrandAssetRepository } from './repositories/postgres-brand-asset.repository.js';
import { createPostgresWechatRepository } from './repositories/postgres-wechat.repository.js';
import { createPostgresCollaborationRepository } from './repositories/postgres-collaboration.repository.js';
import { provisionDevelopmentAdmin } from './services/development-admin.service.js';
import { createResendRegistrationVerificationCodeSender } from './services/registration-verification-sender.service.js';

if (existsSync('.env')) {
  loadEnvFile('.env');
}

const config = loadConfig();
const pool = createPostgresPool(config.databaseUrl);
const authRepository = createPostgresAuthRepository(pool);
const brandAssetRepository = createPostgresBrandAssetRepository(pool);
const wechatRepository = createPostgresWechatRepository(pool);

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error', error);
});

// Fail before opening the HTTP port when PostgreSQL is unavailable.
try {
  await pool.query('SELECT 1');
  await runMigrations(pool);
  const developmentAdmin = await provisionDevelopmentAdmin({
    config,
    repository: authRepository,
  });
  if (developmentAdmin) {
    // 不在日志里打印默认密码；凭据由本地环境模板和开发文档提供。
    console.info(`Development administrator ready: ${developmentAdmin.email}`);
  }
} catch (error) {
  await pool.end();
  throw error;
}

const registrationVerificationCodeSender = config.resendEmail
  ? createResendRegistrationVerificationCodeSender({
      apiKey: config.resendEmail.apiKey,
      from: config.resendEmail.from,
    })
  : undefined;

const app = buildApp({
  config,
  authRepository,
  brandAssetRepository,
  wechatRepository,
  collaborationRepository: createPostgresCollaborationRepository(pool),
  registrationVerificationCodeSender,
});
const server = app.listen(config.port, config.host, () => {
  console.info(`API server listening on http://${config.host}:${config.port}`);
});
let isShuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (isShuttingDown) return;

  isShuttingDown = true;
  console.info(`Received ${signal}, shutting down API server`);

  await new Promise<void>((resolve) => {
    server.close((error) => {
      if (error) {
        console.error('Failed to close API server cleanly', error);
        process.exitCode = 1;
      }
      resolve();
    });
  });

  await pool.end();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

server.on('error', (error) => {
  console.error('Failed to start API server', error);
  process.exitCode = 1;
  void pool.end();
});
