// Operaciones (una por motocarro por día de horario), sus reportes y el histórico general
import { Router } from 'express';
import { query } from '../db/pool.js';
import { asyncHandler, parseId, validarId } from '../middleware/errors.js';
import { reporteDeOperacion } from '../reporte.js';
import { reporteCacheado } from '../vivo.js';

const router = Router();
const reFecha = /^\d{4}-\d{2}-\d{2}$/;
const flotaDe = (req) => (req.query.flota ? parseId(req.query.flota) : null);

function rango(req) {
  const hoy = new Date().toISOString().slice(0, 10);
  const hasta = reFecha.test(req.query.hasta ?? '') ? req.query.hasta : hoy;
  const desde = reFecha.test(req.query.desde ?? '')
    ? req.query.desde
    : new Date(Date.parse(hasta) - 29 * 86400_000).toISOString().slice(0, 10);
  return { desde, hasta };
}

async function operacionesEnRango({ desde, hasta, agenteId, flotaId = null }) {
  const { rows } = await query(
    `SELECT o.*, a.nombre AS agente
       FROM operaciones o JOIN agentes a ON a.id = o.agente_id
      WHERE left(o.clave, 10) BETWEEN $1 AND $2 AND ($3::int IS NULL OR o.agente_id = $3)
        AND ($4::int IS NULL OR a.flota_id = $4)
      ORDER BY o.clave DESC, a.nombre`,
    [desde, hasta, agenteId, flotaId]
  );
  const salida = [];
  for (const o of rows) salida.push({ o, reporte: await reporteCacheado(o) });
  return salida;
}

// GET /api/operaciones?agente=&desde=&hasta=
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const agenteId = req.query.agente ? parseId(req.query.agente) : null;
    if (req.query.agente && !agenteId) return res.status(400).json({ error: 'Motocarro no válido' });
    const ops = await operacionesEnRango({ ...rango(req), agenteId, flotaId: flotaDe(req) });
    res.json(
      ops.map(({ o, reporte }) => ({
        id: o.id,
        agenteId: o.agente_id,
        agente: o.agente,
        clave: o.clave,
        estado: o.estado,
        inicio: o.inicio_programado,
        fin: o.fin_programado,
        totales: reporte?.totales ?? null,
        redes: reporte?.porRed?.map((r) => ({ nombre: r.nombre, tipo: r.tipo, tiempoMs: r.tiempoMs, pct: r.pct })) ?? [],
      }))
    );
  })
);

