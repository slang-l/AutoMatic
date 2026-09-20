import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import express from 'express';
import jwt, { type SignOptions } from 'jsonwebtoken';
import request from 'supertest';

import { buildApp, registerErrorHandlers } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { createMemoryAuthRepository } from '../src/repositories/memory.repository.js';
import { createMemoryWechatRepository } from '../src/repositories/memory-wechat.repository.js';
import { createAuthService } from '../src/services/auth.service.js';
import { provisionDevelopmentAdmin } from '../src/services/development-admin.service.js';
import { createResendRegistrationVerificationCodeSender } from '../src/services/registration-verification-sender.service.js';
import { createRegistrationVerificationService } from '../src/services/registration-verification.service.js';
import { createTokenService } from '../src/services/token.service.js';
import type { User } from '../src/type/auth.js';

const testConfig: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3000,
  corsOrigins: ['http://localhost:5173'],
  databaseUrl: 'postgresql://automatic:test@localhost:5432/automatic_test',
  jwtAccessSecret: 'test-secret-that-is-at-least-32-characters-long',
  jwtIssuer: 'automatic-api-test',
  jwtAudience: 'automatic-web-test',
  accessTokenTtl: '15m',
  refreshTokenTtlDays: 7,
  developmentAdmin: null,
};

const validEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '3000',
  CORS_ORIGINS: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://automatic:test@localhost:5432/automatic_test',
  JWT_ACCESS_SECRET: 'test-secret-that-is-at-least-32-characters-long',
  JWT_ISSUER: 'automatic-api-test',
  JWT_AUDIENCE: 'automatic-web-test',
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL_DAYS: '7',
};

const tokenTestUser: User = {
  id: 'b4016006-b4a7-467a-9945-44c65842bafd',
  email: 'token@example.com',
  name: 'Token Tester',
  passwordHash: 'not-exposed-or-used-by-token-service',
  role: 'user',
  status: 'active',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

function createTestApp(config: AppConfig = testConfig) {
  return buildApp({
    config,
    passwordHashRounds: 4,
    registrationVerificationService: createTestRegistrationVerificationService(),
  });
}

function createTestRegistrationVerificationService() {
  return createRegistrationVerificationService({
    exposeTestCode: true,
    generateCode: () => '123456',
  });
}

function cookieFrom(response: request.Response): string {
  const setCookie = response.headers['set-cookie'];
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.equal(typeof value, 'string');
  return value.split(';', 1)[0];
}

async function registerUser(app = createTestApp(), email = 'writer@example.com') {
  const verification = await request(app)
    .post('/api/auth/register/verification-code')
    .send({ email });
  assert.equal(verification.statusCode, 201);
  assert.equal(verification.body.testCode, '123456');

  const response = await request(app).post('/api/auth/register').send({
    email,
    password: 'correct horse battery staple',
    name: 'Writer',
    verificationCode: verification.body.testCode,
  });

  assert.equal(response.statusCode, 201);
  return { app, response, cookie: cookieFrom(response) };
}

test('GET /api/health returns service status', async () => {
  const response = await request(createTestApp())
    .get('/api/health')
    .set('origin', 'http://localhost:5173');

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['access-control-allow-origin'], 'http://localhost:5173');
  assert.equal(response.headers['access-control-allow-credentials'], 'true');
  assert.equal(response.body.status, 'ok');
  assert.equal(response.body.service, 'automatic-api');
  assert.equal(typeof response.body.timestamp, 'string');
  assert.equal(typeof response.body.uptime, 'number');
});

