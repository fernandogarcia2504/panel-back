// Estado en vivo de toda la flota
import { Router } from 'express';
import { query } from '../db/pool.js';
import { asyncHandler } from '../middleware/errors.js';
import { obtenerAjustes } from '../ajustes.js';
import { describirRed, redesPorAsn } from '../redes.js';
import { proximaVentana, ventanaActual } from '../horario.js';
import { reporteCacheado } from '../vivo.js';

const router = Router();

export function estadoAgente(a, ajustes, ahora = Date.now()) {
  const intervalo = a.intervalo_ms ?? ajustes.medicion.intervaloSeg * 1000;
  const horario = a.horario ?? ajustes.horario;
  const enHorario = !!ventanaActual(horario, new Date(ahora));
  if (!a.activo) return 'desactivado';
  if (!a.ultima_vez) return 'nunca';
  const edad = ahora - new Date(a.ultima_vez).getTime();
  if (a.en_operacion) return edad <= 3 * intervalo + 5000 ? 'operando' : 'sin_senal';
  if (enHorario) return 'sin_senal'; // debería estar midiendo y no se ha reportado
  const latido = ajustes.medicion.latidoFueraSeg * 1000;
  return latido && edad <= 2.5 * latido ? 'en_espera' : 'desconectado';
}

const resumenTotales = (t) =>
  t && {
    pctPrincipal: t.pctPrincipal,
    pctRedundante: t.pctRedundante,
    pctSinConexion: t.pctSinConexion,
    disponibilidad: t.disponibilidad,
    failovers: t.failovers,
    cortes: t.cortes,
    bytesTotal: t.bytesTotal,
    bytesRedundantes: t.bytesRedundantes,
    latenciaP95: t.latenciaP95,
  };

// GET /api/flota
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const [ajustes, redes] = await Promise.all([obtenerAjustes(), redesPorAsn()]);
    const { rows } = await query(
      `SELECT a.*, o.id AS op_id, o.clave AS op_clave, o.inicio_programado, o.fin_programado, o.estado AS op_estado,
              o.reporte, o.reporte_obsoleto, o.intervalo_ms AS op_intervalo
         FROM agentes a
         LEFT JOIN LATERAL (
           SELECT * FROM operaciones WHERE agente_id = a.id ORDER BY inicio_programado DESC LIMIT 1
         ) o ON TRUE
        ORDER BY a.nombre`
    );
    const ahora = Date.now();
    const agentes = [];
    for (const a of rows) {
      const estado = estadoAgente(a, ajustes, ahora);
      const red =
        estado === 'operando' || estado === 'en_espera'
          ? a.red_pendiente
            ? { nombre: 'Identificando…', tipo: 'desconocida' }
            : describirRed(a.ultima_asn, a.ultima_ip, redes)
          : { nombre: estado === 'sin_senal' ? 'Sin señal' : '—', tipo: 'sin_conexion' };
      let operacion = null;
      if (a.op_id) {
        const reporte = await reporteCacheado({
          id: a.op_id,
          estado: a.op_estado,
          reporte: a.reporte,
          reporte_obsoleto: a.reporte_obsoleto,
        });
        operacion = {
          id: a.op_id,
          clave: a.op_clave,
          estado: a.op_estado,
          inicio: a.inicio_programado,
          fin: a.fin_programado,
          totales: resumenTotales(reporte?.totales),
          ultimoCambio: reporte?.cambios?.at(-1) ?? null,
        };
      }
      const horario = a.horario ?? ajustes.horario;
      agentes.push({
        id: a.id,
        nombre: a.nombre,
        notas: a.notas,
        estado,
        ultimaVez: a.ultima_vez,
        red: { ...red, asn: a.ultima_asn, ip: a.ultima_ip, colo: a.ultima_colo, desde: a.red_desde },
        operacion,
        enHorario: !!ventanaActual(horario, new Date(ahora)),
        proxima: proximaVentana(horario, new Date(ahora)),
        version: a.version_agente,
        so: a.so,
        desfaseMs: a.desfase_ms,
      });
    }
    const cuenta = (f) => agentes.filter(f).length;
    res.json({
      generado: new Date().toISOString(),
      resumen: {
        total: agentes.length,
        operando: cuenta((x) => x.estado === 'operando'),
        enPrincipal: cuenta((x) => x.estado === 'operando' && x.red.tipo === 'principal'),
        enRedundante: cuenta((x) => x.estado === 'operando' && x.red.tipo !== 'principal'),
        sinSenal: cuenta((x) => x.estado === 'sin_senal'),
        enEspera: cuenta((x) => x.estado === 'en_espera'),
        desconectados: cuenta((x) => ['desconectado', 'nunca'].includes(x.estado)),
      },
      agentes,
    });
  })
);

export default router;
