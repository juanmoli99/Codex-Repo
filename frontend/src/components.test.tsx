import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DataTable, StatusBadge, formatMoney, pnlTone } from './components.js';
import { pageRoutes } from './pages.js';

describe('operator UI primitives', () => {
  it('renders explicit empty and critical-state semantics', () => {
    expect(renderToStaticMarkup(<StatusBadge state="UNKNOWN" />)).toContain('badge--danger');
    expect(
      renderToStaticMarkup(
        <DataTable columns={[{ key: 'name', label: 'Nombre' }]} rows={[]} empty="Sin órdenes" />,
      ),
    ).toContain('Sin órdenes');
  });

  it('keeps routes unique and formats financial values consistently', () => {
    expect(new Set(pageRoutes.map(([path]) => path)).size).toBe(pageRoutes.length);
    expect(formatMoney('1234.5')).toContain('1.234,50');
    expect(pnlTone('-1')).toBe('negative');
  });
});
