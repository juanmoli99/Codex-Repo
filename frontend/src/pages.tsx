import { useMemo, useState } from 'react';

import {
  Card,
  DataTable,
  EmptyState,
  Metric,
  ServiceDot,
  StatusBadge,
  Timeline,
  formatDateTime,
  formatMoney,
  pnlTone,
} from './components.js';
import type { BacktestView, OperationsSnapshot, OrderView } from './types.js';

export type OperationAction = (
  action: string,
  options?: {
    readonly critical?: boolean;
    readonly title?: string;
    readonly detail?: string;
    readonly payload?: Readonly<Record<string, unknown>>;
  },
) => void;

interface PageProps {
  readonly data: OperationsSnapshot;
  readonly onAction: OperationAction;
}

function PageHeader({
  eyebrow,
  title,
  detail,
  action,
}: {
  eyebrow: string;
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <p className="page-header__eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{detail}</p>
      </div>
      {action}
    </header>
  );
}

function ServiceGrid({ data }: { data: OperationsSnapshot }) {
  return (
    <div className="service-grid">
      {data.services.map((service) => (
        <div className="service-item" key={service.name}>
          <ServiceDot state={service.state} />
          <div>
            <strong>{service.name}</strong>
            <span>{service.detail}</span>
          </div>
          <small>{service.latencyMs === undefined ? '—' : `${service.latencyMs} ms`}</small>
        </div>
      ))}
    </div>
  );
}

