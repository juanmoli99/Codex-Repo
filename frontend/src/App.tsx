import { useCallback, useEffect, useRef, useState } from 'react';

import { api, ApiError } from './api.js';
import {
  ConfirmDialog,
  ErrorState,
  LoadingState,
  StatusBadge,
  formatDateTime,
} from './components.js';
import { pageRoutes, renderPage, type OperationAction } from './pages.js';
import type { OperationsSnapshot } from './types.js';

type AuthenticationState = 'CHECKING' | 'AUTHENTICATED' | 'ANONYMOUS';

function currentPath(): string {
  const path = window.location.pathname;
  return pageRoutes.some(([route]) => route === path) ? path : '/';
}

function usePath() {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const update = () => setPath(currentPath());
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  const navigate = (next: string) => {
    window.history.pushState({}, '', next);
    setPath(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  return { path, navigate };
}

function useOperations(active: boolean) {
  const [data, setData] = useState<OperationsSnapshot>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [lastSuccess, setLastSuccess] = useState<Date>();
  const [clock, setClock] = useState(Date.now());
  const inFlight = useRef<AbortController | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!active) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      const snapshot = await api.snapshot(controller.signal);
      setData(snapshot);
      setLastSuccess(new Date());
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No se pudo actualizar el estado');
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = undefined;
        setLoading(false);
      }
    }
  }, [active]);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) void refresh();
    }, 5_000);
    const reconnect = () => void refresh();
    window.addEventListener('online', reconnect);
    document.addEventListener('visibilitychange', reconnect);
    return () => {
      window.clearInterval(interval);
      inFlight.current?.abort();
      window.removeEventListener('online', reconnect);
      document.removeEventListener('visibilitychange', reconnect);
    };
  }, [active, refresh]);

  useEffect(() => {
    const interval = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  const stale = data === undefined || clock - new Date(data.generatedAt).getTime() > 15_000;
  return { data, error, loading, lastSuccess, stale, refresh };
}

function Login({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [username, setUsername] = useState('operator');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <main className="login-shell">
      <div className="login-brand">
        <span className="brand-mark">A</span>
        <span>AEGIS</span>
        <small>TRADING CONTROL PLANE</small>
      </div>
      <form
        className="login-card"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(undefined);
          void api
            .login(username, password)
            .then(onAuthenticated)
            .catch((caught: unknown) =>
              setError(caught instanceof Error ? caught.message : 'Login fallido'),
            )
            .finally(() => setBusy(false));
        }}
      >
        <p className="page-header__eyebrow">OPERATOR ACCESS</p>
        <h1>Ingresar al plano de control</h1>
        <p>Sesión única, cookies seguras y protección CSRF.</p>
        <label>
          Usuario
          <input
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
        </label>
        <label>
          Contraseña
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        {error === undefined ? null : <div className="form-error">{error}</div>}
        <button className="button button--primary button--wide" type="submit" disabled={busy}>
          {busy ? 'Validando…' : 'Iniciar sesión'}
        </button>
      </form>
      <p className="login-footnote">Acceso restringido · toda acción queda auditada</p>
    </main>
  );
}

