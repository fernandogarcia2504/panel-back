// Cálculo del reporte de una operación a partir de las muestras crudas.
// Se calcula siempre desde las muestras (fuente única de verdad): si llegan datos tarde o se renombra una red,
// basta con recalcular.
import { query } from './db/pool.js';
import { redesPorAsn } from './redes.js';

const SIN_DATOS = { clave: 'sin_datos', nombre: 'Sin datos (PC apagada o sin agente)', tipo: 'sin_datos' };
const SIN_CONEXION = { clave: 'sin_conexion', nombre: 'Sin conexión', tipo: 'sin_conexion' };
const DESCONOCIDA = { clave: 'desconocida', nombre: 'Red sin identificar', tipo: 'redundante' };

const t = (d) => (d instanceof Date ? d.getTime() : new Date(d).getTime());
const prom = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const percentil = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

function tipoDeCambio(de, a) {
  if (de === 'principal' && a !== 'principal') return 'failover';
  if (de !== 'principal' && a === 'principal') return 'retorno';
  return 'cambio';
}

/**
 * @param op       { inicio_programado, fin_programado, estado, intervalo_ms }
 * @param muestras [{ ts, ok, latencia_ms, bytes_enviados, bytes_recibidos, ip, asn }] ordenadas por ts
 * @param eventos  [{ ts, tipo, datos }]
 * @param redes    Map asn → { nombre, tipo }
 */
