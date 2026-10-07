import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useSearchParams } from 'react-router-dom';
import { articlePath, loginPath, paths, safeReturnTo, workspaceRoutes } from './routes';
import { RouteErrorPage } from './RouteErrorPage';
import { useDocsStore } from '../store/docsStore';
import { AuthPage } from '../components/auth/AuthPage';
import { AppLayout } from '../components/layout/AppLayout';
import type { AuthUser } from '../services/auth-api';
interface AppRoutesProps {
  user: AuthUser | null;
  isSigningOut: boolean;
  onSignOut: () => void | Promise<void>;
  onAuthenticated: (user: AuthUser) => void | Promise<void>;
}
export function AppRoutes({ user, isSigningOut, onSignOut, onAuthenticated }: AppRoutesProps) {
  const protect = (element: ReactNode) => (user ? element : <LoginRedirect />);
  return (
    <Routes>
      <Route path="/" element={<Navigate to={paths.home} replace />} />
      <Route
        path={paths.login}
        element={
          user ? (
            <LoginReturn />
          ) : (
            <AuthPage key="login" mode="login" onAuthenticated={onAuthenticated} />
          )
        }
      />
      <Route
        path={paths.register}
        element={
          user ? (
            <LoginReturn />
          ) : (
            <AuthPage key="register" mode="register" onAuthenticated={onAuthenticated} />
          )
        }
      />
      <Route path={paths.editor} element={protect(<EditorRedirect />)} />
      {workspaceRoutes.map((route) => (
        <Route
          key={route.path}
          path={route.path}
          element={protect(
            user && (
              <AppLayout
                view={route.view}
                panel={route.panel}
                isSigningOut={isSigningOut}
                onSignOut={onSignOut}
                user={user}
              />
            ),
          )}
        />
      ))}
      <Route path="*" element={<RouteErrorPage />} />
    </Routes>
  );
}

function LoginRedirect() {
  const location = useLocation();
  return <Navigate to={loginPath(location.pathname + location.search + location.hash)} replace />;
}
function LoginReturn() {
  const [search] = useSearchParams();
  return <Navigate to={safeReturnTo(search.get('returnTo'))} replace />;
}
function EditorRedirect() {
  const docs = useDocsStore((state) => state.docs);
  const currentId = useDocsStore((state) => state.currentDocId);
  const doc =
    docs.find((doc) => doc.id === currentId && !doc.deletedAt) ??
    docs.find((doc) => !doc.deletedAt);
  return <Navigate to={doc ? articlePath(doc.id) : paths.home} replace />;
}