export function DashboardPage({ data, onAction }: PageProps) {
  const criticalAlerts = data.alerts.filter(
    (alert) => ['CRITICAL', 'EMERGENCY'].includes(alert.severity) && alert.state !== 'ACKNOWLEDGED',
  );
  return (
    <>
      <PageHeader
        eyebrow="CONTROL PLANE / OVERVIEW"
        title="Estado operacional"
        detail="Una vista consolidada de capital, riesgo, ejecución y dependencias."
        action={
          <button
            type="button"
            className="button button--danger"
            onClick={() =>
              onAction('kill-switch', {
                critical: true,
                title: 'Activar kill switch',
                detail:
                  'Se bloquearán nuevas entradas y el scheduler. Las salidas seguras seguirán disponibles.',
              })
            }
          >
            Kill switch
          </button>
        }
      />
      <section className="hero-status">
        <div>
          <span className={`mode-beacon mode-beacon--${data.mode.toLowerCase()}`}>{data.mode}</span>
          <div>
            <p>Estado del sistema</p>
            <h2>{data.systemState}</h2>
          </div>
        </div>
        <div className="hero-status__switches">
          <span>
            Trading <strong>{data.tradingEnabled ? 'ON' : 'OFF'}</strong>
          </span>
          <span>
            Entradas <strong>{data.entriesEnabled ? 'ON' : 'OFF'}</strong>
          </span>
          <span>
            Only-close <strong>{data.onlyClose ? 'ON' : 'OFF'}</strong>
          </span>
        </div>
      </section>
      <div className="metric-grid metric-grid--four">
        <Metric label="Cuenta · as of" value={formatDateTime(data.freshness.accountAsOf)} />
        <Metric label="Posiciones · as of" value={formatDateTime(data.freshness.positionsAsOf)} />
        <Metric label="Mercado · as of" value={formatDateTime(data.freshness.marketDataAsOf)} />
        <Metric
          label="Reconciliación · as of"
          value={formatDateTime(data.freshness.reconciliationAsOf)}
        />
      </div>
      <div className="metric-grid metric-grid--five">
        <Metric
          label="Equity"
          value={formatMoney(data.account.equity)}
          detail="Valor consolidado"
        />
        <Metric label="Cash" value={formatMoney(data.account.cash)} detail="Disponible" />
        <Metric label="Buying power" value={formatMoney(data.account.buyingPower)} />
        <Metric
          label="Daily P&L"
          value={formatMoney(data.account.dailyPnl)}
          tone={pnlTone(data.account.dailyPnl)}
        />
        <Metric label="Drawdown" value={`${data.account.drawdownPercent}%`} tone="warning" />
      </div>
      <div className="grid grid--2-1">
        <Card title="Dependencias" eyebrow="HEALTH">
          <ServiceGrid data={data} />
        </Card>
        <Card title="Riesgo utilizado" eyebrow="PORTFOLIO">
          <div
            className="radial-stat"
            style={
              {
                '--progress': `${Math.min(100, Number(data.risk.usedPercent))}%`,
              } as React.CSSProperties
            }
          >
            <div>
              <strong>{data.risk.usedPercent}%</strong>
              <span>de {data.risk.maximumExposurePercent}%</span>
            </div>
          </div>
          <div className="mini-stats">
            <span>
              Exposición <strong>{data.exposurePercent}%</strong>
            </span>
            <span>
              Concentración <strong>{data.risk.concentrationPercent}%</strong>
            </span>
          </div>
        </Card>
      </div>
      <div className="grid grid--2">
        <Card title="Posiciones abiertas" eyebrow={`${data.positions.length} ACTIVAS`}>
          <DataTable
            empty="Sin posiciones abiertas"
            columns={[
              { key: 'symbol', label: 'Símbolo' },
              { key: 'quantity', label: 'Qty', align: 'right' },
              { key: 'value', label: 'Market value', align: 'right' },
              { key: 'pnl', label: 'P&L', align: 'right' },
            ]}
            rows={data.positions.slice(0, 5).map((position) => ({
              id: position.id,
              symbol: <strong>{position.symbol}</strong>,
              quantity: position.quantity,
              value: formatMoney(position.marketValue),
              pnl: (
                <span className={`text-${pnlTone(position.unrealizedPnl)}`}>
                  {formatMoney(position.unrealizedPnl)}
                </span>
              ),
            }))}
          />
        </Card>
        <Card title="Órdenes activas" eyebrow="EXECUTION">
          <DataTable
            empty="Sin órdenes activas"
            columns={[
              { key: 'symbol', label: 'Símbolo' },
              { key: 'side', label: 'Side' },
              { key: 'state', label: 'Estado' },
              { key: 'fill', label: 'Fill', align: 'right' },
            ]}
            rows={data.orders.slice(0, 5).map((order) => ({
              id: order.id,
              symbol: <strong>{order.symbol}</strong>,
              side: order.side.toUpperCase(),
              state: <StatusBadge state={order.state} />,
              fill: `${order.filledQuantity}/${order.quantity}`,
            }))}
          />
        </Card>
      </div>
      <div className="grid grid--2">
        <Card title="Alertas críticas" eyebrow="ACTION REQUIRED">
          {criticalAlerts.length === 0 ? (
            <EmptyState
              title="Sin alertas críticas"
              detail="No hay incidentes críticos pendientes."
            />
          ) : (
            <div className="alert-list">
              {criticalAlerts.slice(0, 5).map((alert) => (
                <div key={alert.id}>
                  <StatusBadge state={alert.severity} />
                  <div>
                    <strong>{alert.title}</strong>
                    <span>
                      {alert.component} · {formatDateTime(alert.occurredAt)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() =>
                      onAction('alert-ack', {
                        critical: true,
                        title: 'Acusar recibo de alerta',
                        detail:
                          'La alerta quedará vinculada a tu identidad y registrada en auditoría.',
                        payload: { alertId: alert.id },
                      })
                    }
                  >
                    ACK
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title="Últimos trades" eyebrow="JOURNAL">
          <DataTable
            empty="Sin trades registrados"
            columns={[
              { key: 'symbol', label: 'Símbolo' },
              { key: 'strategy', label: 'Estrategia' },
              { key: 'pnl', label: 'P&L', align: 'right' },
              { key: 'state', label: 'Estado' },
            ]}
            rows={data.trades.slice(0, 5).map((trade) => ({
              id: trade.id,
              symbol: <strong>{trade.symbol}</strong>,
              strategy: trade.strategy,
              pnl: <span className={`text-${pnlTone(trade.pnl)}`}>{formatMoney(trade.pnl)}</span>,
              state: <StatusBadge state={trade.state} />,
            }))}
          />
        </Card>
      </div>
    </>
  );
}

export function AlpacaPage({ data }: PageProps) {
  const alpaca = data.services.find((service) => service.name.toLowerCase().includes('alpaca'));
  return (
    <>
      <PageHeader
        eyebrow="BROKER"
        title="Alpaca"
        detail="Conexión, cuenta, market clock y actividad reciente del broker."
      />
      <div className="metric-grid metric-grid--four">
        <Metric
          label="Conexión"
          value={alpaca?.state ?? 'DOWN'}
          detail={alpaca?.detail ?? 'Sin telemetría'}
        />
        <Metric label="Modo" value={data.mode} detail="Credenciales aisladas" />
        <Metric label="Cuenta" value={data.account.status} />
        <Metric label="Último contacto" value={formatDateTime(alpaca?.lastSuccessAt)} />
      </div>
      <div className="grid grid--2">
        <Card title="Cuenta consolidada" eyebrow="USD">
          <div className="stacked-metrics">
            <Metric label="Equity" value={formatMoney(data.account.equity)} />
            <Metric label="Cash" value={formatMoney(data.account.cash)} />
            <Metric label="Buying power" value={formatMoney(data.account.buyingPower)} />
          </div>
        </Card>
        <Card title="Sesión de mercado" eyebrow="CLOCK">
          <div className="market-clock">
            <strong>{data.account.marketClock}</strong>
            <span>{data.account.nextMarketEvent}</span>
          </div>
        </Card>
      </div>
      <Card title="Errores recientes" eyebrow="BROKER REQUESTS">
        <DataTable
          empty="Sin errores del broker"
          columns={[
            { key: 'time', label: 'Hora' },
            { key: 'message', label: 'Detalle' },
            { key: 'correlation', label: 'Correlation ID' },
          ]}
          rows={data.logs
            .filter((log) => log.component.toLowerCase().includes('alpaca'))
            .map((log) => ({
              id: log.id,
              time: formatDateTime(log.occurredAt),
              message: log.message,
              correlation: <code>{log.correlationId ?? '—'}</code>,
            }))}
        />
      </Card>
    </>
  );
}

export function WatchlistPage({ data, onAction }: PageProps) {
  const [symbol, setSymbol] = useState('');
  return (
    <>
      <PageHeader
        eyebrow="UNIVERSE"
        title="Watchlist"
        detail="Activos habilitados, calidad de datos y último resultado del scanner."
        action={
          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              const normalized = symbol.trim().toUpperCase();
              if (normalized) {
                onAction('watchlist-add', { payload: { symbol: normalized } });
                setSymbol('');
              }
            }}
          >
            <input
              aria-label="Símbolo"
              value={symbol}
              onChange={(event) => setSymbol(event.target.value)}
              maxLength={10}
              placeholder="AAPL"
            />
            <button className="button button--primary" type="submit">
              Agregar
            </button>
          </form>
        }
      />
      <Card title="Universo configurado" eyebrow={`${data.watchlist.length} SÍMBOLOS`}>
        <DataTable
          empty="Watchlist vacía"
          columns={[
            { key: 'symbol', label: 'Símbolo' },
            { key: 'active', label: 'Estado' },
            { key: 'tradable', label: 'Tradable' },
            { key: 'price', label: 'Último', align: 'right' },
            { key: 'scan', label: 'Scanner' },
            { key: 'block', label: 'Bloqueo' },
            { key: 'actions', label: '' },
          ]}
          rows={data.watchlist.map((item) => ({
            id: item.symbol,
            symbol: <strong>{item.symbol}</strong>,
            active: <StatusBadge state={item.active ? 'ACTIVE' : 'DISABLED'} />,
            tradable: (
              <StatusBadge
                state={item.tradable ? 'UP' : 'BLOCKED'}
                label={item.tradable ? 'Sí' : 'No'}
              />
            ),
            price: item.lastPrice === undefined ? '—' : formatMoney(item.lastPrice),
            scan:
              item.scannerSignal === undefined ? (
                '—'
              ) : (
                <>
                  <strong>{item.scannerSignal}</strong> · {item.scannerScore}
                </>
              ),
            block: item.blockedReason ?? '—',
            actions: (
              <button
                className="link-button"
                type="button"
                onClick={() =>
                  onAction('watchlist-toggle', {
                    payload: { symbol: item.symbol, active: !item.active },
                  })
                }
              >
                {item.active ? 'Desactivar' : 'Activar'}
              </button>
            ),
          }))}
        />
      </Card>
    </>
  );
}

export function ScannerPage({ data, onAction }: PageProps) {
  return (
    <>
      <PageHeader
        eyebrow="DISCOVERY"
        title="Scanner"
        detail="Ejecuciones, ranking de candidatos y descartes explicables."
        action={
          <button
            className="button button--primary"
            type="button"
            onClick={() => onAction('scanner-run')}
          >
            Ejecutar scan
          </button>
        }
      />
      <div className="metric-grid metric-grid--four">
        <Metric label="Estado" value={data.scanner.state} />
        <Metric label="Última ejecución" value={formatDateTime(data.scanner.lastExecutionAt)} />
        <Metric label="Próxima ejecución" value={formatDateTime(data.scanner.nextExecutionAt)} />
        <Metric label="Último resultado" value={data.scanner.history[0]?.status ?? '—'} />
      </div>
      <Card title="Historial" eyebrow="EXECUTIONS">
        <DataTable
          empty="Sin ejecuciones del scanner"
          columns={[
            { key: 'start', label: 'Inicio' },
            { key: 'trigger', label: 'Trigger' },
            { key: 'status', label: 'Estado' },
            { key: 'candidates', label: 'Candidatos', align: 'right' },
            { key: 'rejections', label: 'Rechazos', align: 'right' },
            { key: 'errors', label: 'Errores', align: 'right' },
            { key: 'duration', label: 'Duración', align: 'right' },
          ]}
          rows={data.scanner.history.map((run) => ({
            id: run.id,
            start: formatDateTime(run.startedAt),
            trigger: run.trigger,
            status: <StatusBadge state={run.status} />,
            candidates: run.candidates,
            rejections: run.rejections,
            errors: run.errors,
            duration: run.durationMs === undefined ? '—' : `${run.durationMs} ms`,
          }))}
        />
      </Card>
      <Card title="Rechazos relevantes" eyebrow="EXPLAINABILITY">
        <Timeline events={data.scanner.rejections} />
      </Card>
    </>
  );
}

export function PortfolioPage({ data, onAction }: PageProps) {
  return (
    <>
      <PageHeader
        eyebrow="CAPITAL"
        title="Portfolio"
        detail="Posiciones normalizadas, exposición, protección y reconciliación."
      />
      <div className="metric-grid metric-grid--four">
        <Metric label="Market value" value={formatMoney(data.account.equity)} />
        <Metric label="Exposición" value={`${data.exposurePercent}%`} />
        <Metric
          label="Unrealized P&L"
          value={formatMoney(
            data.positions.reduce((sum, item) => sum + Number(item.unrealizedPnl), 0).toString(),
          )}
        />
        <Metric
          label="Posiciones"
          value={`${data.positions.length}/${data.risk.maximumPositions}`}
        />
      </div>
      <Card title="Posiciones" eyebrow="OPEN">
        <DataTable
          empty="Sin posiciones abiertas"
          columns={[
            { key: 'symbol', label: 'Símbolo' },
            { key: 'qty', label: 'Qty', align: 'right' },
            { key: 'entry', label: 'Entry', align: 'right' },
            { key: 'price', label: 'Actual', align: 'right' },
            { key: 'value', label: 'Value', align: 'right' },
            { key: 'pnl', label: 'P&L', align: 'right' },
            { key: 'exposure', label: 'Exp.', align: 'right' },
            { key: 'strategy', label: 'Estrategia' },
            { key: 'protection', label: 'Stop / target' },
            { key: 'recon', label: 'Recon.' },
            { key: 'action', label: '' },
          ]}
          rows={data.positions.map((position) => ({
            id: position.id,
            symbol: <strong>{position.symbol}</strong>,
            qty: position.quantity,
            entry: formatMoney(position.averageEntryPrice),
            price: formatMoney(position.currentPrice),
            value: formatMoney(position.marketValue),
            pnl: (
              <span className={`text-${pnlTone(position.unrealizedPnl)}`}>
                {formatMoney(position.unrealizedPnl)}
              </span>
            ),
            exposure: `${position.exposurePercent}%`,
            strategy: (
              <span>
                {position.strategy}
                <small className="table-subtext">v{position.strategyVersion}</small>
              </span>
            ),
            protection: `${position.stopPrice ?? '—'} / ${position.targetPrice ?? '—'}`,
            recon: <StatusBadge state={position.reconciliation} />,
            action: (
              <button
                type="button"
                className="link-button link-button--danger"
                onClick={() =>
                  onAction('position-close', {
                    critical: true,
                    title: `Cerrar ${position.symbol}`,
                    detail: `Posición ${position.id} · ${position.quantity} ${position.symbol} · market value ${formatMoney(position.marketValue)}. Se creará una salida controlada sujeta a safety y reconciliación.`,
                    payload: { positionId: position.id },
                  })
                }
              >
                Cerrar
              </button>
            ),
          }))}
        />
      </Card>
    </>
  );
}

export function OrdersPage({ data, onAction }: PageProps) {
  const [filter, setFilter] = useState('ALL');
  const [selected, setSelected] = useState<OrderView | undefined>();
  const orders =
    filter === 'ALL' ? data.orders : data.orders.filter((order) => order.state === filter);
  return (
    <>
      <PageHeader
        eyebrow="EXECUTION"
        title="Órdenes"
        detail="Estado local/broker, fills, cancelaciones, reemplazos y timeline."
      />
      <div className="filter-bar">
        <label>
          Estado
          <select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option>ALL</option>
            {[
              'CREATED',
              'SUBMITTED',
              'ACCEPTED',
              'PARTIALLY_FILLED',
              'FILLED',
              'CANCELED',
              'REJECTED',
              'EXPIRED',
              'UNKNOWN',
            ].map((state) => (
              <option key={state}>{state}</option>
            ))}
          </select>
        </label>
      </div>
      <Card title="Order ledger" eyebrow={`${orders.length} REGISTROS`}>
        <DataTable
          empty="Sin órdenes"
          columns={[
            { key: 'symbol', label: 'Símbolo' },
            { key: 'ids', label: 'IDs' },
            { key: 'side', label: 'Side' },
            { key: 'type', label: 'Tipo' },
            { key: 'state', label: 'Estado' },
            { key: 'fill', label: 'Fill', align: 'right' },
            { key: 'updated', label: 'Actualizada' },
            { key: 'actions', label: '' },
          ]}
          rows={orders.map((order) => ({
            id: order.id,
            symbol: (
              <button className="row-link" type="button" onClick={() => setSelected(order)}>
                {order.symbol}
              </button>
            ),
            ids: (
              <span>
                <code>{order.clientOrderId}</code>
                <small className="table-subtext">{order.brokerOrderId ?? 'broker pendiente'}</small>
              </span>
            ),
            side: order.side.toUpperCase(),
            type: order.type,
            state: <StatusBadge state={order.state} />,
            fill: `${order.filledQuantity}/${order.quantity}`,
            updated: formatDateTime(order.updatedAt),
            actions: ['ACCEPTED', 'PARTIALLY_FILLED'].includes(order.state) ? (
              <button
                className="link-button link-button--danger"
                type="button"
                onClick={() =>
                  onAction('order-cancel', {
                    critical: true,
                    title: `Cancelar ${order.symbol}`,
                    detail: `Orden local ${order.id} · client ID ${order.clientOrderId} · fill ${order.filledQuantity}/${order.quantity}. La cancelación puede competir con un fill y será reconciliada.`,
                    payload: { orderId: order.id },
                  })
                }
              >
                Cancelar
              </button>
            ) : (
              '—'
            ),
          }))}
        />
      </Card>
      {selected === undefined ? null : (
        <Card
          title={`${selected.symbol} · ${selected.state}`}
          eyebrow="ORDER TIMELINE"
          action={
            <button className="link-button" type="button" onClick={() => setSelected(undefined)}>
              Cerrar detalle
            </button>
          }
        >
          <Timeline events={selected.timeline} />
        </Card>
      )}
    </>
  );
}

export function TradesPage({ data }: PageProps) {
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const selected = data.trades.find((trade) => trade.id === selectedId);
  return (
    <>
      <PageHeader
        eyebrow="JOURNAL"
        title="Trades"
        detail="Resultado, riesgo, duración y trazabilidad completa por operación."
      />
      <Card title="Historial" eyebrow={`${data.trades.length} TRADES`}>
        <DataTable
          empty="Sin trades"
          columns={[
            { key: 'symbol', label: 'Símbolo' },
            { key: 'strategy', label: 'Estrategia' },
            { key: 'state', label: 'Estado' },
            { key: 'entry', label: 'Entry / exit', align: 'right' },
            { key: 'qty', label: 'Qty', align: 'right' },
            { key: 'pnl', label: 'P&L', align: 'right' },
            { key: 'risk', label: 'Riesgo' },
            { key: 'duration', label: 'Duración' },
          ]}
          rows={data.trades.map((trade) => ({
            id: trade.id,
            symbol: (
              <button className="row-link" type="button" onClick={() => setSelectedId(trade.id)}>
                {trade.symbol}
              </button>
            ),
            strategy: `${trade.strategy} v${trade.strategyVersion}`,
            state: <StatusBadge state={trade.state} />,
            entry: `${trade.entryPrice} / ${trade.exitPrice ?? '—'}`,
            qty: trade.quantity,
            pnl: (
              <span className={`text-${pnlTone(trade.pnl)}`}>
                {formatMoney(trade.pnl)} · {trade.pnlPercent}%
              </span>
            ),
            risk: trade.risk,
            duration: trade.duration,
          }))}
        />
      </Card>
      {selected === undefined ? null : (
        <div className="grid grid--2">
          <Card title="Tesis y salida" eyebrow={selected.correlationId}>
            <dl className="detail-list">
              <dt>Entrada</dt>
              <dd>{selected.entryReason}</dd>
              <dt>Salida</dt>
              <dd>{selected.exitReason ?? 'Posición abierta'}</dd>
              <dt>Riesgo</dt>
              <dd>{selected.risk}</dd>
            </dl>
          </Card>
          <Card title="Timeline" eyebrow="CORRELATED">
            <Timeline events={selected.timeline} />
          </Card>
        </div>
      )}
    </>
  );
}

export function RiskPage({ data, onAction }: PageProps) {
  const risk = data.risk;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => JSON.stringify(risk.configuration, null, 2));
  const [draftError, setDraftError] = useState<string>();
  return (
    <>
      <PageHeader
        eyebrow="POLICY"
        title="Risk management"
        detail="Límites vigentes, capacidad disponible y rechazos explicables."
        action={
          <button
            className="button button--secondary"
            type="button"
            onClick={() => {
              setDraft(JSON.stringify(risk.configuration, null, 2));
              setDraftError(undefined);
              setEditing((value) => !value);
            }}
          >
            Editar límites
          </button>
        }
      />
      {editing ? (
        <Card title="Nueva versión completa" eyebrow="VALIDATED + IMMUTABLE">
          <p>
            Cambiá obligatoriamente <code>version</code>. La configuración vigente no se edita: se
            crea y activa un snapshot nuevo con checksum.
          </p>
          <textarea
            className="json-editor"
            rows={24}
            spellCheck={false}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          {draftError ? <div className="form-error">{draftError}</div> : null}
          <div className="action-strip">
            <button
              type="button"
              className="button button--primary"
              onClick={() => {
                try {
                  const configuration = JSON.parse(draft) as unknown;
                  setDraftError(undefined);
                  onAction('risk-edit', {
                    critical: true,
                    title: 'Activar nueva configuración de riesgo',
                    detail:
                      'Se validará y versionará de forma transaccional. Las posiciones fuera de límites bloquearán entradas y no se cerrarán silenciosamente.',
                    payload: { riskConfiguration: configuration },
                  });
                } catch {
                  setDraftError('El contenido no es JSON válido.');
                }
              }}
            >
              Validar y activar
            </button>
          </div>
        </Card>
      ) : null}
      <div className="metric-grid metric-grid--four">
        <Metric label="Configuración" value={risk.configurationVersion} />
        <Metric
          label="Riesgo utilizado"
          value={`${risk.usedPercent}%`}
          detail={`${risk.availablePercent}% disponible`}
        />
        <Metric
          label="Daily loss"
          value={`${risk.dailyLossPercent}% / ${risk.dailyLossLimitPercent}%`}
          tone="warning"
        />
        <Metric
          label="Drawdown"
          value={`${risk.drawdownPercent}% / ${risk.maximumDrawdownPercent}%`}
          tone="warning"
        />
      </div>
      <div className="grid grid--2">
        <Card title="Capacidad" eyebrow="LIMITS">
          <div className="limit-list">
            <div>
              <span>Exposición global</span>
              <strong>
                {risk.exposurePercent}% / {risk.maximumExposurePercent}%
              </strong>
              <progress
                value={Number(risk.exposurePercent)}
                max={Number(risk.maximumExposurePercent)}
              />
            </div>
            <div>
              <span>Posiciones</span>
              <strong>
                {risk.positionCount} / {risk.maximumPositions}
              </strong>
              <progress value={risk.positionCount} max={risk.maximumPositions} />
            </div>
            <div>
              <span>Trades diarios</span>
              <strong>
                {risk.dailyTradeCount} / {risk.maximumDailyTrades}
              </strong>
              <progress value={risk.dailyTradeCount} max={risk.maximumDailyTrades} />
            </div>
            <div>
              <span>Concentración</span>
              <strong>{risk.concentrationPercent}%</strong>
              <progress value={Number(risk.concentrationPercent)} max={100} />
            </div>
          </div>
        </Card>
        <Card title="Rechazos recientes" eyebrow="PRE-TRADE">
          <Timeline events={risk.recentRejections} />
        </Card>
      </div>
    </>
  );
}

export function SafetyPage({ data, onAction }: PageProps) {
  return (
    <>
      <PageHeader
        eyebrow="FAIL CLOSED"
        title="Operational safety"
        detail="Bloqueos, circuit breakers y recuperación controlada."
        action={
          <button
            className="button button--danger"
            type="button"
            onClick={() =>
              onAction('kill-switch', {
                critical: true,
                title: 'Activar kill switch',
                detail:
                  'Esta acción bloquea inmediatamente las nuevas operaciones y queda auditada.',
              })
            }
          >
            Kill switch
          </button>
        }
      />
      <section className="safety-banner">
        <div>
          <span>Safety state v{data.safety.version}</span>
          <strong>{data.systemState}</strong>
        </div>
        <div>
          <StatusBadge
            state={data.tradingEnabled ? 'ACTIVE' : 'BLOCKED'}
            label={`Trading ${data.tradingEnabled ? 'ON' : 'OFF'}`}
          />
          <StatusBadge
            state={data.entriesEnabled ? 'ACTIVE' : 'BLOCKED'}
            label={`Entries ${data.entriesEnabled ? 'ON' : 'OFF'}`}
          />
          <StatusBadge
            state={data.onlyClose ? 'WARNING' : 'UP'}
            label={`Only-close ${data.onlyClose ? 'ON' : 'OFF'}`}
          />
        </div>
      </section>
      <div className="action-strip">
        <button
          className="button button--secondary"
          type="button"
          onClick={() =>
            onAction('entries-disable', {
              critical: true,
              title: 'Deshabilitar entradas',
              detail: 'Las posiciones actuales conservarán sus salidas y protecciones.',
            })
          }
        >
          Disable entries
        </button>
        <button
          className="button button--secondary"
          type="button"
          onClick={() =>
            onAction('safety-recover', {
              critical: true,
              title: 'Iniciar recovery',
              detail: 'Sólo se liberarán bloqueos cuyo cooldown y revalidaciones hayan concluido.',
            })
          }
        >
          Recovery controlado
        </button>
      </div>
      <div className="grid grid--2">
        <Card title="Bloqueos activos" eyebrow={`${data.safety.activeBlocks.length} ACTIVE`}>
          <Timeline events={data.safety.activeBlocks} />
        </Card>
        <Card title="Circuit breakers" eyebrow="SCOPED">
          <Timeline events={data.safety.circuitBreakers} />
        </Card>
      </div>
      <Card title="Historial de cambios" eyebrow="IMMUTABLE AUDIT">
        <Timeline events={data.safety.history} />
      </Card>
    </>
  );
}

export function SchedulerPage({ data, onAction }: PageProps) {
  const scheduler = data.scheduler;
  return (
    <>
      <PageHeader
        eyebrow="AUTOMATION"
        title="Scheduler"
        detail="Estado persistido, leases, drift e historial de corridas."
      />
      <div className="action-strip">
        <button
          className="button button--primary"
          type="button"
          onClick={() => onAction('scheduler-start')}
        >
          Start
        </button>
        <button
          className="button button--secondary"
          type="button"
          onClick={() => onAction('scheduler-pause')}
        >
          Pause
        </button>
        <button
          className="button button--secondary"
          type="button"
          onClick={() => onAction('scheduler-resume')}
        >
          Resume
        </button>
        <button
          className="button button--danger-soft"
          type="button"
          onClick={() =>
            onAction('scheduler-stop', {
              critical: true,
              title: 'Detener automatización',
              detail: 'No se iniciarán nuevas corridas hasta una reactivación explícita.',
            })
          }
        >
          Stop
        </button>
      </div>
      <div className="metric-grid metric-grid--four">
        <Metric label="Estado" value={scheduler.state} />
        <Metric label="Intervalo" value={`${Math.round(scheduler.intervalMs / 1_000)} s`} />
        <Metric label="Next execution" value={formatDateTime(scheduler.nextExecutionAt)} />
        <Metric label="Last execution" value={formatDateTime(scheduler.lastExecutionAt)} />
      </div>
      <Card title="Historial" eyebrow="LEASED RUNS">
        <DataTable
          empty="Sin ejecuciones"
          columns={[
            { key: 'start', label: 'Inicio' },
            { key: 'status', label: 'Resultado' },
            { key: 'duration', label: 'Duración', align: 'right' },
            { key: 'candidates', label: 'Candidatos', align: 'right' },
            { key: 'errors', label: 'Errores', align: 'right' },
          ]}
          rows={scheduler.history.map((run) => ({
            id: run.id,
            start: formatDateTime(run.startedAt),
            status: <StatusBadge state={run.status} />,
            duration: run.durationMs === undefined ? '—' : `${run.durationMs} ms`,
            candidates: run.candidates,
            errors: run.errors,
          }))}
        />
      </Card>
    </>
  );
}

function EquityChart({ backtest }: { backtest: BacktestView }) {
  if (backtest.equityCurve.length < 2)
    return (
      <EmptyState title="Curva no disponible" detail="El backtest no produjo suficientes puntos." />
    );
  const values = backtest.equityCurve.map((point) => point.equity);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = maximum - minimum || 1;
  const points = values
    .map(
      (value, index) =>
        `${(index / (values.length - 1)) * 100},${42 - ((value - minimum) / range) * 38}`,
    )
    .join(' ');
  return (
    <svg
      className="equity-chart"
      viewBox="0 0 100 46"
      preserveAspectRatio="none"
      role="img"
      aria-label="Equity curve"
    >
      <defs>
        <linearGradient id="equity-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#40d7b3" stopOpacity=".34" />
          <stop offset="1" stopColor="#40d7b3" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,46 ${points} 100,46`} fill="url(#equity-fill)" />
      <polyline
        points={points}
        fill="none"
        stroke="#61e4c3"
        strokeWidth="1.4"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function BacktestingPage({ data, onAction }: PageProps) {
  const [selectedId, setSelectedId] = useState(data.backtests[0]?.id);
  const selected = data.backtests.find((item) => item.id === selectedId) ?? data.backtests[0];
  const [symbol, setSymbol] = useState('AAPL');
  const [strategy, setStrategy] = useState('trend-following');
  const [from, setFrom] = useState(
    new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10),
  );
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [initialCapital, setInitialCapital] = useState(100_000);
  return (
    <>
      <PageHeader
        eyebrow="RESEARCH"
        title="Backtesting"
        detail="La misma estrategia y risk stack, ejecutados sin lookahead."
        action={
          <button
            className="button button--primary"
            type="button"
            onClick={() =>
              onAction('backtest-run', {
                payload: { symbol, strategy, from, to, initialCapital },
              })
            }
          >
            Ejecutar backtest
          </button>
        }
      />
      <Card title="Nueva simulación" eyebrow="CONFIGURATION">
        <div className="form-grid">
          <label>
            Estrategia
            <select value={strategy} onChange={(event) => setStrategy(event.target.value)}>
              <option value="trend-following">Trend following</option>
              <option value="mean-reversion">Mean reversion</option>
              <option value="volatility-breakout">Volatility breakout</option>
            </select>
          </label>
          <label>
            Símbolo
            <input
              value={symbol}
              onChange={(event) => setSymbol(event.target.value.toUpperCase())}
            />
          </label>
          <label>
            Desde
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label>
            Hasta
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          <label>
            Capital inicial
            <input
              type="number"
              value={initialCapital}
              min="1000"
              max="10000000"
              onChange={(event) => setInitialCapital(Number(event.target.value))}
            />
          </label>
        </div>
      </Card>
      <Card title="Jobs asíncronos" eyebrow="QUEUE">
        <DataTable
          columns={[
            { key: 'job', label: 'Job' },
            { key: 'status', label: 'Estado' },
            { key: 'progress', label: 'Progreso', align: 'right' },
            { key: 'created', label: 'Creado' },
            { key: 'action', label: '' },
          ]}
          rows={data.backtestJobs.map((job) => ({
            id: job.id,
            job: job.id.slice(0, 8),
            status: <StatusBadge state={job.status} />,
            progress: `${job.progress}%`,
            created: formatDateTime(job.createdAt),
            action: ['QUEUED', 'RUNNING', 'CANCELING'].includes(job.status) ? (
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={() => onAction('backtest-cancel', { payload: { backtestJobId: job.id } })}
              >
                Cancelar
              </button>
            ) : (
              (job.error ?? '—')
            ),
          }))}
          empty="Sin jobs de backtesting"
        />
      </Card>
      {selected === undefined ? (
        <EmptyState
          title="Sin backtests"
          detail="Ejecutá una configuración para comparar resultados."
        />
      ) : (
        <>
          <div className="metric-grid metric-grid--five">
            <Metric
              label="Net profit"
              value={formatMoney(selected.netProfit)}
              tone={pnlTone(selected.netProfit)}
            />
            <Metric label="Win rate" value={`${selected.winRate}%`} />
            <Metric label="Profit factor" value={selected.profitFactor} />
            <Metric label="Expectancy" value={formatMoney(selected.expectancy)} />
            <Metric label="Sharpe" value={selected.sharpe} />
          </div>
          <Card
            title={`${selected.strategy} · ${selected.symbol}`}
            eyebrow={`${selected.strategyVersion} · ${selected.range}`}
            action={
              <select
                aria-label="Seleccionar backtest"
                value={selected.id}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {data.backtests.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.strategy} / {item.symbol} / {item.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            }
          >
            <EquityChart backtest={selected} />
            <div className="chart-footer">
              <span>
                Máximo drawdown <strong>{selected.maximumDrawdown}%</strong>
              </span>
              <span>Sin lookahead · next-bar fills</span>
            </div>
          </Card>
        </>
      )}
    </>
  );
}

export function MonitoringPage({ data }: PageProps) {
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState('ALL');
  const logs = useMemo(
    () =>
      data.logs.filter(
        (log) =>
          (level === 'ALL' || log.level === level) &&
          [log.message, log.component, log.correlationId, log.symbol, log.orderId].some((value) =>
            value?.toLowerCase().includes(query.toLowerCase()),
          ),
      ),
    [data.logs, level, query],
  );
  return (
    <>
      <PageHeader
        eyebrow="TELEMETRY"
        title="Monitoreo"
        detail="Health, logs, alertas y eventos correlacionados de safety/reconciliation."
      />
      <Card title="Health matrix" eyebrow="COMPONENTS">
        <ServiceGrid data={data} />
      </Card>
      <Card
        title="Logs relevantes"
        eyebrow={`${logs.length} EVENTS`}
        action={
          <div className="filter-inline">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Correlation, símbolo, order ID…"
            />
            <select value={level} onChange={(event) => setLevel(event.target.value)}>
              <option>ALL</option>
              <option>INFO</option>
              <option>WARN</option>
              <option>ERROR</option>
              <option>FATAL</option>
            </select>
          </div>
        }
      >
        <DataTable
          empty="Sin logs coincidentes"
          columns={[
            { key: 'time', label: 'Hora' },
            { key: 'level', label: 'Nivel' },
            { key: 'component', label: 'Componente' },
            { key: 'message', label: 'Mensaje' },
            { key: 'correlation', label: 'Correlation ID' },
          ]}
          rows={logs.map((log) => ({
            id: log.id,
            time: formatDateTime(log.occurredAt),
            level: (
              <StatusBadge
                state={
                  log.level === 'ERROR' || log.level === 'FATAL'
                    ? 'CRITICAL'
                    : log.level === 'WARN'
                      ? 'WARNING'
                      : 'INFO'
                }
                label={log.level}
              />
            ),
            component: log.component,
            message: log.message,
            correlation: <code>{log.correlationId ?? '—'}</code>,
          }))}
        />
      </Card>
      <div className="grid grid--2">
        <Card title="Safety events" eyebrow="AUDIT">
          <Timeline events={data.safety.history} />
        </Card>
        <Card title="Reconciliation" eyebrow="AUDIT">
          <Timeline events={data.reconciliationHistory} />
        </Card>
      </div>
    </>
  );
}

export const pageRoutes = [
  ['/', 'Dashboard', '⌂'],
  ['/alpaca', 'Alpaca', 'A'],
  ['/watchlist', 'Watchlist', 'W'],
  ['/scanner', 'Scanner', 'S'],
  ['/portfolio', 'Portfolio', 'P'],
  ['/orders', 'Órdenes', 'O'],
  ['/trades', 'Trades', 'T'],
  ['/risk', 'Risk', 'R'],
  ['/safety', 'Safety', '!'],
  ['/scheduler', 'Scheduler', 'C'],
  ['/backtesting', 'Backtesting', 'B'],
  ['/monitoring', 'Monitoreo', 'M'],
] as const;

export function renderPage(path: string, props: PageProps) {
  switch (path) {
    case '/alpaca':
      return <AlpacaPage {...props} />;
    case '/watchlist':
      return <WatchlistPage {...props} />;
    case '/scanner':
      return <ScannerPage {...props} />;
    case '/portfolio':
      return <PortfolioPage {...props} />;
    case '/orders':
      return <OrdersPage {...props} />;
    case '/trades':
      return <TradesPage {...props} />;
    case '/risk':
      return <RiskPage {...props} />;
    case '/safety':
      return <SafetyPage {...props} />;
    case '/scheduler':
      return <SchedulerPage {...props} />;
    case '/backtesting':
      return <BacktestingPage {...props} />;
    case '/monitoring':
      return <MonitoringPage {...props} />;
    default:
      return <DashboardPage {...props} />;
  }
}
