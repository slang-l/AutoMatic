import { randomUUID } from 'node:crypto';

import bcrypt from 'bcryptjs';

import type { AppConfig } from '../config.js';
import { AppError, UpstreamServiceError } from '../errors.js';
import { toPublicUser, type AuthRepository } from '../repositories/auth.repository.js';
import type { PublicUser, User } from '../type/auth.js';
import { generateRefreshToken, hashRefreshToken, type TokenService } from './token.service.js';
import type {
  RegistrationVerificationChallenge,
  RegistrationVerificationService,
} from './registration-verification.service.js';
import type { RegistrationVerificationCodeSender } from './registration-verification-sender.service.js';

export interface Credentials {
  email: string;
  password: string;
}

export interface RegisterInput extends Credentials {
  name?: string;
  verificationCode: string;
}

export interface SessionMetadata {
  ip: string | null;
  userAgent: string | null;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: PublicUser;
}

export interface AuthService {
  requestRegistrationVerificationCode(email: string): Promise<RegistrationVerificationChallenge>;
  register(input: RegisterInput, metadata: SessionMetadata): Promise<AuthResult>;
  login(input: Credentials, metadata: SessionMetadata): Promise<AuthResult>;
  refresh(refreshToken: string, metadata: SessionMetadata): Promise<AuthResult>;
  logout(refreshToken: string | null): Promise<void>;
}

export interface CreateAuthServiceOptions {
  config: AppConfig;
  repository: AuthRepository;
  registrationVerificationService: RegistrationVerificationService;
  tokenService: TokenService;
  passwordHashRounds?: number;
  registrationVerificationCodeSender?: RegistrationVerificationCodeSender;
}

// 用于不存在用户时执行一次真实 bcrypt compare，降低邮箱枚举的时序差异。
const DUMMY_PASSWORD_HASH = '$2b$12$f5zfgE4XrY1CQy6/nXjPQuHQUHlgGSLrhiEMmzEAW4qQXJvtLaAyq';