test('register issues an access token and an HttpOnly refresh cookie', async () => {
  const { response } = await registerUser();
  const setCookie = response.headers['set-cookie'] as unknown as string[];

  assert.equal(typeof response.body.accessToken, 'string');
  assert.equal(response.body.user.email, 'writer@example.com');
  assert.equal(response.body.user.name, 'Writer');
  assert.equal(response.body.refreshToken, undefined);
  assert.match(setCookie[0], /^automatic_refresh_token=/);
  assert.match(setCookie[0], /HttpOnly/i);
  assert.match(setCookie[0], /SameSite=Lax/i);
  assert.match(setCookie[0], /Path=\/api\/auth/i);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('registration requires the server-issued code and limits resends', async () => {
  const app = createTestApp();
  const registration = {
    email: 'verified@example.com',
    password: 'correct horse battery staple',
    verificationCode: '123456',
  };

  const withoutChallenge = await request(app).post('/api/auth/register').send(registration);
  assert.equal(withoutChallenge.statusCode, 400);
  assert.equal(withoutChallenge.body.error.code, 'VERIFICATION_CODE_REQUIRED');

  const challenge = await request(app)
    .post('/api/auth/register/verification-code')
    .send({ email: registration.email });
  assert.equal(challenge.statusCode, 201);
  assert.equal(challenge.body.testCode, '123456');
  assert.equal(challenge.body.expiresInSeconds, 600);
  assert.equal(challenge.body.resendAfterSeconds, 60);

  const resend = await request(app)
    .post('/api/auth/register/verification-code')
    .send({ email: registration.email });
  assert.equal(resend.statusCode, 429);
  assert.equal(resend.body.error.code, 'VERIFICATION_CODE_RATE_LIMITED');

  const invalid = await request(app)
    .post('/api/auth/register')
    .send({ ...registration, verificationCode: '654321' });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.error.code, 'INVALID_VERIFICATION_CODE');

  const verified = await request(app).post('/api/auth/register').send(registration);
  assert.equal(verified.statusCode, 201);
  assert.equal(verified.body.user.email, registration.email);
});

test('registration verification can be delivered and failed deliveries are retryable', async () => {
  const delivered: Array<{ email: string; code: string; expiresInSeconds: number }> = [];
  const app = buildApp({
    config: testConfig,
    passwordHashRounds: 4,
    registrationVerificationService: createTestRegistrationVerificationService(),
    registrationVerificationCodeSender: {
      async send(input) {
        delivered.push(input);
      },
    },
  });

  const sent = await request(app)
    .post('/api/auth/register/verification-code')
    .send({ email: 'delivered@example.com' });

  assert.equal(sent.statusCode, 201);
  assert.deepEqual(delivered, [
    { email: 'delivered@example.com', code: '123456', expiresInSeconds: 600 },
  ]);

  let attempts = 0;
  const failedApp = buildApp({
    config: testConfig,
    passwordHashRounds: 4,
    registrationVerificationService: createTestRegistrationVerificationService(),
    registrationVerificationCodeSender: {
      async send() {
        attempts += 1;
        throw new Error('provider unavailable');
      },
    },
  });

  const failed = await request(failedApp)
    .post('/api/auth/register/verification-code')
    .send({ email: 'retry@example.com' });
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.body.error.code, 'VERIFICATION_CODE_DELIVERY_FAILED');

  const retried = await request(failedApp)
    .post('/api/auth/register/verification-code')
    .send({ email: 'retry@example.com' });
  assert.equal(retried.statusCode, 502);
  assert.equal(attempts, 2);
});

test('Resend verification sender builds the email request and rejects failures', async () => {
  let requestedUrl = '';
  let requestedInit: RequestInit | undefined;
  const sender = createResendRegistrationVerificationCodeSender({
    apiKey: 'test-api-key',
    from: 'AutoMatic Test <sender@example.com>',
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return new Response(null, { status: 201 });
    },
  });

  await sender.send({ email: 'reader@example.com', code: '123456', expiresInSeconds: 600 });

  assert.equal(requestedUrl, 'https://api.resend.com/emails');
  assert.equal(requestedInit?.method, 'POST');
  assert.equal(new Headers(requestedInit?.headers).get('authorization'), 'Bearer test-api-key');
  const body = JSON.parse(String(requestedInit?.body)) as {
    from: string;
    to: string[];
    text: string;
  };
  assert.equal(body.from, 'AutoMatic Test <sender@example.com>');
  assert.deepEqual(body.to, ['reader@example.com']);
  assert.match(body.text, /123456/);

  const failingSender = createResendRegistrationVerificationCodeSender({
    apiKey: 'test-api-key',
    from: 'AutoMatic Test <sender@example.com>',
    fetchImpl: async () => new Response(null, { status: 400 }),
  });
  await assert.rejects(
    failingSender.send({ email: 'reader@example.com', code: '123456', expiresInSeconds: 600 }),
    /HTTP 400/,
  );
});

