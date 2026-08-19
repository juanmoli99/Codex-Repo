import type { AppConfig } from '../core/config.js';

export function sessionCookieName(config: AppConfig): string {
  return config.app.environment === 'production' ? '__Host-aegis_session' : 'aegis_session';
}
