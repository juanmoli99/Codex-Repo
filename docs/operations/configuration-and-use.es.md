# Configuración y uso de AEGIS

AEGIS arranca siempre bloqueado y no promete rentabilidad. El archivo `.env` se admite únicamente
para desarrollo y PAPER local. LIVE rechaza `SECRETS_PROVIDER=env` y la aplicación de producción
rechaza un `.env` local: las credenciales reales se suministran como archivos de secretos montados en
`/run/secrets`.

## 1. Preparación local segura

Requisitos: Node.js 24+, pnpm 11+, PostgreSQL 18+ y una cuenta Alpaca PAPER. Desde la raíz:

```powershell
Copy-Item .env.example .env
pnpm install --frozen-lockfile
```

Genere dos secretos distintos de 48 bytes:

```powershell
$sessionSecret = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
$csrfSecret = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
$sessionSecret
$csrfSecret
```

Genere una contraseña única de 20 caracteres o más en un gestor de contraseñas y conviértala a Argon2:

```powershell
pnpm --filter '@aegis/backend' operator:hash -- 'LA-CONTRASEÑA-LARGA-DEL-GESTOR'
```

Pegue únicamente el resultado `$argon2...` en `OPERATOR_PASSWORD_HASH`. La contraseña en claro es la
que se usa para iniciar sesión; no se guarda en el repositorio. Pegue los dos valores aleatorios en
`SESSION_SIGNING_SECRET` y `CSRF_SIGNING_SECRET`. Nunca reutilice ninguno.

Configure PostgreSQL y cree una base exclusiva. La URL local tiene este formato:

```dotenv
DATABASE_URL=postgresql://aegis:CONTRASEÑA_DB@127.0.0.1:5432/aegis?schema=public
```

La contraseña de la URL debe coincidir con la del rol PostgreSQL. No use la contraseña de ejemplo en
ningún host compartido o de producción.

## 2. Contenido completo de `.env`

### Aplicación y base

| Variable            | Valor local recomendado          | Función                                              |
| ------------------- | -------------------------------- | ---------------------------------------------------- |
| `APP_ENV`           | `development`                    | Entorno. LIVE exige `production`.                    |
| `HOST`              | `127.0.0.1`                      | IP donde escucha la API.                             |
| `PORT`              | `3000`                           | Puerto API.                                          |
| `LOG_LEVEL`         | `info`                           | `fatal`, `error`, `warn`, `info`, `debug` o `trace`. |
| `LOG_DIRECTORY`     | `./logs`                         | Directorio de logs JSON; está ignorado por Git.      |
| `OPERATOR_TIMEZONE` | `America/Argentina/Buenos_Aires` | Zona IANA de presentación.                           |
| `MARKET_TIMEZONE`   | `America/New_York`               | Zona obligatoria del mercado estadounidense.         |
| `BASE_CURRENCY`     | `USD`                            | Moneda obligatoria.                                  |
| `MAX_CLOCK_SKEW_MS` | `1000`                           | Máximo desvío tolerado antes de bloquear.            |
| `DATABASE_URL`      | URL PostgreSQL exclusiva         | Ledger persistente; es obligatoria.                  |

### Broker y datos

| Variable                      | PAPER conectado                    | Explicación                                           |
| ----------------------------- | ---------------------------------- | ----------------------------------------------------- |
| `TRADING_MODE`                | `PAPER`                            | Nunca cambie una instalación en sitio a LIVE.         |
| `BROKER_CONNECTIVITY_ENABLED` | `true`                             | Use `false` solo para iniciar sin llamar a Alpaca.    |
| `ALPACA_PAPER_BASE_URL`       | `https://paper-api.alpaca.markets` | Allowlist de trading PAPER.                           |
| `ALPACA_LIVE_BASE_URL`        | `https://api.alpaca.markets`       | Allowlist LIVE; no se usa en PAPER.                   |
| `ALPACA_DATA_BASE_URL`        | `https://data.alpaca.markets`      | Datos históricos/actuales y WebSocket.                |
| `ALPACA_DATA_FEED`            | `iex`                              | PAPER puede usar IEX; LIVE exige `sip`.               |
| `ALPACA_PAPER_API_KEY`        | API key PAPER                      | Se obtiene en la cuenta PAPER de Alpaca.              |
| `ALPACA_PAPER_API_SECRET`     | Secret PAPER                       | Se muestra al crear/regenerar la clave.               |
| `ALPACA_LIVE_API_KEY`         | vacío                              | No coloque secretos LIVE en `.env`.                   |
| `ALPACA_LIVE_API_SECRET`      | vacío                              | No coloque secretos LIVE en `.env`.                   |
| `ENABLE_LIVE_TRADING`         | `false`                            | Segundo interruptor de compilación/configuración.     |
| `LIVE_ACTIVATION_PHRASE`      | vacío                              | Solo la instalación LIVE aislada usa la frase exacta. |
| `SECRETS_PROVIDER`            | `env`                              | Permitido localmente; LIVE lo rechaza.                |
| `RELEASE_SHA`                 | SHA del commit o `0000000` local   | Identifica el código exacto.                          |
| `DEPLOYMENT_ID`               | `local-paper`                      | Identidad única; no compartir entre PAPER/LIVE.       |