test('expired verification codes are rejected and production challenges hide test codes', () => {
  let currentTime = 1_000;
  const expiringService = createRegistrationVerificationService({
    exposeTestCode: true,
    codeTtlSeconds: 10,
    generateCode: () => '123456',
    now: () => currentTime,
  });

  expiringService.issue('expiry@example.com');
  currentTime += 10_000;

  assert.throws(
    () => expiringService.verify('expiry@example.com', '123456'),
    (error: unknown) => error instanceof AppError && error.code === 'VERIFICATION_CODE_EXPIRED',
  );

  const productionService = createRegistrationVerificationService({
    exposeTestCode: false,
    generateCode: () => '123456',
  });
  const challenge = productionService.issue('private@example.com');
  assert.equal(challenge.testCode, undefined);
});

test('production refresh cookies are marked Secure', async () => {
  const app = createTestApp({ ...testConfig, nodeEnv: 'production' });
  const { response } = await registerUser(app);
  const setCookie = String(response.headers['set-cookie']);

  // Browsers must never send the long-lived refresh credential over plain HTTP
  // in production. Development intentionally omits Secure for localhost HTTP.
  assert.match(setCookie, /; Secure/i);
  assert.match(setCookie, /; HttpOnly/i);
  assert.match(setCookie, /; SameSite=Lax/i);
});

test('auth writes accept configured origins and reject untrusted origins', async () => {
  const app = createTestApp();
  const input = {
    email: 'origin@example.com',
    password: 'correct horse battery staple',
    verificationCode: '123456',
  };

  const verification = await request(app)
    .post('/api/auth/register/verification-code')
    .set('origin', 'http://localhost:5173')
    .send({ email: input.email });
  assert.equal(verification.statusCode, 201);

  const rejected = await request(app)
    .post('/api/auth/register')
    .set('origin', 'https://attacker.example')
    .send(input);
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejected.body.error.code, 'UNTRUSTED_ORIGIN');
  assert.equal(rejected.headers['access-control-allow-origin'], undefined);

  // Origin verification runs before registration, so the rejected request must
  // not have created a user or otherwise changed authentication state.
  const accepted = await request(app)
    .post('/api/auth/register')
    .set('origin', 'http://localhost:5173')
    .send(input);
  assert.equal(accepted.statusCode, 201);
  assert.equal(accepted.headers['access-control-allow-origin'], 'http://localhost:5173');
});

test('registration normalizes email and rejects duplicates', async () => {
  const app = createTestApp();
  await registerUser(app, 'Writer@Example.com');

  const duplicate = await request(app).post('/api/auth/register').send({
    email: 'writer@example.com',
    password: 'another secure password',
    verificationCode: '000000',
  });

  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.body.error.code, 'EMAIL_ALREADY_EXISTS');
});

test('login rejects invalid credentials and accepts the stored password', async () => {
  const app = createTestApp();
  await registerUser(app);

  const invalid = await request(app)
    .post('/api/auth/login')
    .send({ email: 'writer@example.com', password: 'wrong password' });
  assert.equal(invalid.statusCode, 401);
  assert.equal(invalid.body.error.code, 'INVALID_CREDENTIALS');

  const valid = await request(app).post('/api/auth/login').send({
    email: 'writer@example.com',
    password: 'correct horse battery staple',
  });
  assert.equal(valid.statusCode, 200);
  assert.equal(typeof valid.body.accessToken, 'string');
});

