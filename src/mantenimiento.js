// Tareas periódicas: cerrar operaciones, completar el proveedor de IPs nuevas, recalcular y depurar.
import { pool, query } from './db/pool.js';
import { obtenerAjustes } from './ajustes.js';
import { registrarRed, resolutor } from './redes.js';
import { reporteDeOperacion } from './reporte.js';
import { olvidarReporte } from './vivo.js';

const GRACIA_CIERRE_MIN = 15; // espera datos atrasados antes de cerrar una operación
const LOCK_ID = 74_521_901; // un solo proceso hace mantenimiento a la vez

async function completarAsn() {
  const { rows } = await query(
    `SELECT DISTINCT ip FROM muestras WHERE asn IS NULL AND ip IS NOT NULL AND ts > now() - interval '45 days' LIMIT 100`
  );
  for (const { ip } of rows) {
    const info = await resolutor.obtener(ip);
    if (!info?.asn) continue;
    await registrarRed(info);
    const r = await query(
      `UPDATE muestras SET asn = $2 WHERE ip = $1 AND asn IS NULL RETURNING operacion_id`,
      [ip, info.asn]
    );
    const ops = [...new Set(r.rows.map((x) => x.operacion_id))];
    if (ops.length) {
      await query(`UPDATE operaciones SET reporte_obsoleto = TRUE WHERE id = ANY($1)`, [ops]);
      ops.forEach(olvidarReporte);
    }
  }
}

async function cerrarOperaciones() {
  const { rows } = await query(
    `UPDATE operaciones SET estado = 'cerrada', reporte_obsoleto = TRUE
      WHERE estado = 'en_curso'
        AND (fin_programado < now() - make_interval(mins => $1)
             OR (fin_reportado IS NOT NULL AND fin_programado < now()))
      RETURNING id`,
    [GRACIA_CIERRE_MIN]
  );
  return rows.map((r) => r.id);
}

async function recalcular() {
  const { rows } = await query(
    `SELECT id FROM operaciones WHERE estado = 'cerrada' AND reporte_obsoleto ORDER BY fin_programado DESC LIMIT 25`
  );
  for (const { id } of rows) {
    await reporteDeOperacion(id, { forzar: true });
    olvidarReporte(id);
  }
  return rows.length;
}

async function depurar() {
  const { retencion } = await obtenerAjustes();
  // Solo se borran muestras de operaciones cerradas cuyo reporte ya está guardado y vigente
  const r = await query(
    `DELETE FROM muestras WHERE id IN (
       SELECT m.id FROM muestras m JOIN operaciones o ON o.id = m.operacion_id
        WHERE m.ts < now() - make_interval(days => $1) AND o.estado = 'cerrada' AND NOT o.reporte_obsoleto
          AND o.reporte IS NOT NULL
        LIMIT 50000)`,
    [retencion.diasMuestras]
  );
  return r.rowCount;
}

export async function mantenimiento() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
    if (!rows[0].ok) return;
    try {
      await completarAsn();
      const cerradas = await cerrarOperaciones();
      const recalculadas = await recalcular();
      const borradas = await depurar();
      if (cerradas.length || recalculadas || borradas) {
        console.log(
          `Mantenimiento: ${cerradas.length} operaciones cerradas, ${recalculadas} reportes calculados, ${borradas} muestras depuradas`
        );
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    }
  } catch (err) {
    console.error('Error en mantenimiento:', err.message);
  } finally {
    client.release();
  }
}

export function programarMantenimiento(cadaMs = 60_000) {
  setTimeout(mantenimiento, 5_000);
  return setInterval(mantenimiento, cadaMs);
}
