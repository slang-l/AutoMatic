import { useEffect, useState } from 'react';
import { AppRoutes } from './routing/AppRoutes';
import { AuthApiError, bootstrap, logout, type AuthUser } from './services/auth-api';
import { clearDocsFromMemory, flushDocsToServer, loadDocsForUser } from './store/docsStore';

interface AuthRecoveryFailure {
  message: string;
  requestId?: string;
}

type AuthState =
  | { status: 'checking'; user: null }
  | { status: 'anonymous'; user: null }
  | { status: 'error'; user: null; failure: AuthRecoveryFailure }
  | { status: 'authenticated'; user: AuthUser };

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ status: 'checking', user: null });
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);

  useEffect(() => {
    let active = true;

    void bootstrap()
      .then(async (user) => {
        if (user) {
          await loadDocsForUser(user.id);
        }
        return user;
      })
      .then((user) => {
        if (!active) return;
        setAuth(user ? { status: 'authenticated', user } : { status: 'anonymous', user: null });
      })
      .catch((error: unknown) => {
        if (active) {
          setAuth({
            status: 'error',
            user: null,
            failure: describeRecoveryFailure(error),
          });
        }
      });

    return () => {
      active = false;
    };
  }, [bootstrapAttempt]);

  const handleAuthenticated = async (user: AuthUser) => {
    await loadDocsForUser(user.id);
    setAuth({ status: 'authenticated', user });
  };

  const handleSignOut = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);

    try {
      if (!(await flushDocsToServer())) return;
      try {
        await logout();
      } catch {
        // The articles are already saved; clear the local session even if the
        // logout endpoint is temporarily unavailable.
      }
      clearDocsFromMemory();
      setAuth({ status: 'anonymous', user: null });
    } finally {
      setIsSigningOut(false);
    }
  };

  if (auth.status === 'checking') {
    return <AuthCheckingScreen />;
  }

  if (auth.status === 'error') {
    return (
      <AuthRecoveryErrorScreen
        failure={auth.failure}
        onRetry={() => {
          setAuth({ status: 'checking', user: null });
          setBootstrapAttempt((attempt) => attempt + 1);
        }}
      />
    );
  }

  return (
    <AppRoutes
      user={auth.status === 'authenticated' ? auth.user : null}
      isSigningOut={isSigningOut}
      onSignOut={handleSignOut}
      onAuthenticated={handleAuthenticated}
    />
  );
}

function AuthRecoveryErrorScreen({
  failure,
  onRetry,
}: {
  failure: AuthRecoveryFailure;
  onRetry: () => void;
}) {
  return (
    <main className="grid min-h-[100dvh] place-items-center bg-[var(--ui-background)] px-5 text-[var(--ui-text)]">
      <section className="w-full max-w-sm rounded-[20px] border border-[var(--ui-border)] bg-[var(--ui-surface)] p-7 text-center shadow-[var(--ui-shadow-card)]">
        <h1 className="m-0 text-lg font-semibold">暂时无法恢复登录状态</h1>
        <p className="mb-0 mt-3 text-sm leading-6 text-[var(--ui-text-secondary)]">
          {failure.message}
        </p>
        {failure.requestId ? (
          <p className="mb-0 mt-2 text-xs text-[var(--ui-text-muted)]">
            请求编号：{failure.requestId}
          </p>
        ) : null}
        <button
          className="ui-pressable mt-6 h-10 rounded-[10px] bg-[var(--ui-primary)] px-5 text-sm font-semibold text-white hover:bg-[var(--ui-primary-hover)]"
          type="button"
          onClick={onRetry}
        >
          重新尝试
        </button>
      </section>
    </main>
  );
}

function describeRecoveryFailure(error: unknown): AuthRecoveryFailure {
  if (error instanceof AuthApiError) {
    if (error.code === 'UNTRUSTED_ORIGIN') {
      return {
        message: '当前访问地址未加入后端允许列表，请检查 CORS_ORIGINS 配置。',
        requestId: error.requestId,
      };
    }

    if (error.code === 'ACCOUNT_DISABLED') {
      return {
        message: '该账号已被停用，请联系管理员。',
        requestId: error.requestId,
      };
    }

    if (error.status >= 500) {
      return {
        message: '暂时无法载入工作区，请稍后重试。',
        requestId: error.requestId,
      };
    }

    return {
      message: '服务器拒绝了会话恢复请求，请稍后重试。',
      requestId: error.requestId,
    };
  }

  if (error instanceof TypeError) {
    return { message: '无法连接服务器，请检查网络后重试。' };
  }

  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return { message: '无法读取本地文档，请检查浏览器的存储权限。' };
  }

  return { message: '发生了未知错误，请稍后重试。' };
}

function AuthCheckingScreen() {
  return (
    <main
      className="grid min-h-[100dvh] place-items-center bg-[var(--ui-background)] text-[var(--ui-text-secondary)]"
      aria-busy="true"
      aria-label="正在恢复登录状态"
    >
      <div className="flex items-center gap-3 text-sm">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--ui-primary-soft)] border-t-[var(--ui-primary)]" />
        正在进入工作台…
      </div>
    </main>
  );
}