test('development administrator is provisioned idempotently with the admin role', async () => {
  const repository = createMemoryAuthRepository();
  const config: AppConfig = {
    ...testConfig,
    nodeEnv: 'development',
    developmentAdmin: {
      email: 'admin@qq.com',
      password: '123456',
      name: '系统管理员',
    },
  };

  const first = await provisionDevelopmentAdmin({
    config,
    repository,
    passwordHashRounds: 4,
  });
  const second = await provisionDevelopmentAdmin({
    config,
    repository,
    passwordHashRounds: 4,
  });

  assert.equal(first?.id, second?.id);
  assert.equal(second?.email, 'admin@qq.com');
  assert.equal(second?.role, 'admin');
  assert.equal(second?.status, 'active');

  const authService = createAuthService({
    config,
    repository,
    registrationVerificationService: createTestRegistrationVerificationService(),
    tokenService: createTokenService(config),
    passwordHashRounds: 4,
  });
  const session = await authService.login(
    { email: 'admin@qq.com', password: '123456' },
    { ip: null, userAgent: null },
  );
  assert.equal(session.user.role, 'admin');
});

test('development administrator is never enabled outside development', () => {
  assert.throws(
    () =>
      loadConfig({
        ...validEnvironment,
        NODE_ENV: 'production',
        DEV_ADMIN_ENABLED: 'true',
      }),
    /only be true in development/,
  );

  const production = loadConfig({
    ...validEnvironment,
    NODE_ENV: 'production',
  });
  assert.equal(production.developmentAdmin, null);
});

test('GET /api/auth/me requires and verifies a Bearer access token', async () => {
  const { app, response } = await registerUser();

  const missing = await request(app).get('/api/auth/me');
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.body.error.code, 'AUTHENTICATION_REQUIRED');

  const invalid = await request(app).get('/api/auth/me').set('authorization', 'Bearer not-a-jwt');
  assert.equal(invalid.statusCode, 401);
  assert.equal(invalid.body.error.code, 'INVALID_ACCESS_TOKEN');

  const valid = await request(app)
    .get('/api/auth/me')
    .set('authorization', `Bearer ${response.body.accessToken}`);
  assert.equal(valid.statusCode, 200);
  assert.equal(valid.body.user.email, 'writer@example.com');
  assert.equal(valid.body.user.passwordHash, undefined);
});

test('token service signs a verifiable HS256 access token with required claims', () => {
  const tokenService = createTokenService(testConfig);
  const token = tokenService.signAccessToken(tokenTestUser);
  const claims = tokenService.verifyAccessToken(token);
  const decoded = jwt.decode(token, { complete: true });

  assert.equal(claims.type, 'access');
  assert.equal(claims.sub, tokenTestUser.id);
  assert.equal(claims.role, tokenTestUser.role);
  assert.equal(claims.iss, testConfig.jwtIssuer);
  assert.equal(claims.aud, testConfig.jwtAudience);
  assert.equal(typeof claims.jti, 'string');
  assert.equal(decoded?.header.alg, 'HS256');
});

test('token service rejects invalid issuer, audience, type, expiry, and algorithm', () => {
  const tokenService = createTokenService(testConfig);
  const claims = { type: 'access', role: tokenTestUser.role };

  function sign(options: Partial<SignOptions> = {}): string {
    return jwt.sign(claims, testConfig.jwtAccessSecret, {
      algorithm: 'HS256',
      subject: tokenTestUser.id,
      issuer: testConfig.jwtIssuer,
      audience: testConfig.jwtAudience,
      expiresIn: '15m',
      jwtid: 'token-test-id',
      ...options,
    });
  }

  const wrongIssuer = sign({ issuer: 'untrusted-issuer' });
  const wrongAudience = sign({ audience: 'untrusted-audience' });
  const expired = sign({ expiresIn: -1 });
  const wrongAlgorithm = sign({ algorithm: 'HS384' });
  const wrongType = jwt.sign({ ...claims, type: 'refresh' }, testConfig.jwtAccessSecret, {
    algorithm: 'HS256',
    subject: tokenTestUser.id,
    issuer: testConfig.jwtIssuer,
    audience: testConfig.jwtAudience,
    expiresIn: '15m',
    jwtid: 'refresh-token-test-id',
  });

  for (const token of [wrongIssuer, wrongAudience, wrongType, expired, wrongAlgorithm]) {
    assert.throws(() => tokenService.verifyAccessToken(token));
  }
});

