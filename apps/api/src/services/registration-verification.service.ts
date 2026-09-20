import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

import { AppError } from '../errors.js';

const DEFAULT_CODE_TTL_SECONDS = 10 * 60;
const DEFAULT_RESEND_COOLDOWN_SECONDS = 60;
const DEFAULT_MAX_ATTEMPTS = 5;

interface PendingVerification {
  codeHash: Buffer;
  expiresAt: number;
  resendAt: number;
  failedAttempts: number;
}

export interface RegistrationVerificationChallenge {
  expiresInSeconds: number;
  resendAfterSeconds: number;
  /** 仅供本地开发和自动化测试展示；生产环境永远不返回。 */
  testCode?: string;
}

export interface RegistrationVerificationService {
  issue(email: string, onCodeIssued?: (code: string) => void): RegistrationVerificationChallenge;
  verify(email: string, code: string): void;
  consume(email: string): void;
}

export interface CreateRegistrationVerificationServiceOptions {
  exposeTestCode: boolean;
  codeTtlSeconds?: number;
  resendCooldownSeconds?: number;
  maxAttempts?: number;
  generateCode?: () => string;
  now?: () => number;
}

export function createRegistrationVerificationService(
  options: CreateRegistrationVerificationServiceOptions,
): RegistrationVerificationService {
  const {
    exposeTestCode,
    codeTtlSeconds = DEFAULT_CODE_TTL_SECONDS,
    resendCooldownSeconds = DEFAULT_RESEND_COOLDOWN_SECONDS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    generateCode = () => randomInt(100_000, 1_000_000).toString(),
    now = Date.now,
  } = options;
  const pendingByEmail = new Map<string, PendingVerification>();

  return {
    issue(email, onCodeIssued) {
      const normalizedEmail = normalizeEmail(email);
      const currentTime = now();
      const pending = pendingByEmail.get(normalizedEmail);

      if (pending && currentTime < pending.resendAt) {
        throw new AppError(
          429,
          'VERIFICATION_CODE_RATE_LIMITED',
          'Please wait before requesting another verification code',
        );
      }

      const code = generateCode();
      if (!/^\d{6}$/.test(code)) {
        throw new Error('Registration verification code generator must return six digits');
      }

      pendingByEmail.set(normalizedEmail, {
        codeHash: hashCode(normalizedEmail, code),
        expiresAt: currentTime + codeTtlSeconds * 1_000,
        resendAt: currentTime + resendCooldownSeconds * 1_000,
        failedAttempts: 0,
      });

      // Keep the code out of the public challenge while allowing the auth
      // service to hand it to a configured delivery provider.
      onCodeIssued?.(code);

      return {
        expiresInSeconds: codeTtlSeconds,
        resendAfterSeconds: resendCooldownSeconds,
        ...(exposeTestCode ? { testCode: code } : {}),
      };
    },

    verify(email, code) {
      const normalizedEmail = normalizeEmail(email);
      const pending = pendingByEmail.get(normalizedEmail);

      if (!pending) {
        throw new AppError(
          400,
          'VERIFICATION_CODE_REQUIRED',
          'Request a verification code before registering',
        );
      }

      if (now() >= pending.expiresAt) {
        pendingByEmail.delete(normalizedEmail);
        throw new AppError(400, 'VERIFICATION_CODE_EXPIRED', 'Verification code has expired');
      }

      const suppliedHash = hashCode(normalizedEmail, code);
      if (!timingSafeEqual(pending.codeHash, suppliedHash)) {
        pending.failedAttempts += 1;

        if (pending.failedAttempts >= maxAttempts) {
          pendingByEmail.delete(normalizedEmail);
          throw new AppError(
            400,
            'VERIFICATION_CODE_ATTEMPTS_EXCEEDED',
            'Too many invalid verification code attempts',
          );
        }

        throw new AppError(400, 'INVALID_VERIFICATION_CODE', 'Verification code is invalid');
      }
    },

    consume(email) {
      pendingByEmail.delete(normalizeEmail(email));
    },
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashCode(email: string, code: string): Buffer {
  return createHash('sha256').update(email).update('\0').update(code).digest();
}
