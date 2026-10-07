export type UserRole = 'user' | 'admin';

export type UserStatus = 'active' | 'disabled';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
}

export interface AuthCredentials {
  email: string;
  password: string;
}

export interface RegisterCredentials extends AuthCredentials {
  verificationCode: string;
}

export interface RegistrationVerificationResponse {
  expiresInSeconds: number;
  resendAfterSeconds: number;
  testCode?: string;
}

interface AuthResponse {
  accessToken: string;
  user: AuthUser;
}

interface MeResponse {
  user: AuthUser;
}

interface ErrorResponse {
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
  };
}

export class AuthApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'AuthApiError';
  }
}

let accessToken: string | null = null;
let refreshPromise: Promise<AuthResponse> | null = null;
let sessionGeneration = 0;

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.ok) {
    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  let payload: ErrorResponse | null = null;
  try {
    payload = (await response.json()) as ErrorResponse;
  } catch {
    // 非 JSON 错误仍转换为统一错误，避免调用方依赖 fetch 的解析异常。
  }

  throw new AuthApiError(
    response.status,
    payload?.error?.code ?? 'REQUEST_FAILED',
    payload?.error?.message ?? `Request failed with status ${response.status}`,
    payload?.error?.requestId,
  );
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');

  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'include',
  });

  return parseResponse<T>(response);
}

function applySession(session: AuthResponse, expectedGeneration = sessionGeneration): AuthUser {
  if (expectedGeneration !== sessionGeneration) {
    throw new AuthApiError(401, 'SESSION_INVALIDATED', 'The local session was invalidated');
  }

  accessToken = session.accessToken;
  return session.user;
}

async function createSession(
  path: string,
  credentials: AuthCredentials | RegisterCredentials,
): Promise<AuthUser> {
  const generation = ++sessionGeneration;
  accessToken = null;
  const session = await request<AuthResponse>(path, {
    method: 'POST',
    body: JSON.stringify(credentials),
  });

  return applySession(session, generation);
}

function refreshSession(): Promise<AuthResponse> {
  if (!refreshPromise) {
    const generation = sessionGeneration;
    const pending = request<AuthResponse>('/api/auth/refresh', { method: 'POST' })
      .then((session) => {
        applySession(session, generation);
        return session;
      })
      .catch((error: unknown) => {
        if (generation === sessionGeneration) {
          accessToken = null;
        }
        throw error;
      })
      .finally(() => {
        if (refreshPromise === pending) {
          refreshPromise = null;
        }
      });
    refreshPromise = pending;
  }

  return refreshPromise;
}

/**
 * 请求需要 JWT 的接口。Access Token 只存在于当前模块内；过期时所有并发请求
 * 共用一次 Refresh 请求，并且每个原请求最多重试一次。
 */
export async function authenticatedRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const generation = sessionGeneration;
  const verifySession = () => {
    if (generation !== sessionGeneration) {
      throw new AuthApiError(401, 'SESSION_INVALIDATED', 'The local session was invalidated');
    }
    init.signal?.throwIfAborted();
  };
  if (!accessToken) {
    await refreshSession();
  }

  const send = () => {
    verifySession();
    const headers = new Headers(init.headers);
    if (accessToken) {
      headers.set('authorization', `Bearer ${accessToken}`);
    }
    return request<T>(path, { ...init, headers });
  };

  const tokenUsed = accessToken;
  try {
    return await send();
  } catch (error) {
    verifySession();
    if (!(error instanceof AuthApiError) || error.status !== 401) {
      throw error;
    }

    // 其他并发请求可能已经刷新成功；这种情况下直接使用新 Token 重试即可。
    if (accessToken === tokenUsed) {
      await refreshSession();
    }
    return send();
  }
}

export async function bootstrap(): Promise<AuthUser | null> {
  try {
    const session = await refreshSession();
    return session.user;
  } catch (error) {
    // 只有后端明确判定 Refresh Token 无效时才进入游客态。网络故障、网关
    // 拒绝或服务端异常必须交给启动页展示，否则会把“服务不可用”伪装成退出登录。
    if (
      error instanceof AuthApiError &&
      error.status === 401 &&
      error.code === 'INVALID_REFRESH_TOKEN'
    ) {
      return null;
    }

    throw error;
  }
}

export function login(credentials: AuthCredentials): Promise<AuthUser> {
  return createSession('/api/auth/login', credentials);
}

export function requestRegistrationVerificationCode(
  email: string,
): Promise<RegistrationVerificationResponse> {
  return request<RegistrationVerificationResponse>('/api/auth/register/verification-code', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export function register(credentials: RegisterCredentials): Promise<AuthUser> {
  return createSession('/api/auth/register', credentials);
}

export async function getCurrentUser(): Promise<AuthUser> {
  const response = await authenticatedRequest<MeResponse>('/api/auth/me');
  return response.user;
}

export async function logout(): Promise<void> {
  const generation = ++sessionGeneration;
  accessToken = null;
  const pendingRefresh = refreshPromise;

  try {
    if (pendingRefresh) {
      try {
        // Refresh 响应可能携带新的 Set-Cookie。等它先落定，再用最新 Cookie
        // 登出，避免较晚到达的刷新响应重新建立本地会话。
        await pendingRefresh;
      } catch {
        // 无论刷新成功与否，都继续请求服务端清 Cookie；会话代数已经阻止
        // 这个旧请求把 Access Token 写回内存。
      }
    }

    await request<void>('/api/auth/logout', { method: 'POST' });
  } finally {
    if (generation === sessionGeneration) {
      accessToken = null;
    }
  }
}
