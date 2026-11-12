// Consultas de lo sincronizado desde InControl2 para el panel: estado por motocarro, ciclo de datos de la SIM
// y conciliación por hora (consumo real de la SIM vs sondeos del portal).
//
// El motocarro (agente) se enlaza con su router de InControl2 por el número de serie del Peplink capturado en el
// inventario (homologación manual, fase 1).
import { query } from '../db/pool.js';
import { obtenerAjustes } from '../ajustes.js';
import { partesEnZona, zonaAUtc } from '../horario.js';
import { evaluarSim } from './normalizar.js';
import { zonaIc2 } from './sync.js';

const DIA = 86_400_000;
const GB = 1024 ** 3;

// Identificadores que solo ve el administrador (el soporte técnico no tiene acceso al inventario)
const PRIVADOS_WAN = ['imei', 'iccid', 'imsi'];

export async function dispositivosPorAgente() {
  const { rows } = await query(
    `SELECT i.agente_id, d.*
       FROM inventario i
       JOIN ic2_dispositivos d ON upper(d.sn) = upper(i.peplink_sn)
      WHERE i.peplink_sn IS NOT NULL`
  );
  return new Map(rows.map((r) => [r.agente_id, r]));
}

async function wansDe(ids) {
  if (!ids.length) return new Map();
  const { rows } = await query('SELECT * FROM ic2_wan WHERE dispositivo_id = ANY($1) ORDER BY wan_id', [ids]);
  const m = new Map();
  for (const w of rows) {
    if (!m.has(w.dispositivo_id)) m.set(w.dispositivo_id, []);
    m.get(w.dispositivo_id).push(w);
  }
  return m;
}

// ---------------------------------------------------------------------------------------------
// Ciclo de facturación de la SIM
// ---------------------------------------------------------------------------------------------
export function cicloActual(diaCorte = 1, ahora = new Date(), zona = zonaIc2()) {
  const p = partesEnZona(ahora, zona);
  let [y, m] = [p.y, p.m];
  if (p.d < diaCorte) {
    m -= 1;
    if (m < 1) [y, m] = [y - 1, 12];
  }
  const inicio = zonaAUtc(y, m, diaCorte, 0, 0, zona);
  const [y2, m2] = m === 12 ? [y + 1, 1] : [y, m + 1];
  const fin = zonaAUtc(y2, m2, diaCorte, 0, 0, zona);
  return { inicio, fin };
}

async function consumoCelularDesde(ids, desde) {
  if (!ids.length) return new Map();
  const { rows } = await query(
    `SELECT dispositivo_id, COALESCE(sum(bytes_total), 0) AS bytes, max(actualizado) AS actualizado
       FROM ic2_consumo_horario
      WHERE dispositivo_id = ANY($1) AND celular AND hora >= $2
      GROUP BY dispositivo_id`,
    [ids, desde]
  );
  return new Map(rows.map((r) => [r.dispositivo_id, r]));
}

function resumenCiclo(bytes, ciclo, plan, ahora = Date.now()) {
  const totalDias = (ciclo.fin - ciclo.inicio) / DIA;
  const transcurridos = Math.max(1 / 24, (ahora - ciclo.inicio.getTime()) / DIA);
  const ritmo = bytes / transcurridos; // bytes por día
  const proyeccion = Math.round(ritmo * totalDias);
  const planBytes = plan?.gbMensual ? plan.gbMensual * GB : null;
  return {
    inicio: ciclo.inicio,
    fin: ciclo.fin,
    bytes,
    bytesPorDia: Math.round(ritmo),
    proyeccion,
    planBytes,
    pct: planBytes ? Math.round((bytes / planBytes) * 1000) / 10 : null,
    pctProyeccion: planBytes ? Math.round((proyeccion / planBytes) * 1000) / 10 : null,
  };
}

// ---------------------------------------------------------------------------------------------
const limpiarWan = (w, esAdmin) => {
  const sim = evaluarSim({ ...w, habilitada: null });
  const base = {
    wanId: w.wan_id,
    nombre: w.nombre,
    tipo: w.tipo,
    celular: w.celular,
    estado: w.estado,
    activa: w.activa,
    respaldo: w.respaldo,
    standby: w.standby,
    cuotaExcedida: w.cuota_excedida,
    operador: w.operador,
    tecnologia: w.tecnologia,
    senalBarras: w.senal_barras,
    rssi: w.rssi,
    sinr: w.sinr,
    rsrp: w.rsrp,
    rsrq: w.rsrq,
    simActiva: w.sim_activa,
    monitorCuota: w.monitor_cuota,
    simDisponible: w.celular ? sim.disponible : null,
    simMotivo: w.celular ? sim.motivo : null,
    actualizado: w.actualizado,
  };
  if (esAdmin) for (const k of PRIVADOS_WAN) base[k] = w[k];
  return base;
};

