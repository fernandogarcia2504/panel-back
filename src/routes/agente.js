// API que usan los agentes (la PC de cada motocarro). Autenticación: Authorization: Bearer <token>.
import crypto from 'node:crypto';
import net from 'node:net';
import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { query, withTransaction } from '../db/pool.js';
import { requireAgente } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errors.js';
import { configDeAgente } from '../ajustes.js';
import { describirRed, redesPorAsn, registrarRed, resolutor } from '../redes.js';
import { ipCliente } from '../salida.js';
import { ventanaDeClave } from '../horario.js';

const router = Router();
router.use(requireAgente);
router.use(
  rateLimit({
    windowMs: 60_000,
    limit: 240,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `agente-${req.agente.id}`,
    message: { error: 'Demasiadas peticiones de este agente' },
  })
);

const MAX_MUESTRAS = 1000;
const MAX_EVENTOS = 100;
const TIPOS_EVENTO = ['arranque', 'inicio_operacion', 'fin_operacion', 'velocidad', 'aviso'];
const reClave = /^\d{4}-\d{2}-\d{2}T\d{4}$/;
const reUid = /^[\w-]{8,36}$/;
const coloDe = (req) => (req.headers['cf-ray'] ?? '').split('-')[1] || null;

const versionConfig = (c) => crypto.createHash('sha1').update(JSON.stringify(c)).digest('hex').slice(0, 12);

// GET /api/agente/config
router.get(
  '/config',
  asyncHandler(async (req, res) => {
    const config = await configDeAgente(req.agente);
    res.set('Cache-Control', 'no-store');
    res.json({ agente: req.agente.nombre, config, version: versionConfig(config), servidor: new Date().toISOString() });
  })
);

function fechaValida(v) {
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  const ahora = Date.now();
  if (t < ahora - 45 * 86400_000 || t > ahora + 86400_000) return null;
  return new Date(t);
}
const entero = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : 0);

function limpiarMuestra(m) {
  if (!m || typeof m !== 'object' || !reUid.test(m.u ?? '') || !reClave.test(m.op ?? '')) return null;
  const ts = fechaValida(m.ts);
  if (!ts) return null;
  const ok = m.ok === true;
  const ip = typeof m.ip === 'string' && net.isIP(m.ip) ? m.ip : null;
  return {
    uid: m.u,
    op: m.op,
    ts,
    ok,
    lat: ok && typeof m.lat === 'number' && m.lat >= 0 && m.lat < 600_000 ? m.lat : null,
    be: entero(m.be, 50_000_000),
    br: entero(m.br, 50_000_000),
    ip: ok ? ip : null,
    err: !ok && typeof m.err === 'string' ? m.err.slice(0, 120) : null,
  };
}

function limpiarEvento(e) {
  if (!e || typeof e !== 'object' || !reUid.test(e.u ?? '') || !TIPOS_EVENTO.includes(e.tipo)) return null;
  const ts = fechaValida(e.ts);
  if (!ts) return null;
  let datos = e.datos && typeof e.datos === 'object' ? e.datos : null;
  if (datos && JSON.stringify(datos).length > 4000) datos = { truncado: true };
  return { uid: e.u, op: reClave.test(e.op ?? '') ? e.op : null, ts, tipo: e.tipo, datos };
}

// Crea (si no existen) las operaciones citadas en el lote y devuelve clave → id
async function operacionesDelLote(db, agente, claves, ventanas) {
  if (!claves.size) return new Map();
  const config = await configDeAgente(agente);
  const filas = [];
  for (const clave of claves) {
    const v = ventanas?.[clave];
    const ini = fechaValida(v?.inicio);
    const fin = fechaValida(v?.fin);
    let inicio = ini;
    let finP = fin;
    if (!ini || !fin || fin <= ini) {
      const w = ventanaDeClave(config.horario, clave);
      inicio = w.inicio;
      finP = w.fin;
    }
    const intervalo = entero(v?.intervaloMs, 3_600_000) || config.medicion.intervaloSeg * 1000;
    filas.push([clave, inicio, finP, intervalo]);
  }
  await db.query(
    `INSERT INTO operaciones (agente_id, clave, inicio_programado, fin_programado, intervalo_ms)
     SELECT $1, * FROM unnest($2::text[], $3::timestamptz[], $4::timestamptz[], $5::int[])
     ON CONFLICT (agente_id, clave) DO NOTHING`,
    [agente.id, filas.map((f) => f[0]), filas.map((f) => f[1]), filas.map((f) => f[2]), filas.map((f) => f[3])]
  );
  const { rows } = await db.query('SELECT id, clave, estado FROM operaciones WHERE agente_id = $1 AND clave = ANY($2)', [
    agente.id,
    [...claves],
  ]);
  return new Map(rows.map((r) => [r.clave, r]));
}