export default function App() {
  const { path, navigate } = usePath();
  const [authentication, setAuthentication] = useState<AuthenticationState>('CHECKING');
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState<{ tone: 'success' | 'danger'; message: string }>();
  const [pending, setPending] = useState<{
    action: string;
    title: string;
    detail: string;
    payload: Readonly<Record<string, unknown>>;
  }>();
  const [actionBusy, setActionBusy] = useState(false);
  const [reauthenticationPassword, setReauthenticationPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const operations = useOperations(authentication === 'AUTHENTICATED');

  useEffect(() => {
    void api
      .session()
      .then((authenticated) => setAuthentication(authenticated ? 'AUTHENTICATED' : 'ANONYMOUS'))
      .catch(() => setAuthentication('ANONYMOUS'));
  }, []);

  useEffect(() => {
    if (toast === undefined) return;
    const timeout = window.setTimeout(() => setToast(undefined), 4_000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const runAction = useCallback(
    async (action: string, payload: Readonly<Record<string, unknown>> = {}) => {
      setActionBusy(true);
      try {
        await api.action(action, payload);
        setToast({ tone: 'success', message: 'Acción persistida correctamente' });
        setPending(undefined);
        await operations.refresh();
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 401) setAuthentication('ANONYMOUS');
        setToast({
          tone: 'danger',
          message: caught instanceof Error ? caught.message : 'La acción falló',
        });
      } finally {
        setActionBusy(false);
      }
    },
    [operations.refresh],
  );

  const onAction: OperationAction = (action, options) => {
    if (operations.stale) {
      setToast({
        tone: 'danger',
        message: 'Acción bloqueada: el snapshot operativo está desactualizado.',
      });
      return;
    }
    if (options?.critical) {
      setPending({
        action,
        title: options.title ?? 'Confirmar acción crítica',
        detail: options.detail ?? 'Esta operación modifica el estado persistente del sistema.',
        payload: options.payload ?? {},
      });
      setReauthenticationPassword('');
      setTotpCode('');
      return;
    }
    void runAction(action, options?.payload);
  };

  if (authentication === 'CHECKING')
    return (
      <main className="center-screen">
        <LoadingState />
      </main>
    );
  if (authentication === 'ANONYMOUS')
    return <Login onAuthenticated={() => setAuthentication('AUTHENTICATED')} />;

  return (
    <div className={`app-layout ${menuOpen ? 'app-layout--menu-open' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">A</span>
          <div>
            <strong>AEGIS</strong>
            <small>CONTROL PLANE</small>
          </div>
        </div>
        <nav aria-label="Navegación principal">
          {pageRoutes.map(([route, label, icon]) => (
            <button
              key={route}
              type="button"
              className={path === route ? 'nav-item nav-item--active' : 'nav-item'}
              onClick={() => {
                navigate(route);
                setMenuOpen(false);
              }}
            >
              <span>{icon}</span>
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar__footer">
          <div className="operator-avatar">OP</div>
          <div>
            <strong>Operator</strong>
            <span>Sesión protegida</span>
          </div>
          <button
            type="button"
            aria-label="Cerrar sesión"
            onClick={() => void api.logout().finally(() => setAuthentication('ANONYMOUS'))}
          >
            ↪
          </button>
        </div>
      </aside>
      <button
        type="button"
        className="mobile-scrim"
        aria-label="Cerrar menú"
        onClick={() => setMenuOpen(false)}
      />
      <div className="workspace">
        <header className={`topbar topbar--${operations.data?.mode.toLowerCase() ?? 'paper'}`}>
          <button
            type="button"
            className="menu-toggle"
            aria-label="Abrir menú"
            onClick={() => setMenuOpen((value) => !value)}
          >
            ☰
          </button>
          <div className="topbar__mode">
            <span>{operations.data?.mode ?? 'PAPER'}</span>
            <strong>{operations.data?.systemState ?? 'CONNECTING'}</strong>
          </div>
          <div className="topbar__right">
            <span className={operations.stale ? 'connection connection--stale' : 'connection'}>
              <i />
              {operations.stale ? 'Datos stale' : 'Backend conectado'}
            </span>
            <small>
              Última sync{' '}
              {operations.lastSuccess === undefined
                ? '—'
                : formatDateTime(operations.lastSuccess.toISOString())}
            </small>
            <StatusBadge state={operations.data?.account.marketClock ?? 'UNKNOWN'} />
          </div>
        </header>
        <main className="content">
          {operations.loading && operations.data === undefined ? (
            <LoadingState />
          ) : operations.data === undefined ? (
            <ErrorState
              message={operations.error ?? 'Sin datos'}
              retry={() => void operations.refresh()}
            />
          ) : (
            <>
              {operations.error === undefined ? null : (
                <div className="inline-warning">
                  Actualización fallida: {operations.error}. Se muestran los últimos datos válidos.
                </div>
              )}
              {renderPage(path, { data: operations.data, onAction })}
            </>
          )}
        </main>
      </div>
      <ConfirmDialog
        open={pending !== undefined}
        title={pending?.title ?? ''}
        detail={pending?.detail ?? ''}
        phrase="CONFIRMAR"
        busy={actionBusy}
        password={reauthenticationPassword}
        totpCode={totpCode}
        mfaRequired={operations.data?.mode === 'LIVE'}
        onPasswordChange={setReauthenticationPassword}
        onTotpChange={setTotpCode}
        onCancel={() => {
          setPending(undefined);
          setReauthenticationPassword('');
          setTotpCode('');
        }}
        onConfirm={() => {
          if (pending !== undefined)
            void runAction(pending.action, {
              ...pending.payload,
              confirmation: 'CONFIRMAR',
              reauthenticationPassword,
              ...(operations.data?.mode === 'LIVE' ? { totpCode } : {}),
            });
        }}
      />
      {toast === undefined ? null : (
        <div className={`toast toast--${toast.tone}`} role="status">
          {toast.message}
        </div>
      )}
    </div>
  );
}