test('refresh rotates tokens and replay revokes the whole token family', async () => {
  const { app, cookie: originalCookie } = await registerUser();

  const rotated = await request(app).post('/api/auth/refresh').set('cookie', originalCookie);
  assert.equal(rotated.statusCode, 200);
  const rotatedCookie = cookieFrom(rotated);
  assert.notEqual(rotatedCookie, originalCookie);

  const replay = await request(app).post('/api/auth/refresh').set('cookie', originalCookie);
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.body.error.code, 'INVALID_REFRESH_TOKEN');

  const revokedFamily = await request(app).post('/api/auth/refresh').set('cookie', rotatedCookie);
  assert.equal(revokedFamily.statusCode, 401);
  assert.equal(revokedFamily.body.error.code, 'INVALID_REFRESH_TOKEN');
});

test('refresh requires its HttpOnly cookie', async () => {
  const response = await request(createTestApp()).post('/api/auth/refresh');

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.error.code, 'INVALID_REFRESH_TOKEN');
  assert.equal(typeof response.body.error.requestId, 'string');
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('browser cross-site refresh is rejected without consuming the token', async () => {
  const { app, cookie } = await registerUser();

  const rejected = await request(app)
    .post('/api/auth/refresh')
    .set('cookie', cookie)
    .set('sec-fetch-site', 'cross-site');
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejected.body.error.code, 'UNTRUSTED_ORIGIN');

  // Requests without browser provenance headers remain available to trusted
  // CLI/service clients. Success also proves the blocked request did not rotate
  // or revoke the refresh credential before origin verification rejected it.
  const cliRefresh = await request(app).post('/api/auth/refresh').set('cookie', cookie);
  assert.equal(cliRefresh.statusCode, 200);
  assert.equal(typeof cliRefresh.body.accessToken, 'string');
});

test('concurrent refresh requests consume a token only once', async () => {
  const { app, cookie } = await registerUser();

  // Both requests present exactly the same one-time refresh credential. The
  // repository rotation is a compare-and-swap: only one request may consume it.
  const responses = await Promise.all([
    request(app).post('/api/auth/refresh').set('cookie', cookie),
    request(app).post('/api/auth/refresh').set('cookie', cookie),
  ]);
  const statuses = responses.map((response) => response.statusCode).sort();

  assert.deepEqual(statuses, [200, 401]);
  const rejected = responses.find((response) => response.statusCode === 401);
  const accepted = responses.find((response) => response.statusCode === 200);
  assert.equal(rejected?.body.error.code, 'INVALID_REFRESH_TOKEN');
  assert.ok(accepted);

  // Reuse is treated as a possible theft signal and revokes the whole family,
  // including the child token returned by the request that won the race.
  const childCookie = cookieFrom(accepted);
  const afterReplay = await request(app).post('/api/auth/refresh').set('cookie', childCookie);
  assert.equal(afterReplay.statusCode, 401);
  assert.equal(afterReplay.body.error.code, 'INVALID_REFRESH_TOKEN');
});

test('logout revokes the refresh token and clears its cookie', async () => {
  const { app, cookie } = await registerUser();

  const logout = await request(app).post('/api/auth/logout').set('cookie', cookie);
  assert.equal(logout.statusCode, 204);
  assert.match(String(logout.headers['set-cookie']), /automatic_refresh_token=;/);

  const refresh = await request(app).post('/api/auth/refresh').set('cookie', cookie);
  assert.equal(refresh.statusCode, 401);
});

test('logout revokes every rotated token in the refresh family', async () => {
  const { app, cookie: originalCookie } = await registerUser();
  const rotated = await request(app).post('/api/auth/refresh').set('cookie', originalCookie);
  assert.equal(rotated.statusCode, 200);
  const rotatedCookie = cookieFrom(rotated);

  const logout = await request(app).post('/api/auth/logout').set('cookie', originalCookie);
  assert.equal(logout.statusCode, 204);

  const refresh = await request(app).post('/api/auth/refresh').set('cookie', rotatedCookie);
  assert.equal(refresh.statusCode, 401);
});