function resumenDispositivo(d, wans, esAdmin) {
  const lista = (wans ?? []).map((w) => limpiarWan(w, esAdmin));
  const cel = lista.find((w) => w.celular && w.simActiva !== false) ?? lista.find((w) => w.celular) ?? null;
  return {
    id: d.id,
    ...(esAdmin ? { sn: d.sn } : {}),
    nombre: d.nombre,
    modelo: d.modelo,
    firmware: d.firmware,
    estado: d.estado,
    ultimaVez: d.ultima_vez,
    offlineDesde: d.offline_desde,
    clientes: d.clientes,
    uptimeS: d.uptime_s,
    ubicacion: d.latitud != null && d.longitud != null ? { lat: d.latitud, lon: d.longitud, ts: d.ubicacion_ts } : null,
    wanActiva: d.wan_activa,
    actualizado: d.actualizado,
    celular: cel,
    wans: lista,
  };
}

/** Estado InControl2 de toda la flota: { agenteId → resumen } */
export async function resumenFlota({ esAdmin }) {
  const [porAgente, ajustes] = await Promise.all([dispositivosPorAgente(), obtenerAjustes()]);
  const ids = [...porAgente.values()].map((d) => d.id);
  const ciclo = cicloActual(ajustes.planSim.diaCorte);
  const [wans, consumo] = await Promise.all([wansDe(ids), consumoCelularDesde(ids, ciclo.inicio)]);
  const salida = {};
  for (const [agenteId, d] of porAgente) {
    salida[agenteId] = {
      ...resumenDispositivo(d, wans.get(d.id), esAdmin),
      ciclo: resumenCiclo(consumo.get(d.id)?.bytes ?? 0, ciclo, ajustes.planSim),
    };
  }
  return salida;
}

/** Detalle de un motocarro: router, WAN, ciclo, línea de tiempo de 48 h y consumo diario de 30 días */
export async function detalleMotocarro(agenteId, { esAdmin }) {
  const porAgente = await dispositivosPorAgente();
  const d = porAgente.get(agenteId);
  if (!d) return null;
  const ajustes = await obtenerAjustes();
  const ciclo = cicloActual(ajustes.planSim.diaCorte);
  const [wans, consumo, lecturas, diario] = await Promise.all([
    wansDe([d.id]),
    consumoCelularDesde([d.id], ciclo.inicio),
    query(
      `SELECT ts, estado, wan_activa AS "wanActiva", celular_estado AS "celularEstado", sim_disponible AS "simDisponible",
              senal_barras AS "senalBarras", rsrp, sinr
         FROM ic2_lecturas WHERE dispositivo_id = $1 AND ts > now() - interval '48 hours' ORDER BY ts`,
      [d.id]
    ),
    query(
      `SELECT to_char(hora AT TIME ZONE $2, 'YYYY-MM-DD') AS dia,
              COALESCE(sum(bytes_total) FILTER (WHERE celular), 0) AS celular,
              COALESCE(sum(bytes_total) FILTER (WHERE NOT celular), 0) AS otras
         FROM ic2_consumo_horario WHERE dispositivo_id = $1 AND hora > now() - interval '30 days'
        GROUP BY 1 ORDER BY 1`,
      [d.id, zonaIc2()]
    ),
  ]);
  return {
    ...resumenDispositivo(d, wans.get(d.id), esAdmin),
    ciclo: resumenCiclo(consumo.get(d.id)?.bytes ?? 0, ciclo, ajustes.planSim),
    lecturas: lecturas.rows,
    consumoDiario: diario.rows,
  };
}

