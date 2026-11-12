// Convierte las respuestas de InControl2 al formato de la base del portal.
//
// IMPORTANTE: la documentación oficial no publica el formato de respuesta de los endpoints de consumo
// (bandwidth_per_device, sim_usages). Por eso los lectores de consumo son tolerantes: recorren la respuesta y
// reconocen los nombres de campo más comunes. La última respuesta cruda de cada endpoint queda guardada en la
// tabla ic2_sync (Configuración → InControl2 → Diagnóstico) para confirmar los campos con datos reales.

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const txt = (v, max = 120) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, max));
const fecha = (v) => {
  if (!v) return null;
  const d = new Date(typeof v === 'number' && v < 1e12 ? v * 1000 : v);
  return Number.isNaN(d.getTime()) ? null : d;
};

// ---------------------------------------------------------------------------------------------
// WAN / celular
// ---------------------------------------------------------------------------------------------
const reCelular = /cell|gobi|modem|mobile|lte|sim|wwan/i;

export function esCelular(i) {
  return !!(reCelular.test(i?.type ?? '') || i?.imei || i?.sims || i?.carrier_name || i?.signal_bar !== undefined);
}

function simActiva(sims) {
  if (!sims) return null;
  if (Array.isArray(sims)) return sims.find((s) => s?.active === true || s?.active === 'true') ?? sims[0] ?? null;
  return sims;
}

const ESTADOS_SIN_SIM = /no sim|disabled/i;
const enEspera = (i) => {
  const s = i?.standby_state;
  if (s === undefined || s === null || s === '' || s === false) return false;
  return !/^(none|active|no|false|0)$/i.test(String(s));
};

/**
 * ¿La SIM está lista para un failover? Se evalúa con lo que InControl2 ya reporta: no gasta datos de la SIM.
 * Devuelve { disponible, motivo }.
 */
export function evaluarSim(w) {
  if (!w?.celular) return { disponible: null, motivo: null };
  if (w.habilitada === false) return { disponible: false, motivo: 'WAN celular deshabilitada' };
  if (ESTADOS_SIN_SIM.test(w.estado ?? '')) return { disponible: false, motivo: w.estado };
  if (w.cuota_excedida) return { disponible: false, motivo: 'Cuota de datos excedida' };
  if (w.sim_activa === false) return { disponible: false, motivo: 'SIM no activa' };
  if (w.senal_barras !== null && w.senal_barras !== undefined && w.senal_barras < 1) {
    return { disponible: false, motivo: 'Sin señal celular' };
  }
  if (/disconnected/i.test(w.estado ?? '') && !w.standby) return { disponible: false, motivo: 'Desconectada' };
  return { disponible: true, motivo: null };
}

export function normalizarWan(i) {
  const celular = esCelular(i);
  const sim = simActiva(i?.sims);
  const senales = i?.cellular_signals ?? {};
  const w = {
    wan_id: num(i?.id) ?? 0,
    nombre: txt(i?.name, 80),
    tipo: txt(i?.type, 40),
    celular,
    estado: txt(i?.status, 40),
    habilitada: i?.is_enable === undefined ? null : !!i.is_enable,
    activa: i?.is_overall_up === undefined ? null : !!i.is_overall_up,
    respaldo: i?.is_backup === undefined ? null : !!i.is_backup,
    standby: enEspera(i) ? txt(i.standby_state, 40) : null,
    cuota_excedida: i?.is_quota_exceed === undefined ? null : !!i.is_quota_exceed,
    operador: celular ? txt(i?.carrier_name, 80) : null,
    tecnologia: celular ? txt(i?.s2g3glte ?? i?.gobi_data_tech, 20) : null,
    senal_barras: celular ? num(i?.signal_bar) : null,
    rssi: celular ? num(senales.rssi) : null,
    sinr: celular ? num(senales.sinr) : null,
    rsrp: celular ? num(senales.rsrp) : null,
    rsrq: celular ? num(senales.rsrq) : null,
    imei: celular ? txt(i?.imei, 20) : null,
    iccid: celular ? txt(sim?.iccid, 30) : null,
    imsi: celular ? txt(sim?.imsi, 20) : null,
    sim_activa: celular && sim ? sim.active === true || sim.active === 'true' : null,
    monitor_cuota: celular && sim?.bandwidthAllowanceMonitor ? !!sim.bandwidthAllowanceMonitor.enable : null,
  };
  return w;
}

/**
 * WAN por la que sale el router ahora: conectada y no en espera. Si hay varias, se prefiere la no celular
 * (Starlink tiene prioridad 1). Es una aproximación: la fuente exacta de "por dónde salió" siguen siendo las sondas.
 */
export function wanActiva(wans) {
  const arriba = wans.filter((w) => /connected/i.test(w.estado ?? '') && !/dis/i.test(w.estado ?? '') && !w.standby && w.activa !== false);
  return arriba.find((w) => !w.celular) ?? arriba[0] ?? null;
}