export function createAuthService(options: CreateAuthServiceOptions): AuthService {
  const {
    config,
    repository,
    registrationVerificationService,
    tokenService,
    passwordHashRounds = 12,
    registrationVerificationCodeSender,
  } = options;
  const dummyPasswordHash =
    passwordHashRounds === 12
      ? DUMMY_PASSWORD_HASH
      : bcrypt.hashSync('automatic-dummy-password', passwordHashRounds);

  function refreshExpiry(): Date {
    return new Date(Date.now() + config.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
  }

  function authResult(user: User, refreshToken: string, refreshExpiresAt: Date): AuthResult {
    return {
      accessToken: tokenService.signAccessToken(user),
      refreshToken,
      refreshExpiresAt,
      user: toPublicUser(user),
    };
  }

  async function issueSession(
    user: User,
    metadata: SessionMetadata,
    familyId = randomUUID(),
  ): Promise<AuthResult> {
    const refreshToken = generateRefreshToken();
    const refreshExpiresAt = refreshExpiry();

    await repository.createRefreshSession({
      tokenHash: hashRefreshToken(refreshToken),
      userId: user.id,
      familyId,
      expiresAt: refreshExpiresAt,
      ...metadata,
    });

    return authResult(user, refreshToken, refreshExpiresAt);
  }

  function invalidRefreshToken(): never {
    // 不区分不存在、过期、撤销等状态，避免泄露会话细节。
    throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token');
  }

  return {
    async requestRegistrationVerificationCode(email) {
      if (await repository.findUserByEmail(email)) {
        throw new AppError(409, 'EMAIL_ALREADY_EXISTS', 'Email is already registered');
      }

      let issuedCode: string | undefined;
      const challenge = registrationVerificationService.issue(email, (code) => {
        issuedCode = code;
      });

      if (registrationVerificationCodeSender && issuedCode) {
        try {
          await registrationVerificationCodeSender.send({
            email: email.trim().toLowerCase(),
            code: issuedCode,
            expiresInSeconds: challenge.expiresInSeconds,
          });
        } catch {
          // A code that was not delivered must not remain rate-limited or be
          // accepted later by a user who never received it.
          registrationVerificationService.consume(email);
          throw new UpstreamServiceError(
            'VERIFICATION_CODE_DELIVERY_FAILED',
            'Unable to deliver verification code',
          );
        }
      }

      return challenge;
    },

    async register(input, metadata) {
      if (await repository.findUserByEmail(input.email)) {
        throw new AppError(409, 'EMAIL_ALREADY_EXISTS', 'Email is already registered');
      }

      registrationVerificationService.verify(input.email, input.verificationCode);

      const passwordHash = await bcrypt.hash(input.password, passwordHashRounds);
      const email = input.email.toLowerCase().trim();
      const refreshToken = generateRefreshToken();
      const refreshExpiresAt = refreshExpiry();

      try {
        const user = await repository.createUserWithRefreshSession(
          {
            email,
            passwordHash,
            // 当前 UI 没有昵称字段，因此默认取邮箱 @ 之前的部分。
            name: input.name?.trim() || email.split('@')[0] || 'User',
          },
          {
            tokenHash: hashRefreshToken(refreshToken),
            familyId: randomUUID(),
            expiresAt: refreshExpiresAt,
            ...metadata,
          },
        );

        registrationVerificationService.consume(email);

        return authResult(user, refreshToken, refreshExpiresAt);
      } catch (error) {
        // 数据库版本仍可能在并发请求下触发唯一索引冲突。
        if (error instanceof Error && error.message === 'EMAIL_ALREADY_EXISTS') {
          throw new AppError(409, 'EMAIL_ALREADY_EXISTS', 'Email is already registered');
        }
        throw error;
      }
    },

    async login(input, metadata) {
      const user = await repository.findUserByEmail(input.email);
      const passwordMatches = await bcrypt.compare(
        input.password,
        user?.passwordHash ?? dummyPasswordHash,
      );

      if (!user || !passwordMatches) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
      }

      if (user.status !== 'active') {
        throw new AppError(403, 'ACCOUNT_DISABLED', 'Account is disabled');
      }

      return await issueSession(user, metadata);
    },

    async refresh(refreshToken, metadata) {
      const currentHash = hashRefreshToken(refreshToken);
      const currentSession = await repository.findRefreshSessionByTokenHash(currentHash);

      if (!currentSession) {
        return invalidRefreshToken();
      }

      if (currentSession.revokedAt) {
        // 已轮换的旧 Token 再次出现通常意味着重放，撤销整个 Token 家族。
        await repository.revokeRefreshFamily(currentSession.familyId);
        return invalidRefreshToken();
      }

      if (currentSession.expiresAt.getTime() <= Date.now()) {
        await repository.revokeRefreshSession(currentHash);
        return invalidRefreshToken();
      }

      const user = await repository.findUserById(currentSession.userId);

      if (!user || user.status !== 'active') {
        await repository.revokeRefreshFamily(currentSession.familyId);
        return invalidRefreshToken();
      }

      // 每次刷新都生成新 Token，并让旧 Token 指向替代它的新哈希。
      const nextRefreshToken = generateRefreshToken();
      const nextHash = hashRefreshToken(nextRefreshToken);
      const rotated = await repository.rotateRefreshSession(currentHash, {
        tokenHash: nextHash,
        ...metadata,
      });

      if (!rotated) {
        // A concurrent reuse lost the compare-and-swap. Revoke the family so a
        // token copied before rotation cannot keep the newly-created child.
        await repository.revokeRefreshFamily(currentSession.familyId);
        return invalidRefreshToken();
      }

      return authResult(user, nextRefreshToken, currentSession.expiresAt);
    },

    async logout(refreshToken) {
      if (!refreshToken) {
        return;
      }

      // Revoke the whole rotation family. The repository locks the supplied
      // token row so a concurrent refresh cannot leave a replacement alive.
      await repository.revokeRefreshFamilyByTokenHash(hashRefreshToken(refreshToken));
    },
  };
}