test('auth endpoints reject malformed bodies without creating users', async () => {
  const app = createTestApp();
  const invalid = await request(app)
    .post('/api/auth/register')
    .send({ email: 'not-an-email', password: 'short' });

  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.error.code, 'INVALID_REQUEST');

  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: 'not-an-email', password: 'short' });
  assert.equal(login.statusCode, 400);
});

test('unknown routes return the standard error envelope', async () => {
  const response = await request(createTestApp()).get('/missing');

  assert.equal(response.statusCode, 404);
  assert.equal(response.body.error.code, 'NOT_FOUND');
  assert.equal(typeof response.body.error.requestId, 'string');
  assert.equal(response.headers['x-request-id'], response.body.error.requestId);
});

test('configuration validates ports, CORS, database URLs, secrets, and TTLs', () => {
  assert.throws(() => loadConfig({ ...validEnvironment, PORT: '70000' }), /PORT/);
  assert.throws(() => loadConfig({ ...validEnvironment, CORS_ORIGINS: '*' }), /explicit origins/);
  assert.throws(
    () => loadConfig({ ...validEnvironment, DATABASE_URL: 'sqlite:data.db' }),
    /postgres/i,
  );
  assert.throws(() => loadConfig({ ...validEnvironment, JWT_ACCESS_SECRET: 'too-short' }), /32/);
  assert.throws(() => loadConfig({ ...validEnvironment, ACCESS_TOKEN_TTL: '1000' }), /duration/);
  assert.throws(() => loadConfig({ ...validEnvironment, ACCESS_TOKEN_TTL: '2d' }), /between/);
  assert.throws(
    () => loadConfig({ ...validEnvironment, RESEND_API_KEY: 'test-api-key' }),
    /configured together/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...validEnvironment,
        RESEND_API_KEY: 'test-api-key',
        RESEND_FROM: 'not-an-email',
      }),
    /RESEND_FROM/,
  );

  const config = loadConfig(validEnvironment);
  assert.equal(config.accessTokenTtl, '15m');
  assert.equal(config.refreshTokenTtlDays, 7);

  const defaultOrigins = loadConfig({
    ...validEnvironment,
    CORS_ORIGINS: undefined,
    FRONTEND_ORIGIN: undefined,
  }).corsOrigins;
  assert.deepEqual(defaultOrigins, ['http://localhost:5173', 'http://127.0.0.1:5173']);

  const emailConfig = loadConfig({
    ...validEnvironment,
    RESEND_API_KEY: 'test-api-key',
    RESEND_FROM: 'AutoMatic Test <sender@example.com>',
  }).resendEmail;
  assert.deepEqual(emailConfig, {
    apiKey: 'test-api-key',
    from: 'AutoMatic Test <sender@example.com>',
  });
});

test('AppError only accepts public 4xx status codes', () => {
  assert.throws(
    () => new AppError(500, 'SECRET_ERROR', 'Sensitive internal details'),
    /between 400 and 499/,
  );
});

test('4xx errors preserve protocol headers', async () => {
  const app = express();
  app.get('/limited', () => {
    throw Object.assign(new Error('Too many requests'), {
      code: 'RATE_LIMITED',
      statusCode: 429,
      headers: { 'retry-after': '60' },
    });
  });
  registerErrorHandlers(app, false);

  const response = await request(app).get('/limited');

  assert.equal(response.statusCode, 429);
  assert.equal(response.headers['retry-after'], '60');
  assert.equal(response.body.error.code, 'RATE_LIMITED');
});

