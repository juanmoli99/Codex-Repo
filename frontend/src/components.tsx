import type { ReactNode } from 'react';

import type { HealthState } from '@aegis/shared';

export function StatusBadge({ state, label }: { state: string; label?: string }) {
  const tone = ['UP', 'READY', 'RUNNING', 'HEALTHY', 'MATCHED', 'SENT', 'FILLED'].includes(state)
    ? 'positive'
    : ['DOWN', 'BLOCKED', 'EMERGENCY', 'FAILED', 'UNKNOWN', 'MISMATCH', 'REJECTED'].includes(state)
      ? 'danger'
      : ['DEGRADED', 'PAUSED', 'STALE', 'WARNING', 'PARTIALLY_FILLED', 'REVIEW'].includes(state)
        ? 'warning'
        : 'neutral';
  return <span className={`badge badge--${tone}`}>{label ?? state.replaceAll('_', ' ')}</span>;
}

export function ServiceDot({ state }: { state: HealthState }) {
  return <span className={`service-dot service-dot--${state.toLowerCase()}`} aria-label={state} />;
}

export function Card({
  title,
  eyebrow,
  action,
  children,
  className = '',
}: {
  title: string;
  eyebrow?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      <header className="card__header">
        <div>
          {eyebrow === undefined ? null : <p className="card__eyebrow">{eyebrow}</p>}
          <h2>{title}</h2>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function Metric({
  label,
  value,
  detail,
  tone = 'default',
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: 'default' | 'positive' | 'negative' | 'warning';
}) {
  return (
    <div className={`metric metric--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail === undefined ? null : <small>{detail}</small>}
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="empty-state">
      <span className="empty-state__mark">○</span>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

export function LoadingState() {
  return (
    <div className="loading-state" aria-live="polite">
      <span className="spinner" />
      Sincronizando el plano de control…
    </div>
  );
}

export function ErrorState({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="error-state" role="alert">
      <div>
        <strong>Backend no disponible</strong>
        <p>{message}</p>
      </div>
      <button className="button button--secondary" type="button" onClick={retry}>
        Reintentar
      </button>
    </div>
  );
}

export function DataTable({
  columns,
  rows,
  empty,
}: {
  columns: readonly { readonly key: string; readonly label: string; readonly align?: 'right' }[];
  rows: readonly (Readonly<Record<string, ReactNode>> & { readonly id: string })[];
  empty: string;
}) {
  if (rows.length === 0)
    return <EmptyState title={empty} detail="No hay registros para los filtros actuales." />;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} className={column.align === 'right' ? 'align-right' : undefined}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={column.align === 'right' ? 'align-right' : undefined}
                >
                  {row[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Timeline({
  events,
}: {
  events: readonly {
    readonly id: string;
    readonly type: string;
    readonly detail: string;
    readonly occurredAt: string;
  }[];
}) {
  if (events.length === 0)
    return (
      <EmptyState title="Sin eventos" detail="La línea de tiempo todavía no contiene actividad." />
    );
  return (
    <ol className="timeline">
      {events.map((event) => (
        <li key={event.id}>
          <span className="timeline__dot" />
          <div>
            <div className="timeline__title">
              <strong>{event.type.replaceAll('_', ' ')}</strong>
              <time>{formatDateTime(event.occurredAt)}</time>
            </div>
            <p>{event.detail}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function ConfirmDialog({
  open,
  title,
  detail,
  phrase,
  busy,
  password,
  totpCode,
  mfaRequired,
  onPasswordChange,
  onTotpChange,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  detail: string;
  phrase: string;
  busy: boolean;
  password: string;
  totpCode: string;
  mfaRequired: boolean;
  onPasswordChange: (value: string) => void;
  onTotpChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <span className="dialog__icon">!</span>
        <h2 id="dialog-title">{title}</h2>
        <p>{detail}</p>
        <p className="dialog__phrase">
          Confirmación requerida: <strong>{phrase}</strong>
        </p>
        <label>
          Volver a ingresar la contraseña del operador
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
            minLength={16}
            required
          />
        </label>
        {mfaRequired ? (
          <label>
            Código MFA de seis dígitos
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={totpCode}
              onChange={(event) => onTotpChange(event.target.value.replace(/\D/g, '').slice(0, 6))}
              pattern="[0-9]{6}"
              required
            />
          </label>
        ) : null}
        <div className="dialog__actions">
          <button
            type="button"
            className="button button--secondary"
            onClick={onCancel}
            disabled={busy}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="button button--danger"
            onClick={onConfirm}
            disabled={busy || password.length < 16 || (mfaRequired && totpCode.length !== 6)}
          >
            {busy ? 'Aplicando…' : phrase}
          </button>
        </div>
      </div>
    </div>
  );
}

export function formatMoney(value: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(amount);
}

export function formatDateTime(value: string | undefined): string {
  if (value === undefined) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('es-AR', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date);
}

export function pnlTone(value: string): 'positive' | 'negative' | 'default' {
  const numeric = Number(value);
  return numeric > 0 ? 'positive' : numeric < 0 ? 'negative' : 'default';
}