export function normalizarDispositivo(d) {
  const wans = (Array.isArray(d?.interfaces) ? d.interfaces : []).map(normalizarWan);
  const activa = wanActiva(wans);
  const cel = wans.find((w) => w.celular && w.sim_activa !== false) ?? wans.find((w) => w.celular) ?? null;
  return {
    dispositivo: {
      id: num(d?.id),
      grupo_id: num(d?.group_id),
      sn: txt(d?.sn, 40),
      nombre: txt(d?.name, 120),
      modelo: txt(d?.product_name ?? d?.product_code, 120),
      firmware: txt(d?.fw_ver, 40),
      estado: txt(d?.status ?? d?.onlineStatus, 20),
      ultima_vez: fecha(d?.last_online),
      offline_desde: fecha(d?.offline_at),
      clientes: num(d?.client_count),
      uptime_s: num(d?.uptime),
      latitud: num(d?.latitude),
      longitud: num(d?.longitude),
      ubicacion_ts: fecha(d?.location_timestamp),
      wan_activa: activa?.nombre ?? null,
    },
    wans,
    celular: cel,
    sim: evaluarSim(cel),
  };
}

// ---------------------------------------------------------------------------------------------
// Consumo (bandwidth_per_device / sim_usages)
// ---------------------------------------------------------------------------------------------
const UNIDADES = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };
export const factorUnidad = () => UNIDADES[(process.env.IC2_UNIDAD_CONSUMO || 'MB').toUpperCase()] ?? UNIDADES.MB;

const CAMPOS_SUBIDA = ['upload', 'up', 'tx', 'sent', 'out', 'outbound', 'upload_usage', 'tx_usage', 'up_usage'];
const CAMPOS_BAJADA = ['download', 'down', 'rx', 'received', 'in', 'inbound', 'download_usage', 'rx_usage', 'down_usage'];
const CAMPOS_TOTAL = ['usage', 'total', 'total_usage', 'bandwidth', 'data_usage', 'usages'];

// Valor en bytes. Si el nombre del campo dice "byte", ya viene en bytes; si no, se usa IC2_UNIDAD_CONSUMO.
function aBytes(obj, campos) {
  for (const c of campos) {
    for (const k of Object.keys(obj)) {
      if (k.toLowerCase() !== c && k.toLowerCase() !== `${c}_bytes` && k.toLowerCase() !== `${c}bytes`) continue;
      const v = num(obj[k]);
      if (v === null) continue;
      return Math.round(v * (/byte/i.test(k) ? 1 : factorUnidad()));
    }
  }
  return null;
}

const idDispositivo = (o) => num(o.device_id ?? o.deviceId ?? (o.sn !== undefined ? o.id : undefined));
const idWan = (o) => num(o.wan_id ?? o.wanId ?? o.conn_id ?? (o.wan_name !== undefined || o.wan !== undefined ? o.id : undefined));
const horaDe = (o) => fecha(o.datetime ?? o.date_time ?? o.time ?? o.timestamp ?? o.hour ?? o.date ?? o.report_date ?? null);

/**
 * Recorre una respuesta de consumo y devuelve renglones { dispositivoId, wanId, wanNombre, hora, subida, bajada, total, imsi }.
 * `ctx` trae valores por defecto (p. ej. el dispositivo o la hora consultada).
 */
export function extraerConsumos(data, ctx = {}) {
  const filas = [];
  const visitar = (nodo, c, prof) => {
    if (prof > 8 || nodo === null || nodo === undefined) return;
    if (Array.isArray(nodo)) {
      for (const x of nodo) visitar(x, c, prof + 1);
      return;
    }
    if (typeof nodo !== 'object') return;
    const nc = { ...c };
    const d = idDispositivo(nodo);
    if (d !== null) nc.dispositivoId = d;
    const w = idWan(nodo);
    if (w !== null) nc.wanId = w;
    const nombreWan = nodo.wan_name ?? nodo.wan ?? (w !== null ? nodo.name : undefined);
    if (typeof nombreWan === 'string') nc.wanNombre = nombreWan;
    const h = horaDe(nodo);
    if (h) nc.hora = h;
    if (nodo.imsi) nc.imsi = String(nodo.imsi);

    const subida = aBytes(nodo, CAMPOS_SUBIDA);
    const bajada = aBytes(nodo, CAMPOS_BAJADA);
    let total = null;
    // "usage"/"total" solo cuenta si es número (si es un objeto, se baja un nivel)
    for (const k of CAMPOS_TOTAL) if (typeof nodo[k] === 'number' || (typeof nodo[k] === 'string' && num(nodo[k]) !== null)) total = aBytes(nodo, [k]);

    if (subida !== null || bajada !== null || total !== null) {
      filas.push({
        dispositivoId: nc.dispositivoId ?? null,
        wanId: nc.wanId ?? null,
        wanNombre: nc.wanNombre ?? null,
        hora: nc.hora ?? null,
        imsi: nc.imsi ?? null,
        subida: subida ?? 0,
        bajada: bajada ?? 0,
        total: total ?? (subida ?? 0) + (bajada ?? 0),
      });
    }
    for (const v of Object.values(nodo)) if (v && typeof v === 'object') visitar(v, nc, prof + 1);
  };
  visitar(data, ctx, 0);
  return filas;
}