/**
 * POST /api/agente/sonda
 * Es a la vez la medición (el agente cronometra esta petición) y el envío de lo medido antes:
 * { seq, enviada, version, so, operacion: {clave, inicio, fin, intervaloMs} | null,
 *   ventanas: { clave: {inicio, fin, intervaloMs} }, muestras: [...], eventos: [...], relleno }
 * Responde con la salida a internet con la que llegó esta petición y los uid recibidos.
 */
router.post(
  '/sonda',
  asyncHandler(async (req, res) => {
    const t0 = process.hrtime.bigint();
    const agente = req.agente;
    const b = req.body ?? {};

    // 1) Salida a internet de ESTA petición (proveedor desde caché; si la IP es nueva se resuelve en segundo plano)
    const ip = ipCliente(req);
    const info = resolutor.enCache(ip);
    if (info) await registrarRed(info);
    const redes = await redesPorAsn();
    const red = describirRed(info?.asn, ip, redes);

    // 2) Lo medido antes (cola del agente)
    const muestras = (Array.isArray(b.muestras) ? b.muestras.slice(0, MAX_MUESTRAS) : []).map(limpiarMuestra);
    const eventos = (Array.isArray(b.eventos) ? b.eventos.slice(0, MAX_EVENTOS) : []).map(limpiarEvento);
    const ackMuestras = (Array.isArray(b.muestras) ? b.muestras.slice(0, MAX_MUESTRAS) : [])
      .map((m) => m?.u)
      .filter((u) => typeof u === 'string');
    const ackEventos = (Array.isArray(b.eventos) ? b.eventos.slice(0, MAX_EVENTOS) : [])
      .map((e) => e?.u)
      .filter((u) => typeof u === 'string');
    const mOk = muestras.filter(Boolean);
    const eOk = eventos.filter(Boolean);

    const enOp = b.operacion && reClave.test(b.operacion.clave ?? '') ? b.operacion : null;

    await withTransaction(async (db) => {
      const claves = new Set([...mOk.map((m) => m.op), ...eOk.filter((e) => e.op).map((e) => e.op)]);
      if (enOp) claves.add(enOp.clave);
      const ventanas = { ...(b.ventanas ?? {}), ...(enOp ? { [enOp.clave]: enOp } : {}) };
      const ops = await operacionesDelLote(db, agente, claves, ventanas);

      if (mOk.length) {
        const r = await db.query(
          `INSERT INTO muestras (agente_id, operacion_id, uid, ts, ok, latencia_ms, bytes_enviados, bytes_recibidos, ip, asn, error)
           SELECT $1, * FROM unnest($2::int[], $3::text[], $4::timestamptz[], $5::bool[], $6::real[], $7::int[], $8::int[],
                                    $9::text[], $10::int[], $11::text[])
           ON CONFLICT (agente_id, uid) DO NOTHING
           RETURNING operacion_id`,
          [
            agente.id,
            mOk.map((m) => ops.get(m.op).id),
            mOk.map((m) => m.uid),
            mOk.map((m) => m.ts),
            mOk.map((m) => m.ok),
            mOk.map((m) => m.lat),
            mOk.map((m) => m.be),
            mOk.map((m) => m.br),
            mOk.map((m) => m.ip),
            mOk.map((m) => (m.ip ? (resolutor.enCache(m.ip)?.asn ?? null) : null)),
            mOk.map((m) => m.err),
          ]
        );
        // Datos tarde en una operación ya cerrada → su reporte se recalcula
        const tocadas = [...new Set(r.rows.map((x) => x.operacion_id))];
        if (tocadas.length) {
          await db.query(
            `UPDATE operaciones SET reporte_obsoleto = TRUE WHERE id = ANY($1) AND estado = 'cerrada'`,
            [tocadas]
          );
        }
      }

      if (eOk.length) {
        await db.query(
          `INSERT INTO eventos (agente_id, operacion_id, uid, ts, tipo, datos)
           SELECT $1, * FROM unnest($2::int[], $3::text[], $4::timestamptz[], $5::text[], $6::jsonb[])
           ON CONFLICT (agente_id, uid) DO NOTHING`,
          [
            agente.id,
            eOk.map((e) => (e.op ? ops.get(e.op)?.id ?? null : null)),
            eOk.map((e) => e.uid),
            eOk.map((e) => e.ts),
            eOk.map((e) => e.tipo),
            eOk.map((e) => (e.datos ? JSON.stringify(e.datos) : null)),
          ]
        );
        for (const e of eOk.filter((x) => x.tipo === 'fin_operacion' && x.op && ops.has(x.op))) {
          await db.query('UPDATE operaciones SET fin_reportado = $2, reporte_obsoleto = TRUE WHERE id = $1', [
            ops.get(e.op).id,
            e.ts,
          ]);
        }
      }

      // 3) Estado en vivo del agente
      // relojPc = hora de la PC sin corregir (el agente corrige sus marcas de tiempo con la hora de la central)
      const enviada = Date.parse(b.relojPc ?? b.enviada);
      const desfase = Number.isFinite(enviada) ? Math.round(enviada - Date.now()) : null;
      const asnNuevo = info?.asn ?? null;
      await db.query(
        `UPDATE agentes SET
           ultima_vez = now(), ultima_ip = $2::varchar, ultima_colo = $3,
           -- (en un UPDATE, las columnas a la derecha tienen el valor anterior)
           red_desde = CASE WHEN $4::int IS NOT NULL AND ultima_asn IS DISTINCT FROM $4::int THEN now()
                            ELSE COALESCE(red_desde, now()) END,
           red_pendiente = CASE WHEN $4::int IS NOT NULL THEN FALSE
                                WHEN ultima_ip IS DISTINCT FROM $2::varchar THEN TRUE ELSE red_pendiente END,
           ultima_asn = COALESCE($4::int, ultima_asn),
           en_operacion = $5, operacion_clave = $6, version_agente = $7, so = $8,
           desfase_ms = $9, intervalo_ms = $10
         WHERE id = $1`,
        [
          agente.id,
          ip,
          coloDe(req),
          asnNuevo,
          !!enOp,
          enOp?.clave ?? null,
          typeof b.version === 'string' ? b.version.slice(0, 20) : null,
          typeof b.so === 'string' ? b.so.slice(0, 60) : null,
          desfase != null && Math.abs(desfase) < 2_000_000_000 ? desfase : null,
          entero(enOp?.intervaloMs, 3_600_000) || null,
        ]
      );
    });

    const config = await configDeAgente(agente);
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      seq: Number.isInteger(b.seq) ? b.seq : null,
      salida: { ip, asn: info?.asn ?? null, org: info?.org ?? null, red: red.nombre, tipo: red.tipo, colo: coloDe(req) },
      ack: { muestras: ackMuestras, eventos: ackEventos },
      rechazadas: muestras.filter((m) => !m).length + eventos.filter((e) => !e).length,
      configVersion: versionConfig(config),
      servidorMs: Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10,
    });
  })
);

// ---------- Prueba de velocidad contra la central (funciona con la lista blanca del Peplink) ----------
const MAX_VEL = 8 * 1024 * 1024;
const BLOQUE = crypto.randomBytes(1024 * 1024);

router.get('/descarga', (req, res) => {
  const n = Math.min(MAX_VEL, Math.max(0, Number.parseInt(req.query.bytes, 10) || 0));
  res.set({
    'Cache-Control': 'no-store, no-transform',
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(n),
  });
  if (!n) return res.end();
  let enviados = 0;
  const escribir = () => {
    while (enviados < n) {
      if (res.destroyed) return;
      const trozo = Math.min(BLOQUE.length, n - enviados);
      enviados += trozo;
      if (!res.write(BLOQUE.subarray(0, trozo))) return void res.once('drain', escribir);
    }
    res.end();
  };
  escribir();
});

router.post('/subida', express.raw({ type: 'application/octet-stream', limit: MAX_VEL + 1024 }), (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, bytes: Buffer.isBuffer(req.body) ? req.body.length : 0 });
});

export default router;