export function calcularReporte(op, muestras, eventos, redes, ahora = new Date()) {
  const I = op.intervalo_ms;
  const TOPE = 3 * I; // un hueco mayor entre muestras = no había agente midiendo
  const desde = t(op.inicio_programado);
  const hasta = op.estado === 'cerrada' ? t(op.fin_programado) : Math.min(t(ahora), t(op.fin_programado));

  // Una muestra exitosa cuyo AS aún no se resolvió hereda el de otra muestra con la misma IP
  const asnPorIp = new Map();
  for (const m of muestras) if (m.ok && m.asn && m.ip) asnPorIp.set(m.ip, m.asn);

  const catDe = (m) => {
    if (!m.ok) return SIN_CONEXION;
    const asn = m.asn ?? asnPorIp.get(m.ip);
    if (!asn) return DESCONOCIDA;
    const r = redes.get(asn);
    return { clave: `as${asn}`, asn, nombre: r?.nombre ?? `AS${asn}`, tipo: r?.tipo ?? 'redundante' };
  };

  const ms = muestras
    .map((m) => ({ ...m, t: Math.min(Math.max(t(m.ts), desde), hasta), cat: catDe(m) }))
    .filter((m) => t(m.ts) <= hasta + I);

  // ---------- Línea de tiempo ----------
  const segmentos = [];
  const agregar = (a, b, cat) => {
    if (b <= a) return;
    const ult = segmentos.at(-1);
    if (ult && ult.cat.clave === cat.clave && ult.hasta === a) ult.hasta = b;
    else segmentos.push({ desde: a, hasta: b, cat });
  };
  if (!ms.length) {
    agregar(desde, hasta, SIN_DATOS);
  } else {
    if (ms[0].t - desde > TOPE) agregar(desde, ms[0].t, SIN_DATOS);
    else agregar(desde, ms[0].t, ms[0].cat);
    ms.forEach((m, i) => {
      const sig = i + 1 < ms.length ? ms[i + 1].t : hasta;
      if (sig - m.t <= TOPE) agregar(m.t, sig, m.cat);
      else {
        agregar(m.t, Math.min(m.t + I, hasta), m.cat);
        agregar(Math.min(m.t + I, hasta), sig, SIN_DATOS);
      }
    });
  }

  // ---------- Tiempo y estadísticas por red ----------
  const porRed = new Map();
  const red = (cat) => {
    if (!porRed.has(cat.clave)) {
      porRed.set(cat.clave, { ...cat, tiempoMs: 0, muestras: 0, ok: 0, latencias: [], bytes: 0 });
    }
    return porRed.get(cat.clave);
  };
  for (const s of segmentos) red(s.cat).tiempoMs += s.hasta - s.desde;
  for (const m of ms) {
    const r = red(m.cat);
    r.muestras += 1;
    r.bytes += (m.bytes_enviados ?? 0) + (m.bytes_recibidos ?? 0);
    if (m.ok) {
      r.ok += 1;
      if (m.latencia_ms != null) r.latencias.push(m.latencia_ms);
    }
  }

  // ---------- Cambios de red (failover / retorno) y cortes ----------
  const cambios = [];
  const cortes = [];
  let ultimoOk = null;
  let fallasDesde = null;
  let fallidas = 0;
  for (const m of ms) {
    if (!m.ok) {
      if (fallasDesde === null) fallasDesde = m.t;
      fallidas += 1;
      continue;
    }
    if (fallasDesde !== null) {
      cortes.push({
        desde: fallasDesde,
        hasta: m.t,
        duracionMs: m.t - fallasDesde,
        muestrasFallidas: fallidas,
        antes: ultimoOk?.cat.nombre ?? null,
        despues: m.cat.nombre,
      });
    }
    if (ultimoOk && ultimoOk.cat.clave !== m.cat.clave && m.cat !== DESCONOCIDA && ultimoOk.cat !== DESCONOCIDA) {
      cambios.push({
        hora: m.t,
        tipo: tipoDeCambio(ultimoOk.cat.tipo, m.cat.tipo),
        de: { nombre: ultimoOk.cat.nombre, tipo: ultimoOk.cat.tipo, asn: ultimoOk.cat.asn ?? null },
        a: { nombre: m.cat.nombre, tipo: m.cat.tipo, asn: m.cat.asn ?? null },
        // Tiempo entre la última respuesta por la red anterior y la primera por la nueva.
        // Resolución: ± un intervalo de medición.
        conmutacionMs: m.t - ultimoOk.t,
        muestrasFallidas: fallidas,
      });
    }
    ultimoOk = { cat: m.cat, t: m.t };
    fallasDesde = null;
    fallidas = 0;
  }
  if (fallasDesde !== null) {
    cortes.push({
      desde: fallasDesde,
      hasta,
      duracionMs: hasta - fallasDesde,
      muestrasFallidas: fallidas,
      antes: ultimoOk?.cat.nombre ?? null,
      despues: null,
      abierto: op.estado !== 'cerrada',
    });
  }

  // ---------- Pruebas de velocidad ----------
  const velocidad = eventos
    .filter((e) => e.tipo === 'velocidad')
    .map((e) => {
      const d = e.datos ?? {};
      const asn = d.asn ?? asnPorIp.get(d.ip);
      const r = asn ? redes.get(asn) : null;
      return {
        hora: t(e.ts),
        red: r?.nombre ?? (asn ? `AS${asn}` : d.ip ?? '—'),
        tipo: r?.tipo ?? 'redundante',
        motivo: d.motivo ?? null,
        bajadaMbps: d.bajadaMbps ?? null,
        subidaMbps: d.subidaMbps ?? null,
        latenciaMs: d.latenciaMs ?? null,
        latenciaCargaMs: d.latenciaCargaMs ?? null,
        datosBytes: d.datosBytes ?? 0,
        errores: d.errores ?? [],
      };
    });

  // ---------- Totales ----------
  const total = hasta - desde;
  const tiempoDe = (f) => [...porRed.values()].filter(f).reduce((a, r) => a + r.tiempoMs, 0);
  const sinDatosMs = tiempoDe((r) => r.tipo === 'sin_datos');
  const sinConexionMs = tiempoDe((r) => r.tipo === 'sin_conexion');
  const principalMs = tiempoDe((r) => r.tipo === 'principal');
  const redundanteMs = tiempoDe((r) => r.tipo === 'redundante');
  const medidoMs = total - sinDatosMs;
  const latOk = ms.filter((m) => m.ok && m.latencia_ms != null).map((m) => m.latencia_ms);
  const bytesEnviados = ms.reduce((a, m) => a + (m.bytes_enviados ?? 0), 0);
  const bytesRecibidos = ms.reduce((a, m) => a + (m.bytes_recibidos ?? 0), 0);
  const bytesVelocidad = velocidad.reduce((a, v) => a + v.datosBytes, 0);
  const failovers = cambios.filter((c) => c.tipo === 'failover');
  const pct = (x) => (total > 0 ? r1((x / total) * 100) : null);

  const totales = {
    duracionMs: total,
    medidoMs,
    principalMs,
    redundanteMs,
    sinConexionMs,
    sinDatosMs,
    pctPrincipal: pct(principalMs),
    pctRedundante: pct(redundanteMs),
    pctSinConexion: pct(sinConexionMs),
    pctSinDatos: pct(sinDatosMs),
    // Disponibilidad: tiempo con conexión sobre el tiempo que sí se midió
    disponibilidad: medidoMs > 0 ? r1(((principalMs + redundanteMs) / medidoMs) * 100) : null,
    muestras: ms.length,
    exitosas: ms.filter((m) => m.ok).length,
    pctExito: ms.length ? r1((ms.filter((m) => m.ok).length / ms.length) * 100) : null,
    bytesEnviados,
    bytesRecibidos,
    bytesSondas: bytesEnviados + bytesRecibidos,
    bytesVelocidad,
    bytesTotal: bytesEnviados + bytesRecibidos + bytesVelocidad,
    bytesRedundantes:
      [...porRed.values()].filter((r) => r.tipo === 'redundante').reduce((a, r) => a + r.bytes, 0) +
      velocidad.filter((v) => v.tipo !== 'principal').reduce((a, v) => a + v.datosBytes, 0),
    latenciaProm: r1(prom(latOk)),
    latenciaP50: r1(percentil(latOk, 50)),
    latenciaP95: r1(percentil(latOk, 95)),
    latenciaMax: r1(latOk.length ? Math.max(...latOk) : null),
    failovers: failovers.length,
    retornos: cambios.filter((c) => c.tipo === 'retorno').length,
    cambiosEntreRedundantes: cambios.filter((c) => c.tipo === 'cambio').length,
    conmutacionPromMs: r1(prom(failovers.map((c) => c.conmutacionMs))),
    conmutacionMaxMs: failovers.length ? Math.max(...failovers.map((c) => c.conmutacionMs)) : null,
    cortes: cortes.length,
    corteMasLargoMs: cortes.length ? Math.max(...cortes.map((c) => c.duracionMs)) : null,
    arranquesAgente: eventos.filter((e) => e.tipo === 'arranque').length,
  };

  const iso = (x) => new Date(x).toISOString();
  return {
    generado: new Date().toISOString(),
    periodo: { desde: iso(desde), hasta: iso(hasta), finProgramado: iso(op.fin_programado) },
    intervaloMs: I,
    totales,
    porRed: [...porRed.values()]
      .sort((a, b) => b.tiempoMs - a.tiempoMs)
      .map((r) => ({
        clave: r.clave,
        asn: r.asn ?? null,
        nombre: r.nombre,
        tipo: r.tipo,
        tiempoMs: r.tiempoMs,
        pct: pct(r.tiempoMs),
        muestras: r.muestras,
        ok: r.ok,
        latenciaProm: r1(prom(r.latencias)),
        latenciaP95: r1(percentil(r.latencias, 95)),
        bytes: r.bytes,
      })),
    cambios: cambios.map((c) => ({ ...c, hora: iso(c.hora) })),
    cortes: cortes.map((c) => ({ ...c, desde: iso(c.desde), hasta: iso(c.hasta) })),
    velocidad: velocidad.map((v) => ({ ...v, hora: iso(v.hora) })),
    segmentos: segmentos.map((s) => ({
      desde: iso(s.desde),
      hasta: iso(s.hasta),
      clave: s.cat.clave,
      nombre: s.cat.nombre,
      tipo: s.cat.tipo,
    })),
  };
}

// Carga una operación y devuelve su reporte (usa el guardado si sigue vigente)
export async function reporteDeOperacion(operacionId, { forzar = false } = {}) {
  const { rows } = await query('SELECT * FROM operaciones WHERE id = $1', [operacionId]);
  const op = rows[0];
  if (!op) return null;
  if (op.estado === 'cerrada' && op.reporte && !op.reporte_obsoleto && !forzar) return { op, reporte: op.reporte };

  const [m, e, redes] = await Promise.all([
    query(
      `SELECT ts, ok, latencia_ms, bytes_enviados, bytes_recibidos, ip, asn
         FROM muestras WHERE operacion_id = $1 ORDER BY ts, id`,
      [operacionId]
    ),
    query('SELECT ts, tipo, datos FROM eventos WHERE operacion_id = $1 ORDER BY ts', [operacionId]),
    redesPorAsn(),
  ]);
  const reporte = calcularReporte(op, m.rows, e.rows, redes);
  if (op.estado === 'cerrada') {
    await query('UPDATE operaciones SET reporte = $2, reporte_obsoleto = FALSE WHERE id = $1', [
      operacionId,
      JSON.stringify(reporte),
    ]);
  }
  return { op, reporte };
}
