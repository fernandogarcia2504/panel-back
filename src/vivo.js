// Reportes de operaciones en curso con caché corta (el panel refresca cada pocos segundos)
import { reporteDeOperacion } from './reporte.js';

const cache = new Map(); // id → { ts, valor }
const TTL_MS = 30_000;

export async function reporteCacheado(op) {
  if (op.estado === 'cerrada' && op.reporte && !op.reporte_obsoleto) return op.reporte;
  const c = cache.get(op.id);
  if (c && Date.now() - c.ts < TTL_MS) return c.valor;
  const r = await reporteDeOperacion(op.id);
  cache.set(op.id, { ts: Date.now(), valor: r?.reporte ?? null });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return r?.reporte ?? null;
}

export const olvidarReporte = (id) => cache.delete(id);
