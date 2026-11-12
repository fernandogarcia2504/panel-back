// Consumo de los sondeos del portal agrupado por hora (P en la conciliación) y tiempo en SIM (F).
// Se guarda en sondas_horario para conservarlo aunque las muestras crudas se depuren a los N días.
import { query } from '../db/pool.js';

/**
 * Recalcula las últimas `horas` horas (o desde `desde`) a partir de las muestras y pruebas de velocidad.
 * Devuelve cuántas horas por motocarro se guardaron.
 */
export async function actualizarSondasHorario(horas = 3, desde = null) {
  const inicio = desde ?? new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - horas * 3_600_000);
  const r = await query(
    `WITH m AS (
       SELECT mu.agente_id,
              date_trunc('hour', mu.ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS hora,
              (mu.bytes_enviados + mu.bytes_recibidos)::bigint AS bytes,
              (mu.ok AND r.tipo = 'redundante') AS sim,
              (o.intervalo_ms / 1000)::int AS seg
         FROM muestras mu
         JOIN operaciones o ON o.id = mu.operacion_id
         LEFT JOIN redes r ON r.asn = mu.asn
        WHERE mu.ts >= $1
     ),
     v AS (
       SELECT e.agente_id,
              date_trunc('hour', e.ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS hora,
              CASE WHEN e.datos->>'datosBytes' ~ '^\\d+$' THEN (e.datos->>'datosBytes')::bigint ELSE 0 END AS bytes,
              COALESCE(r.tipo = 'redundante', FALSE) AS sim
         FROM eventos e
         LEFT JOIN redes r ON r.asn = CASE WHEN e.datos->>'asn' ~ '^\\d+$' THEN (e.datos->>'asn')::int END
        WHERE e.tipo = 'velocidad' AND e.ts >= $1
     ),
     t AS (
       SELECT agente_id, hora,
              COALESCE(sum(bytes) FILTER (WHERE sim), 0) AS bytes_sim,
              COALESCE(sum(bytes), 0) AS bytes_total,
              LEAST(3600, COALESCE(sum(seg) FILTER (WHERE sim), 0)) AS segundos_sim,
              LEAST(3600, COALESCE(sum(seg), 0)) AS segundos_medidos
         FROM m GROUP BY agente_id, hora
     ),
     tv AS (
       SELECT agente_id, hora,
              COALESCE(sum(bytes) FILTER (WHERE sim), 0) AS bytes_sim,
              COALESCE(sum(bytes), 0) AS bytes_total
         FROM v GROUP BY agente_id, hora
     )
     INSERT INTO sondas_horario (agente_id, hora, bytes_sim, bytes_total, segundos_sim, segundos_medidos, actualizado)
     SELECT COALESCE(t.agente_id, tv.agente_id), COALESCE(t.hora, tv.hora),
            COALESCE(t.bytes_sim, 0) + COALESCE(tv.bytes_sim, 0),
            COALESCE(t.bytes_total, 0) + COALESCE(tv.bytes_total, 0),
            COALESCE(t.segundos_sim, 0), COALESCE(t.segundos_medidos, 0), now()
       FROM t FULL JOIN tv ON tv.agente_id = t.agente_id AND tv.hora = t.hora
     ON CONFLICT (agente_id, hora) DO UPDATE SET
       bytes_sim = EXCLUDED.bytes_sim, bytes_total = EXCLUDED.bytes_total,
       segundos_sim = EXCLUDED.segundos_sim, segundos_medidos = EXCLUDED.segundos_medidos, actualizado = now()`,
    [inicio]
  );
  return r.rowCount;
}