Las credenciales PAPER y LIVE son diferentes. Una clave LIVE no debe probarse en PAPER ni copiarse al
frontend. Si `BROKER_CONNECTIVITY_ENABLED=true`, faltan las credenciales del modo o el endpoint no está
en la allowlist, el proceso falla cerrado.

### Runtime

| Variable                       | Predeterminado | Regla                                       |
| ------------------------------ | -------------: | ------------------------------------------- |
| `MARKET_DATA_TIMEFRAME`        |         `1Min` | `1Min`, `5Min` o `15Min`.                   |
| `MARKET_DATA_MAX_AGE_MS`       |        `90000` | Edad máxima; luego los datos son `STALE`.   |
| `MARKET_DATA_WARMUP_BARS`      |           `60` | Barras válidas antes de habilitar señales.  |
| `SCANNER_MAX_SYMBOLS`          |          `200` | Capacidad máxima por corrida.               |
| `SCANNER_TIMEOUT_MS`           |       `120000` | Timeout total del escáner.                  |
| `SCHEDULER_INTERVAL_MS`        |        `60000` | Intervalo mínimo de ejecución.              |
| `RECONCILIATION_INTERVAL_MS`   |        `60000` | Frecuencia broker↔ledger.                   |
| `WORKER_HEARTBEAT_INTERVAL_MS` |         `5000` | Latido del worker líder.                    |
| `WORKER_DEAD_AFTER_MS`         |        `20000` | Después de este tiempo se considera muerto. |

No aumente capacidad o reduzca tolerancias sin ejecutar de nuevo pruebas, PAPER y evaluación de
readiness. Los límites financieros se versionan desde el panel y no deben esconderse en variables.

### Acceso y alertas

| Variable                      | Requisito                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| `OPERATOR_USERNAME`           | Usuario de 3–128 caracteres; `operator` es válido.                                  |
| `OPERATOR_PASSWORD_HASH`      | Hash Argon2 generado arriba; nunca contraseña en claro.                             |
| `SESSION_SIGNING_SECRET`      | Aleatorio, mínimo 32 caracteres.                                                    |
| `CSRF_SIGNING_SECRET`         | Aleatorio distinto, mínimo 32 caracteres.                                           |
| `SESSION_TTL_MINUTES`         | `30` recomendado.                                                                   |
| `TRUSTED_ORIGINS`             | Orígenes exactos separados por coma, sin comodines. Local: `http://127.0.0.1:5173`. |
| `MAX_PAYLOAD_BYTES`           | `1048576`.                                                                          |
| `LOGIN_MAX_ATTEMPTS`          | `5`.                                                                                |
| `LOGIN_LOCK_MINUTES`          | `15`.                                                                               |
| `TELEGRAM_BOT_TOKEN`          | Token de BotFather; obligatorio en LIVE.                                            |
| `TELEGRAM_CHAT_ID`            | Chat/canal que recibió una prueba real; obligatorio en LIVE.                        |
| `SMTP_URL` / `ALERT_EMAIL_TO` | Reservados para una integración secundaria; déjelos vacíos.                         |
| `OPERATOR_TOTP_SECRET`        | Base32 inscrito en la app autenticadora; obligatorio en LIVE.                       |

En PAPER local Telegram y TOTP pueden quedar vacíos. Para preparar TOTP LIVE, genere al menos 20 bytes
con un gestor compatible, guarde el secreto Base32 en el gestor externo e inscriba el URI `otpauth` en
la aplicación del operador. Confirme dos códigos consecutivos antes del despliegue.

## 3. Inicializar y ejecutar PAPER

Con PostgreSQL arriba y `.env` completo:

```powershell
pnpm db:generate
pnpm db:deploy
pnpm verify
pnpm dev
```

Abra `http://127.0.0.1:5173`, inicie sesión con `OPERATOR_USERNAME` y la contraseña en claro del gestor.
La API queda en `http://127.0.0.1:3000`; `/health/live` confirma proceso vivo y `/health/ready` solo
responde listo cuando broker, mercado, reconciliación, reloj, worker y seguridad tienen evidencia
fresca.

Uso inicial desde el panel:

1. Mantenga PAPER y confirme que la cabecera dice `PAPER`; si dice `LIVE`, no continúe.
2. Agregue únicamente símbolos líquidos y soportados a la watchlist.
3. Revise Alpaca, datos, reconciliación y alertas. `UNKNOWN`, `STALE` o `DOWN` nunca equivalen a listo.
4. Ejecute un backtest y revise muestra, drawdown, trades y curva; no lo interprete como promesa.
5. Recupere safety solo cuando no haya discrepancias; arranque el scheduler después.
6. Habilite entradas únicamente cuando el snapshot no esté viejo y el sistema esté `READY`.
7. Use “deshabilitar entradas” antes de mantenimiento. Kill switch queda reservado para incidentes.