test('brand assets are private, validated, editable, and removable', async () => {
  const app = createTestApp();
  const { response: registration } = await registerUser(app, 'brand-owner@example.com');
  const authorization = `Bearer ${registration.body.accessToken}`;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString(
    'base64',
  );

  const unauthenticated = await request(app).get('/api/brand-assets');
  assert.equal(unauthenticated.statusCode, 401);

  const created = await request(app)
    .post('/api/brand-assets')
    .set('authorization', authorization)
    .set('origin', 'http://localhost:5173')
    .send({
      name: 'Primary Logo',
      category: 'logo',
      tags: ['Brand', 'dark', 'brand'],
      mimeType: 'image/png',
      data: png,
    });
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.name, 'Primary Logo');
  assert.deepEqual(created.body.tags, ['brand', 'dark']);
  assert.match(created.body.dataUrl, /^data:image\/png;base64,/);
  assert.equal(typeof created.body.id, 'string');

  const invalidImage = await request(app)
    .post('/api/brand-assets')
    .set('authorization', authorization)
    .set('origin', 'http://localhost:5173')
    .send({
      name: 'Not a JPEG',
      category: 'other',
      tags: [],
      mimeType: 'image/jpeg',
      data: png,
    });
  assert.equal(invalidImage.statusCode, 400);
  assert.equal(invalidImage.body.error.code, 'INVALID_BRAND_ASSET_IMAGE');

  const listed = await request(app).get('/api/brand-assets').set('authorization', authorization);
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.limit, 100);
  assert.equal(listed.body.assets.length, 1);

  const updated = await request(app)
    .put(`/api/brand-assets/${created.body.id}`)
    .set('authorization', authorization)
    .set('origin', 'http://localhost:5173')
    .send({ name: 'Square Logo', category: 'avatar', tags: ['profile'] });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.name, 'Square Logo');
  assert.equal(updated.body.category, 'avatar');
  assert.equal(updated.body.dataUrl, created.body.dataUrl);

  const { response: otherRegistration } = await registerUser(app, 'other-brand@example.com');
  const otherAuthorization = `Bearer ${otherRegistration.body.accessToken}`;
  const otherList = await request(app)
    .get('/api/brand-assets')
    .set('authorization', otherAuthorization);
  assert.equal(otherList.statusCode, 200);
  assert.deepEqual(otherList.body.assets, []);

  const crossAccountDelete = await request(app)
    .delete(`/api/brand-assets/${created.body.id}`)
    .set('authorization', otherAuthorization)
    .set('origin', 'http://localhost:5173');
  assert.equal(crossAccountDelete.statusCode, 404);

  const deleted = await request(app)
    .delete(`/api/brand-assets/${created.body.id}`)
    .set('authorization', authorization)
    .set('origin', 'http://localhost:5173');
  assert.equal(deleted.statusCode, 204);

  const empty = await request(app).get('/api/brand-assets').set('authorization', authorization);
  assert.deepEqual(empty.body.assets, []);
});