// GET /api/operaciones/resumen?desde=&hasta= → histórico general de la flota
router.get(
  '/resumen',
  asyncHandler(async (req, res) => {
    const r = rango(req);
    const ops = await operacionesEnRango({ ...r, agenteId: null, flotaId: flotaDe(req) });
    const vacio = () => ({
      operaciones: 0,
      duracionMs: 0,
      principalMs: 0,
      redundanteMs: 0,
      sinConexionMs: 0,
      sinDatosMs: 0,
      failovers: 0,
      cortes: 0,
      bytesTotal: 0,
      bytesRedundantes: 0,
      conmutaciones: [],
    });
    const sumar = (acc, t) => {
      acc.operaciones += 1;
      for (const k of ['duracionMs', 'principalMs', 'redundanteMs', 'sinConexionMs', 'sinDatosMs', 'failovers', 'cortes', 'bytesTotal', 'bytesRedundantes']) {
        acc[k] += t[k] ?? 0;
      }
    };
    const total = vacio();
    const porDia = new Map();
    const porAgente = new Map();
    const porRed = new Map();
    for (const { o, reporte } of ops) {
      if (!reporte) continue;
      const t = reporte.totales;
      sumar(total, t);
      const dia = o.clave.slice(0, 10);
      if (!porDia.has(dia)) porDia.set(dia, { clave: dia, ...vacio() });
      sumar(porDia.get(dia), t);
      if (!porAgente.has(o.agente_id)) porAgente.set(o.agente_id, { id: o.agente_id, nombre: o.agente, ...vacio() });
      const pa = porAgente.get(o.agente_id);
      sumar(pa, t);
      for (const c of reporte.cambios.filter((x) => x.tipo === 'failover')) {
        pa.conmutaciones.push(c.conmutacionMs);
        total.conmutaciones.push(c.conmutacionMs);
      }
      for (const red of reporte.porRed) {
        if (!porRed.has(red.nombre)) porRed.set(red.nombre, { nombre: red.nombre, tipo: red.tipo, tiempoMs: 0, bytes: 0 });
        porRed.get(red.nombre).tiempoMs += red.tiempoMs;
        porRed.get(red.nombre).bytes += red.bytes;
      }
    }
    const fin = (x) => {
      const medido = x.duracionMs - x.sinDatosMs;
      const { conmutaciones, ...resto } = x;
      return {
        ...resto,
        pctPrincipal: x.duracionMs ? Math.round((x.principalMs / x.duracionMs) * 1000) / 10 : null,
        disponibilidad: medido > 0 ? Math.round(((x.principalMs + x.redundanteMs) / medido) * 1000) / 10 : null,
        conmutacionPromMs: conmutaciones.length
          ? Math.round(conmutaciones.reduce((a, b) => a + b, 0) / conmutaciones.length)
          : null,
      };
    };
    res.json({
      ...r,
      totales: fin(total),
      porDia: [...porDia.values()].sort((a, b) => a.clave.localeCompare(b.clave)).map(fin),
      porAgente: [...porAgente.values()].map(fin).sort((a, b) => b.failovers - a.failovers || a.nombre.localeCompare(b.nombre)),
      porRed: [...porRed.values()].sort((a, b) => b.tiempoMs - a.tiempoMs),
    });
  })
);

// GET /api/operaciones/:id → reporte completo
router.get(
  '/:id',
  validarId(),
  asyncHandler(async (req, res) => {
    const r = await reporteDeOperacion(req.params.id);
    if (!r) return res.status(404).json({ error: 'Operación no encontrada' });
    const { rows } = await query('SELECT id, nombre FROM agentes WHERE id = $1', [r.op.agente_id]);
    const { reporte: _guardado, ...op } = r.op;
    res.json({ operacion: op, agente: rows[0], reporte: r.reporte });
  })
);

// GET /api/operaciones/:id/muestras.csv → muestras crudas
router.get(
  '/:id/muestras.csv',
  validarId(),
  asyncHandler(async (req, res) => {
    const { rows: op } = await query(
      'SELECT o.clave, a.nombre FROM operaciones o JOIN agentes a ON a.id = o.agente_id WHERE o.id = $1',
      [req.params.id]
    );
    if (!op[0]) return res.status(404).json({ error: 'Operación no encontrada' });
    const { rows } = await query(
      `SELECT m.ts, m.ok, m.latencia_ms, m.bytes_enviados, m.bytes_recibidos, m.ip, m.asn, r.nombre AS red, r.tipo, m.error
         FROM muestras m LEFT JOIN redes r ON r.asn = m.asn
        WHERE m.operacion_id = $1 ORDER BY m.ts`,
      [req.params.id]
    );
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lineas = [
      'fecha,resultado,latencia_ms,bytes_enviados,bytes_recibidos,ip,asn,red,tipo_red,error',
      ...rows.map((m) =>
        [m.ts.toISOString(), m.ok ? 'OK' : 'ERROR', m.latencia_ms, m.bytes_enviados, m.bytes_recibidos, m.ip, m.asn, m.red, m.tipo, m.error]
          .map(esc)
          .join(',')
      ),
    ];
    const nombre = `${op[0].nombre}_${op[0].clave}`.replace(/[^\w-]+/g, '_');
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="muestras_${nombre}.csv"`,
    });
    res.send('﻿' + lineas.join('\n'));
  })
);

export default router;
