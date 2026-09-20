import { Buffer } from 'node:buffer';

import type { SignOptions } from 'jsonwebtoken';

const nodeEnvironments = ['development', 'test', 'production'] as const;
const accessTokenTtlPattern = /^(\d+)(s|m|h|d)$/;
const secondsPerUnit = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
} as const;

export type NodeEnvironment = (typeof nodeEnvironments)[number];

export interface DevelopmentAdminConfig {
  readonly email: string;
  readonly password: string;
  readonly name: string;
}

export interface ResendEmailConfig {
  readonly apiKey: string;
  readonly from: string;
}

export interface AppConfig {
  readonly nodeEnv: NodeEnvironment;
  readonly host: string;
  readonly port: number;
  readonly corsOrigins: string[];
  readonly databaseUrl: string;
  readonly jwtAccessSecret: string;
  readonly jwtIssuer: string;
  readonly jwtAudience: string;
  readonly accessTokenTtl: SignOptions['expiresIn'];
  readonly refreshTokenTtlDays: number;
  readonly resendEmail?: ResendEmailConfig | null;
  /** 仅 development 环境可用；test/production 中始终为 null。 */
  readonly developmentAdmin: DevelopmentAdminConfig | null;
}

function readEnum<T extends string>(
  name: string,
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  const candidate = value?.trim() || fallback;

  if (!allowed.includes(candidate as T)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  }

  return candidate as T;
}

function readPort(value: string | undefined): number {
  const port = Number(value?.trim() || '3000');

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  return port;
}

function readRequired(name: string, value: string | undefined): string {
  const candidate = value?.trim();

  if (!candidate) {
    throw new Error(`${name} must be configured`);
  }

  return candidate;
}

function readPositiveInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const candidate = Number(value?.trim() || fallback);

  if (!Number.isInteger(candidate) || candidate <= 0 || candidate > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }

  return candidate;
}

function readCorsOrigins(value: string | undefined): string[] {
  const origins = (value ?? 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    throw new Error('CORS_ORIGINS must contain at least one origin');
  }

  if (origins.includes('*')) {
    throw new Error('CORS_ORIGINS must use explicit origins when credentials are enabled');
  }

  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`CORS_ORIGINS contains an invalid origin: ${origin}`);
    }

    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error(`CORS_ORIGINS contains an invalid origin: ${origin}`);
    }
  }

  return [...new Set(origins)];
}

function readDatabaseUrl(value: string | undefined): string {
  const databaseUrl = readRequired('DATABASE_URL', value);

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL must use the postgres or postgresql protocol');
  }

  return databaseUrl;
}

function readAccessTokenTtl(value: string | undefined): SignOptions['expiresIn'] {
  const candidate = value?.trim() || '15m';
  const match = accessTokenTtlPattern.exec(candidate);

  if (!match) {
    throw new Error('ACCESS_TOKEN_TTL must use a duration such as 15m, 1h, or 1d');
  }

  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof secondsPerUnit;
  const seconds = amount * secondsPerUnit[unit];

  if (!Number.isSafeInteger(amount) || seconds < 60 || seconds > 24 * 60 * 60) {
    throw new Error('ACCESS_TOKEN_TTL must be between 60 seconds and 1 day');
  }

  return candidate as SignOptions['expiresIn'];
}

function readBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  const candidate = value?.trim().toLowerCase();

  if (!candidate) return fallback;
  if (candidate === 'true') return true;
  if (candidate === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function readDevelopmentAdmin(
  nodeEnv: NodeEnvironment,
  env: NodeJS.ProcessEnv,
): DevelopmentAdminConfig | null {
  const enabled = readBoolean(
    'DEV_ADMIN_ENABLED',
    env.DEV_ADMIN_ENABLED,
    nodeEnv === 'development',
  );

  // 已知的默认密码只能服务本地开发，不能被配置开关带入生产或测试环境。
  if (enabled && nodeEnv !== 'development') {
    throw new Error('DEV_ADMIN_ENABLED can only be true in development');
  }

  if (!enabled) return null;

  const email = (env.DEV_ADMIN_EMAIL?.trim() || 'admin@qq.com').toLowerCase();
  const password = env.DEV_ADMIN_PASSWORD ?? '123456';
  const name = env.DEV_ADMIN_NAME?.trim() || '系统管理员';

  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('DEV_ADMIN_EMAIL must be a valid email address');
  }

  if (!password || Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('DEV_ADMIN_PASSWORD must contain between 1 and 72 UTF-8 bytes');
  }

  if (name.length > 80) {
    throw new Error('DEV_ADMIN_NAME must not exceed 80 characters');
  }

  return { email, password, name };
}

function readResendEmailConfig(env: NodeJS.ProcessEnv): ResendEmailConfig | null {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.RESEND_FROM?.trim();

  if (!apiKey && !from) return null;
  if (!apiKey || !from) {
    throw new Error('RESEND_API_KEY and RESEND_FROM must be configured together');
  }

  const namedAddressMatch = /^([^<>\r\n]+)\s+<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>$/.exec(from);
  const isPlainAddress = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from);
  if ((!namedAddressMatch && !isPlainAddress) || from.length > 320) {
    throw new Error('RESEND_FROM must be an email or Name <email>');
  }

  const senderName = namedAddressMatch?.[1].trim();
  if (senderName && senderName.length > 80) {
    throw new Error('RESEND_FROM sender name must not exceed 80 characters');
  }

  return { apiKey, from };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = readEnum('NODE_ENV', env.NODE_ENV, nodeEnvironments, 'development');
  const jwtAccessSecret = readRequired(
    'JWT_ACCESS_SECRET',
    env.JWT_ACCESS_SECRET ?? env.JWT_SECRET,
  );

  if (jwtAccessSecret.length < 32) {
    throw new Error('JWT_ACCESS_SECRET must contain at least 32 characters');
  }

  return {
    nodeEnv,
    host: env.HOST?.trim() || '0.0.0.0',
    port: readPort(env.PORT),
    corsOrigins: readCorsOrigins(env.CORS_ORIGINS ?? env.FRONTEND_ORIGIN),
    databaseUrl: readDatabaseUrl(env.DATABASE_URL),
    jwtAccessSecret,
    jwtIssuer: readRequired('JWT_ISSUER', env.JWT_ISSUER),
    jwtAudience: readRequired('JWT_AUDIENCE', env.JWT_AUDIENCE),
    accessTokenTtl: readAccessTokenTtl(env.ACCESS_TOKEN_TTL),
    refreshTokenTtlDays: readPositiveInteger(
      'REFRESH_TOKEN_TTL_DAYS',
      env.REFRESH_TOKEN_TTL_DAYS,
      7,
      90,
    ),
    resendEmail: readResendEmailConfig(env),
    developmentAdmin: readDevelopmentAdmin(nodeEnv, env),
  };
}