// ---------------------------------------------------------------------------------------------
// Conciliación por hora: consumo real de la SIM (InControl2) vs sondeos del portal
//   T = consumo de la(s) WAN celular según InControl2
//   P = bytes de los sondeos del portal que salieron por SIM
//   F = minutos en failover (midiendo por SIM)
//   S = sobrecarga en espera = promedio de T en horas medidas sin failover
//   App estimada = T − P − S (en horas con failover)
// ---------------------------------------------------------------------------------------------
export async function conciliacion(agenteId, desde, hasta) {
  const porAgente = await dispositivosPorAgente();
  const d = porAgente.get(agenteId);
  const { rows } = await query(
    `WITH horas AS (
       SELECT hora FROM sondas_horario WHERE agente_id = $1 AND hora >= $3 AND hora < $4
       UNION
       SELECT hora FROM ic2_consumo_horario WHERE dispositivo_id = $2 AND hora >= $3 AND hora < $4
     )
     SELECT h.hora,
            c.celular AS t, c.total AS t_total, c.wans,
            s.bytes_sim AS p, s.bytes_total AS p_total, s.segundos_sim, s.segundos_medidos,
            sim.bytes AS t_sim
       FROM horas h
       LEFT JOIN LATERAL (
         SELECT COALESCE(sum(bytes_total) FILTER (WHERE celular), 0) AS celular, COALESCE(sum(bytes_total), 0) AS total,
                count(*) AS wans
           FROM ic2_consumo_horario WHERE dispositivo_id = $2 AND hora = h.hora
       ) c ON TRUE
       LEFT JOIN sondas_horario s ON s.agente_id = $1 AND s.hora = h.hora
       LEFT JOIN LATERAL (
         SELECT sum(bytes) AS bytes FROM ic2_consumo_sim_horario WHERE dispositivo_id = $2 AND hora = h.hora
       ) sim ON TRUE
      ORDER BY h.hora`,
    [agenteId, d?.id ?? -1, desde, hasta]
  );

  const horas = rows.map((r) => {
    const conIc2 = Number(r.wans) > 0;
    return {
      hora: r.hora,
      t: conIc2 ? Number(r.t) : null,
      tTotal: conIc2 ? Number(r.t_total) : null,
      tSim: r.t_sim == null ? null : Number(r.t_sim),
      p: Number(r.p ?? 0),
      pTotal: Number(r.p_total ?? 0),
      minSim: Math.round((r.segundos_sim ?? 0) / 6) / 10,
      minMedidos: Math.round((r.segundos_medidos ?? 0) / 6) / 10,
    };
  });

  // S: línea base de la SIM en espera (horas medidas por el portal, sin failover, con dato de InControl2)
  const base = horas.filter((h) => h.t !== null && h.minMedidos > 0 && h.minSim === 0);
  const s = base.length ? base.reduce((a, h) => a + h.t, 0) / base.length : 0;

  for (const h of horas) {
    h.failover = h.minSim > 0;
    if (h.t === null) {
      h.appEstimada = null;
      h.pctSondas = null;
      h.inconsistente = false;
      continue;
    }
    const neto = h.t - s;
    h.appEstimada = h.failover ? Math.max(0, Math.round(neto - h.p)) : null;
    h.pctSondas = h.failover && neto > 0 ? Math.round((h.p / neto) * 1000) / 10 : null;
    // Las sondas no pueden gastar más que la SIM completa: si pasa, falta consumo de InControl2 (llega con retraso)
    h.inconsistente = h.p > h.t * 1.05 + 10_240;
  }

  const sum = (f, k) => horas.filter(f).reduce((a, h) => a + (h[k] ?? 0), 0);
  const conFailover = (h) => h.failover && h.t !== null;
  const tFail = sum(conFailover, 't');
  const pFail = sum(conFailover, 'p');
  const nFail = horas.filter(conFailover).length;
  const netoFail = tFail - s * nFail;

  return {
    vinculado: !!d,
    dispositivoId: d?.id ?? null,
    desde,
    hasta,
    lineaBaseBytesHora: Math.round(s),
    horasLineaBase: base.length,
    totales: {
      simBytes: sum((h) => h.t !== null, 't'),
      simEnEsperaBytes: sum((h) => h.t !== null && !h.failover, 't'),
      simEnFailoverBytes: tFail,
      sondasSimBytes: sum(() => true, 'p'),
      appEstimadaBytes: sum(conFailover, 'appEstimada'),
      // Lo que gastó la SIM sin failover + la línea base durante las horas con failover
      sobrecargaBytes: Math.round(sum((h) => h.t !== null && !h.failover, 't') + s * nFail),
      minutosFailover: Math.round(sum(() => true, 'minSim')),
      pctSondas: netoFail > 0 ? Math.round((pFail / netoFail) * 1000) / 10 : null,
      horasInconsistentes: horas.filter((h) => h.inconsistente).length,
    },
    horas,
  };
}