test('authenticated users can configure and publish to a WeChat official account', async () => {
  const calls: Array<{ pathname: string; body: BodyInit | null | undefined }> = [];
  const wechatFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push({ pathname: url.pathname, body: init?.body });

    const payload = (() => {
      switch (url.pathname) {
        case '/cgi-bin/stable_token':
          return { access_token: 'stable-access-token', expires_in: 7_200 };
        case '/cgi-bin/media/uploadimg':
          return { url: 'https://mmbiz.qpic.cn/test/content-image.png' };
        case '/cgi-bin/material/add_material':
          return { media_id: 'cover-media-id', url: 'https://mmbiz.qpic.cn/test/cover.png' };
        case '/cgi-bin/draft/add':
          return { media_id: 'draft-media-id' };
        case '/cgi-bin/freepublish/submit':
          return { publish_id: 123456, msg_data_id: 9988 };
        case '/cgi-bin/freepublish/get':
          return {
            publish_id: 123456,
            publish_status: 0,
            article_id: 'article-id-1',
            article_detail: {
              count: 1,
              item: [{ idx: 1, article_url: 'https://mp.weixin.qq.com/s/published' }],
            },
          };
        default:
          return { errcode: 404, errmsg: 'unexpected endpoint' };
      }
    })();

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const wechatRepository = createMemoryWechatRepository();
  const app = buildApp({
    config: testConfig,
    passwordHashRounds: 4,
    registrationVerificationService: createTestRegistrationVerificationService(),
    wechatRepository,
    wechatFetch,
  });
  const { response: registration } = await registerUser(app, 'publisher@example.com');
  const authorization = `Bearer ${registration.body.accessToken}`;

  const emptyConfig = await request(app)
    .get('/api/wechat/config')
    .set('authorization', authorization);
  assert.equal(emptyConfig.statusCode, 200);
  assert.deepEqual(emptyConfig.body, { configured: false });

  const appSecret = '0123456789abcdef0123456789abcdef';
  const savedConfig = await request(app)
    .put('/api/wechat/config')
    .set('authorization', authorization)
    .set('origin', 'http://localhost:5173')
    .send({
      appId: 'wx1234567890abcdef',
      appSecret,
      defaultAuthor: 'Writer',
      defaultDigest: 'Default digest',
    });
  assert.equal(savedConfig.statusCode, 200);
  assert.equal(savedConfig.body.configured, true);
  assert.equal(savedConfig.body.appId, 'wx1234567890abcdef');
  assert.equal(savedConfig.body.appSecret, undefined);
  assert.doesNotMatch(JSON.stringify(savedConfig.body), new RegExp(appSecret));

  const storedAccount = await wechatRepository.findAccountByUserId(registration.body.user.id);
  assert.ok(storedAccount);
  assert.notEqual(storedAccount.encryptedAppSecret, appSecret);
  assert.doesNotMatch(storedAccount.encryptedAppSecret, new RegExp(appSecret));

  const updatedConfig = await request(app)
    .put('/api/wechat/config')
    .set('authorization', authorization)
    .set('origin', 'http://localhost:5173')
    .send({
      appId: 'wx1234567890abcdef',
      defaultAuthor: 'Updated writer',
      defaultDigest: 'Updated digest',
    });
  assert.equal(updatedConfig.statusCode, 200);
  assert.equal(updatedConfig.body.defaultAuthor, 'Updated writer');
  const tokenRequests = calls.filter((call) => call.pathname === '/cgi-bin/stable_token');
  assert.equal(tokenRequests.length, 2);
  assert.equal(JSON.parse(String(tokenRequests[1]?.body)).secret, appSecret);

  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString(
    'base64',
  );
  const publish = await request(app)
    .post('/api/wechat/publish')
    .set('authorization', authorization)
    .set('origin', 'http://localhost:5173')
    .send({
      title: 'Published article',
      author: '',
      digest: '',
      content: '<section><p>Hello</p><img src="automatic-image://0"></section>',
      coverImage: { data: png, mimeType: 'image/png', filename: 'cover.png' },
      contentImages: [
        {
          data: png,
          mimeType: 'image/png',
          filename: 'inline.png',
          placeholder: 'automatic-image://0',
        },
      ],
      showCoverPic: true,
      needOpenComment: true,
      onlyFansCanComment: false,
    });
  assert.equal(publish.statusCode, 202);
  assert.equal(publish.body.publishId, '123456');
  assert.equal(publish.body.draftMediaId, 'draft-media-id');
  assert.equal(publish.body.state, 'publishing');

  const draftCall = calls.find((call) => call.pathname === '/cgi-bin/draft/add');
  assert.equal(typeof draftCall?.body, 'string');
  const draftBody = JSON.parse(String(draftCall?.body));
  assert.equal(draftBody.articles[0].author, 'Updated writer');
  assert.equal(draftBody.articles[0].digest, 'Updated digest');
  assert.match(draftBody.articles[0].content, /mmbiz\.qpic\.cn\/test\/content-image\.png/);
  assert.doesNotMatch(draftBody.articles[0].content, /automatic-image/);

  const status = await request(app)
    .get('/api/wechat/publish/123456')
    .set('authorization', authorization);
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.state, 'published');
  assert.equal(status.body.articleUrl, 'https://mp.weixin.qq.com/s/published');
});

test('unexpected errors return a generic 500 response', async () => {
  const app = express();
  app.get('/broken', () => {
    throw new Error('Sensitive internal details');
  });
  registerErrorHandlers(app, false);

  const response = await request(app).get('/broken');

  assert.equal(response.statusCode, 500);
  assert.equal(response.body.error.code, 'INTERNAL_SERVER_ERROR');
  assert.equal(response.body.error.message, 'Internal server error');
  assert.doesNotMatch(response.text, /Sensitive internal details/);
});
