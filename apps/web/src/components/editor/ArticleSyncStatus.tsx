import { useEffect, useState } from 'react';
import {
  flushDocsToServer,
  hasUnsavedDocs,
  recoverDocsConflict,
  retryDocsSync,
  useDocsStore,
} from '../../store/docsStore';

export function ArticleSyncStatus() {
  const status = useDocsStore((state) => state.syncStatus);
  const error = useDocsStore((state) => state.syncError);
  const cacheError = useDocsStore((state) => state.cacheError);
  const [isRetrying, setIsRetrying] = useState(false);

  useEffect(() => {
    const save = () => {
      void flushDocsToServer();
    };
    const online = () => {
      void retryDocsSync();
    };
    const hide = () => {
      if (document.visibilityState === 'hidden') save();
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (hasUnsavedDocs()) {
        save();
        event.preventDefault();
        event.returnValue = '';
      }
    };
    const keyboard = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save();
      }
    };
    window.addEventListener('online', online);
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('keydown', keyboard);
    document.addEventListener('visibilitychange', hide);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('keydown', keyboard);
      document.removeEventListener('visibilitychange', hide);
    };
  }, []);

  const labels = {
    loading: '正在读取文章',
    saved: '已保存',
    pending: '等待保存',
    saving: '保存中…',
    error: '保存失败，重试',
    conflict: '恢复本地草稿',
  };
  return (
    <div
      className="flex max-w-60 flex-col items-end gap-1 text-xs"
      role="status"
      aria-live="polite"
    >
      <button
        className={`rounded px-2 py-1 ${error ? 'text-amber-600' : 'text-[var(--ui-text-secondary)]'}`}
        type="button"
        disabled={isRetrying || status === 'saving' || status === 'loading'}
        title={error ?? '文章会自动保存，也可以按 Ctrl+S 保存'}
        onClick={async () => {
          setIsRetrying(true);
          try {
            if (status === 'conflict') await recoverDocsConflict();
            else await retryDocsSync();
          } finally {
            setIsRetrying(false);
          }
        }}
      >
        {isRetrying ? '正在处理…' : labels[status]}
      </button>
      {error || cacheError ? (
        <span className="text-right text-amber-600">{error ?? cacheError}</span>
      ) : null}
    </div>
  );
}
