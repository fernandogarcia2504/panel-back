// Sincronización periódica con InControl2.
//   - Cada IC2_SYNC_MIN minutos: estado de los routers, WAN, señal celular, SIM y ubicación (+ una lectura histórica).
//   - Consumo por hora y por WAN: las últimas horas en cada ciclo; las últimas 48 h cada 6 h y al arrancar
//     (InControl2 recibe el consumo con retraso y una hora ya leída puede aumentar después).
// Ninguna de estas llamadas usa datos de las SIM: son de nube a nube.
import { pool, query } from '../db/pool.js';
import { zonaAUtc, partesEnZona } from '../horario.js';
import { ic2Configurado, ic2Get, grupoId, orgId } from './cliente.js';
import { extraerConsumos, normalizarDispositivo } from './normalizar.js';
import { actualizarSondasHorario } from './sondas.js';

const LOCK_ID = 74_521_902;
export const zonaIc2 = () => process.env.IC2_ZONA || 'America/Mexico_City';
const HORAS_COMPLETAS = 48;

let ultimaCompleta = 0; // última vez que se recorrieron las 48 h de consumo
let primeraVuelta = true; // al arrancar se reconstruye el consumo de sondas de todo lo que haya en muestras
let enCurso = false;

// ---------------------------------------------------------------------------------------------
async function registrar(endpoint, { ok, error = null, muestra }) {
  const recortada = muestra === undefined ? null : JSON.stringify(muestra).slice(0, 60_000);
  await query(
    `INSERT INTO ic2_sync (endpoint, ultimo_intento, ultimo_ok, error, muestra)
     VALUES ($1, now(), CASE WHEN $2 THEN now() END, $3, $4::jsonb)
     ON CONFLICT (endpoint) DO UPDATE SET
       ultimo_intento = now(),
       ultimo_ok = CASE WHEN $2 THEN now() ELSE ic2_sync.ultimo_ok END,
       error = $3,
       muestra = COALESCE($4::jsonb, ic2_sync.muestra)`,
    [endpoint, ok, error ? String(error).slice(0, 500) : null, recortada && recortada.length < 60_000 ? recortada : null]
  );
}