Para detener, primero deshabilite entradas y scheduler en el panel, espere que terminen operaciones en
vuelo y luego pulse `Ctrl+C`. Al reiniciar, AEGIS vuelve a bloquear entradas, recupera estados
persistentes y reconcilia antes de permitir cualquier nueva operación. No reenvía órdenes antiguas.

## 4. Producción y dinero real

LIVE no usa el `.env` anterior. Cree otra instalación, host/proyecto, base, volumen, credenciales Alpaca,
claves de sesión, TOTP, Telegram, TLS, backup y `DEPLOYMENT_ID`. Copie `infra/.env.example` fuera del
repositorio como archivo de coordenadas no secretas. Complete los cuatro digests
`AEGIS_BACKEND_IMAGE`, `AEGIS_FRONTEND_IMAGE`, `AEGIS_WATCHDOG_IMAGE` y `AEGIS_BACKUP_IMAGE`, además
del SHA exacto.

El orquestador debe suministrar estos secretos externos con los nombres declarados:

- contraseña PostgreSQL y `DATABASE_URL` interna;
- API key/secret Alpaca del modo exacto;
- hash de contraseña del operador, signing de sesión y CSRF;
- TOTP del operador y token/chat de Telegram;
- certificado y clave privada TLS;
- credenciales limitadas del bucket de backup.

Docker monta cada secreto solo en los servicios autorizados bajo `/run/secrets`. Los valores no deben
aparecer en `deployment.env`, `docker compose config`, shell history, imagen, Git o logs. Un despliegue
que no disponga de un secret store compatible debe permanecer en PAPER; no se reemplaza por un `.env`
LIVE.

Valide y arranque:

```sh
docker compose --env-file /ruta-protegida/deployment.env -f infra/compose.yaml config
docker compose --env-file /ruta-protegida/deployment.env -f infra/compose.yaml up -d
docker compose --env-file /ruta-protegida/deployment.env -f infra/compose.yaml --profile backup up -d
```

LIVE requiere `APP_ENV=production` (fijado en Compose), `TRADING_MODE=LIVE`,
`BROKER_CONNECTIVITY_ENABLED=true`, `ENABLE_LIVE_TRADING=true`, `ALPACA_DATA_FEED=sip`, secretos LIVE,
Telegram/TOTP válidos y `LIVE_ACTIVATION_PHRASE=I_UNDERSTAND_REAL_MONEY_IS_AT_RISK`. Estas variables
solo permiten evaluar el sistema: no lo activan.

Antes de activar dinero real deben existir en esa instalación: backtest validado, market-data-only,
órdenes PAPER, mínimo 100 fills a lo largo de 28 días, fills parciales y carreras cancel/fill probadas,
cero órdenes `UNKNOWN`, reconciliación fresca sin bloqueos, alertas externas entregadas, backup offsite
restaurado y verificado, watchdog, drills de caída/restart/kill-switch y aprobación de release. El
endpoint de Alpaca debe confirmar que la cuenta destino es LIVE. Cada reinicio revoca la activación.

La secuencia de challenge de cinco minutos, nonce de un solo uso, contraseña, TOTP y frase de riesgo
está en `docs/operations/paper-to-live.md`. No elimine ni falsee un gate fallido. El primer LIVE queda
limitado a USD 100 por orden, USD 500 de capital asignado, USD 25 de pérdida diaria, 3% de drawdown,
tres posiciones, tres órdenes abiertas y cinco trades diarios, con monitoreo manual intensivo durante
diez ruedas.

## 5. Diagnóstico rápido

- `CONFIG_INVALID`: revise el nombre exacto y el rango indicado en el error; no agregue comillas al
  valor de `.env` salvo que deban ser parte del valor.
- `401/403` de Alpaca: regenere la clave del modo correcto; no cambie endpoints para sortear el error.
- `/health/ready` devuelve 503: lea `components` y resuelva la evidencia concreta; no es un fallo del
  healthcheck.
- datos `STALE` o warmup incompleto: mantenga entradas deshabilitadas hasta backfill y barras válidas.
- orden `UNKNOWN`: no la reenvíe; reconcilie por `client_order_id` y resuelva contra el broker.
- panel muestra “Datos stale”: toda acción queda bloqueada; recupere conectividad y espere un snapshot
  nuevo.
- migración fallida: no haga down-migration destructiva; restaure el último artefacto verificado en una
  base nueva y siga el runbook.

Runbooks complementarios: `production-deployment.md`, `backups.md`, `strategy-deployment.md` y
`paper-to-live.md`.
