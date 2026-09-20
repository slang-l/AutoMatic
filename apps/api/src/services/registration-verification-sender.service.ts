export interface RegistrationVerificationCodeSenderInput {
  email: string;
  code: string;
  expiresInSeconds: number;
}

export interface RegistrationVerificationCodeSender {
  send(input: RegistrationVerificationCodeSenderInput): Promise<void>;
}

export interface CreateResendRegistrationVerificationCodeSenderOptions {
  apiKey: string;
  from: string;
  fetchImpl?: typeof fetch;
}

/**
 * Sends registration codes through Resend's email endpoint.
 * Keeping this behind a small interface makes the auth flow testable and
 * allows deployments to replace the provider without changing registration.
 */
export function createResendRegistrationVerificationCodeSender(
  options: CreateResendRegistrationVerificationCodeSenderOptions,
): RegistrationVerificationCodeSender {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async send({ email, code, expiresInSeconds }) {
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: options.from,
          to: [email],
          subject: 'AutoMatic registration verification code',
          text: `Your AutoMatic verification code is ${code}. It expires in ${Math.ceil(
            expiresInSeconds / 60,
          )} minutes.`,
          html: `<p>Your AutoMatic verification code is <strong>${code}</strong>.</p><p>This code expires in ${Math.ceil(
            expiresInSeconds / 60,
          )} minutes.</p>`,
        }),
      });

      if (!response.ok) {
        throw new Error(`Verification email provider returned HTTP ${response.status}`);
      }
    },
  };
}