// ---------------------------------------------------------------------------------------------
// Estado de los routers
// ---------------------------------------------------------------------------------------------
async function guardarDispositivo(n) {
  const d = n.dispositivo;
  await query(
    `INSERT INTO ic2_dispositivos (id, grupo_id, sn, nombre, modelo, firmware, estado, ultima_vez, offline_desde, clientes,
                                   uptime_s, latitud, longitud, ubicacion_ts, wan_activa, actualizado)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
     ON CONFLICT (id) DO UPDATE SET
       grupo_id = EXCLUDED.grupo_id, sn = EXCLUDED.sn, nombre = EXCLUDED.nombre, modelo = EXCLUDED.modelo,
       firmware = EXCLUDED.firmware, estado = EXCLUDED.estado, ultima_vez = EXCLUDED.ultima_vez,
       offline_desde = EXCLUDED.offline_desde, clientes = EXCLUDED.clientes, uptime_s = EXCLUDED.uptime_s,
       latitud = COALESCE(EXCLUDED.latitud, ic2_dispositivos.latitud),
       longitud = COALESCE(EXCLUDED.longitud, ic2_dispositivos.longitud),
       ubicacion_ts = COALESCE(EXCLUDED.ubicacion_ts, ic2_dispositivos.ubicacion_ts),
       wan_activa = EXCLUDED.wan_activa, actualizado = now()`,
    [d.id, d.grupo_id, d.sn, d.nombre, d.modelo, d.firmware, d.estado, d.ultima_vez, d.offline_desde, d.clientes,
      d.uptime_s, d.latitud, d.longitud, d.ubicacion_ts, d.wan_activa]
  );
  // Las WAN que ya no reporta el router se quitan
  await query('DELETE FROM ic2_wan WHERE dispositivo_id = $1 AND NOT (wan_id = ANY($2::int[]))', [d.id, n.wans.map((w) => w.wan_id)]);
  for (const w of n.wans) {
    await query(
      `INSERT INTO ic2_wan (dispositivo_id, wan_id, nombre, tipo, celular, estado, activa, respaldo, standby, cuota_excedida,
                            operador, tecnologia, senal_barras, rssi, sinr, rsrp, rsrq, imei, iccid, imsi, sim_activa,
                            monitor_cuota, actualizado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22, now())
       ON CONFLICT (dispositivo_id, wan_id) DO UPDATE SET
         nombre = EXCLUDED.nombre, tipo = EXCLUDED.tipo, celular = EXCLUDED.celular, estado = EXCLUDED.estado,
         activa = EXCLUDED.activa, respaldo = EXCLUDED.respaldo, standby = EXCLUDED.standby,
         cuota_excedida = EXCLUDED.cuota_excedida, operador = EXCLUDED.operador, tecnologia = EXCLUDED.tecnologia,
         senal_barras = EXCLUDED.senal_barras, rssi = EXCLUDED.rssi, sinr = EXCLUDED.sinr, rsrp = EXCLUDED.rsrp,
         rsrq = EXCLUDED.rsrq, imei = EXCLUDED.imei, iccid = EXCLUDED.iccid, imsi = EXCLUDED.imsi,
         sim_activa = EXCLUDED.sim_activa, monitor_cuota = EXCLUDED.monitor_cuota, actualizado = now()`,
      [d.id, w.wan_id, w.nombre, w.tipo, w.celular, w.estado, w.activa, w.respaldo, w.standby, w.cuota_excedida,
        w.operador, w.tecnologia, w.senal_barras, w.rssi, w.sinr, w.rsrp, w.rsrq, w.imei, w.iccid, w.imsi,
        w.sim_activa, w.monitor_cuota]
    );
  }
  await query(
    `INSERT INTO ic2_lecturas (dispositivo_id, estado, wan_activa, celular_estado, sim_disponible, senal_barras, rsrp, sinr,
                               latitud, longitud)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [d.id, d.estado, d.wan_activa, n.celular?.estado ?? null, n.sim.disponible, n.celular?.senal_barras ?? null,
      n.celular?.rsrp ?? null, n.celular?.sinr ?? null, d.latitud, d.longitud]
  );
}

async function sincronizarDispositivos() {
  const grupo = grupoId();
  let lista;
  try {
    lista = await ic2Get(`/o/${orgId()}/d`, { has_status: true });
    if (!Array.isArray(lista)) throw new Error('La lista de dispositivos no es un arreglo');
    await registrar('dispositivos', { ok: true, muestra: lista.slice(0, 3) });
  } catch (err) {
    await registrar('dispositivos', { ok: false, error: err.message });
    throw err;
  }
  const delGrupo = grupo ? lista.filter((d) => String(d.group_id) === String(grupo)) : lista;

  // El detalle trae la ubicación GPS (la lista no). Se pide router por router.
  const conDetalle = process.env.IC2_DETALLE !== '0';
  let errores = 0;
  let muestraDetalle;
  for (const d of delGrupo) {
    let fuente = d;
    if (conDetalle && d.status === 'online') {
      try {
        const det = await ic2Get(`/o/${orgId()}/d/${d.id}`);
        if (det && typeof det === 'object') {
          fuente = { ...d, ...det, interfaces: det.interfaces ?? d.interfaces };
          muestraDetalle ??= det;
        }
      } catch (err) {
        errores += 1;
        if (errores === 1) await registrar('detalle', { ok: false, error: err.message });
      }
    }
    const n = normalizarDispositivo(fuente);
    if (n.dispositivo.id === null || !n.dispositivo.sn) continue;
    await guardarDispositivo(n);
  }
  if (conDetalle && muestraDetalle && !errores) await registrar('detalle', { ok: true, muestra: muestraDetalle });
  return delGrupo.length;
}

// ---------------------------------------------------------------------------------------------
// Consumo por hora y por WAN
// ---------------------------------------------------------------------------------------------
const dos = (n) => String(n).padStart(2, '0');

// Inicio (UTC) de las horas completas más recientes, de la más nueva a la más vieja
export function horasRecientes(n, ahora = new Date()) {
  const p = partesEnZona(ahora, zonaIc2());
  const actual = zonaAUtc(p.y, p.m, p.d, p.h, 0, zonaIc2());
  return Array.from({ length: n }, (_, i) => new Date(actual.getTime() - (i + 1) * 3_600_000));
}

const reportDate = (hora) => {
  const p = partesEnZona(hora, zonaIc2());
  return `${p.y}-${dos(p.m)}-${dos(p.d)}T${dos(p.h)}:00:00`;
};

async function consumoDeHora(hora, dispositivos) {
  const data = await ic2Get(`/o/${orgId()}/bandwidth_per_device`, {
    type: 'hourly',
    report_date: reportDate(hora),
    wan_id: 0,
    include_details: true,
    device_ids: dispositivos.map((d) => d.id),
  });
  const filas = extraerConsumos(data, dispositivos.length === 1 ? { dispositivoId: dispositivos[0].id } : {});
  const wanCelular = new Map(); // "disp:wan" → { celular, nombre }
  const { rows } = await query('SELECT dispositivo_id, wan_id, nombre, celular FROM ic2_wan WHERE dispositivo_id = ANY($1)', [
    dispositivos.map((d) => d.id),
  ]);
  for (const r of rows) wanCelular.set(`${r.dispositivo_id}:${r.wan_id}`, r);

  // Si para un router hay renglones por WAN, el renglón sin WAN es el total y se descarta (evita contar doble)
  const conWan = new Set(filas.filter((f) => f.wanId !== null && f.dispositivoId !== null).map((f) => f.dispositivoId));
  const porLlave = new Map();
  for (const f of filas) {
    if (f.dispositivoId === null) continue;
    if (f.wanId === null && conWan.has(f.dispositivoId)) continue;
    const wanId = f.wanId ?? 0;
    const info = wanCelular.get(`${f.dispositivoId}:${wanId}`);
    const llave = `${f.dispositivoId}:${wanId}`;
    const previo = porLlave.get(llave);
    porLlave.set(llave, {
      dispositivoId: f.dispositivoId,
      wanId,
      nombre: f.wanNombre ?? info?.nombre ?? (wanId === 0 ? 'Total' : `WAN ${wanId}`),
      celular: info?.celular ?? /cell|sim|lte|móvil|movil|mobile/i.test(f.wanNombre ?? ''),
      subida: (previo?.subida ?? 0) + f.subida,
      bajada: (previo?.bajada ?? 0) + f.bajada,
      total: (previo?.total ?? 0) + f.total,
    });
  }
  for (const r of porLlave.values()) {
    await query(
      `INSERT INTO ic2_consumo_horario (dispositivo_id, hora, wan_id, wan_nombre, celular, bytes_subida, bytes_bajada,
                                        bytes_total, actualizado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (dispositivo_id, hora, wan_id) DO UPDATE SET
         wan_nombre = EXCLUDED.wan_nombre, celular = EXCLUDED.celular, bytes_subida = EXCLUDED.bytes_subida,
         bytes_bajada = EXCLUDED.bytes_bajada, bytes_total = EXCLUDED.bytes_total, actualizado = now()`,
      [r.dispositivoId, hora, r.wanId, r.nombre, r.celular, r.subida, r.bajada, r.total]
    );
  }
  return { data, renglones: porLlave.size };
}

async function sincronizarConsumo({ completa }) {
  const { rows: dispositivos } = await query('SELECT id FROM ic2_dispositivos ORDER BY id');
  if (!dispositivos.length) return 0;
  // El consumo de una hora llega a InControl2 hasta ~15 min después: la hora en curso no se pide
  const horas = horasRecientes(completa ? HORAS_COMPLETAS : 3);
  let total = 0;
  let muestra;
  try {
    for (const h of horas) {
      // Lotes de 50 routers por petición
      for (let i = 0; i < dispositivos.length; i += 50) {
        const r = await consumoDeHora(h, dispositivos.slice(i, i + 50));
        total += r.renglones;
        muestra ??= r.data;
      }
    }
    await registrar('consumo_horario', { ok: true, muestra });
  } catch (err) {
    await registrar('consumo_horario', { ok: false, error: err.message });
    throw err;
  }
  return total;
}

// ---------------------------------------------------------------------------------------------
// Consumo por SIM (experimental: el endpoint aparece en la documentación pero sin parámetros publicados)
// ---------------------------------------------------------------------------------------------
async function sincronizarSims() {
  const grupo = grupoId();
  if (process.env.IC2_SIM_USAGES !== '1' || !grupo) return 0;
  const { rows: dispositivos } = await query('SELECT id FROM ic2_dispositivos WHERE grupo_id = $1 OR grupo_id IS NULL', [grupo]);
  let total = 0;
  let muestra;
  try {
    for (const d of dispositivos) {
      const data = await ic2Get(`/o/${orgId()}/g/${grupo}/d/${d.id}/sim_usages/hourly`);
      muestra ??= data;
      const filas = extraerConsumos(data, { dispositivoId: d.id }).filter((f) => f.imsi && f.hora);
      for (const f of filas) {
        const hora = new Date(Math.floor(f.hora.getTime() / 3_600_000) * 3_600_000);
        await query(
          `INSERT INTO ic2_consumo_sim_horario (dispositivo_id, hora, imsi, bytes, actualizado) VALUES ($1,$2,$3,$4, now())
           ON CONFLICT (dispositivo_id, hora, imsi) DO UPDATE SET bytes = EXCLUDED.bytes, actualizado = now()`,
          [d.id, hora, f.imsi, f.total]
        );
        total += 1;
      }
    }
    await registrar('sim_usages', { ok: true, muestra });
  } catch (err) {
    await registrar('sim_usages', { ok: false, error: err.message });
  }
  return total;
}

// ---------------------------------------------------------------------------------------------
async function depurarLecturas() {
  const dias = Math.max(7, Number(process.env.IC2_RETENCION_DIAS || 180));
  const r = await query(`DELETE FROM ic2_lecturas WHERE ts < now() - make_interval(days => $1)`, [dias]);
  return r.rowCount;
}

/** Una vuelta completa de sincronización. Devuelve un resumen. */
export async function sincronizar({ forzarCompleta = false } = {}) {
  if (!ic2Configurado()) return { omitido: 'InControl2 no está configurado' };
  if (enCurso) return { omitido: 'Ya hay una sincronización en curso' };
  enCurso = true;
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
    if (!rows[0].ok) return { omitido: 'Otro proceso está sincronizando' };
    try {
      const resumen = { routers: 0, consumo: 0, sims: 0, sondas: 0, errores: [] };
      try {
        resumen.routers = await sincronizarDispositivos();
      } catch (err) {
        resumen.errores.push(err.message);
      }
      const completa = forzarCompleta || Date.now() - ultimaCompleta > 6 * 3_600_000;
      try {
        resumen.consumo = await sincronizarConsumo({ completa });
        if (completa) ultimaCompleta = Date.now();
      } catch (err) {
        resumen.errores.push(err.message);
      }
      resumen.sims = await sincronizarSims();
      resumen.sondas = await actualizarSondasHorario(primeraVuelta ? 24 * 46 : completa ? HORAS_COMPLETAS : 3);
      primeraVuelta = false;
      await depurarLecturas();
      return resumen;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    }
  } finally {
    client.release();
    enCurso = false;
  }
}

export function programarSincronizacion() {
  if (!ic2Configurado()) {
    console.log('InControl2: sin configurar (faltan IC2_CLIENT_ID, IC2_CLIENT_SECRET o IC2_ORG_ID); no se sincroniza.');
    return null;
  }
  const minutos = Math.min(60, Math.max(5, Number(process.env.IC2_SYNC_MIN || 10)));
  const correr = () =>
    sincronizar()
      .then((r) => {
        if (r.omitido) return;
        console.log(
          `InControl2: ${r.routers} routers, ${r.consumo} renglones de consumo, ${r.sims} de SIM, ${r.sondas} horas de sondas` +
            (r.errores.length ? ` · errores: ${r.errores.join(' | ')}` : '')
        );
      })
      .catch((err) => console.error('InControl2: error en la sincronización:', err.message));
  setTimeout(correr, 15_000);
  return setInterval(correr, minutos * 60_000);
}
