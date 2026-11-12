// Inventario homologado de cada motocarro (solo administradores). Fase 1: captura manual.
// Cada cambio queda en la bitácora con usuario, campo, valor anterior y nuevo.
import { Router } from 'express';
import { query, withTransaction } from '../db/pool.js';
import { requireAdmin } from '../middleware/auth.js';
import { asyncHandler, parseId, validarId } from '../middleware/errors.js';
import { fechaDia, lanzarSiHayErrores, texto } from '../validacion.js';

const router = Router();
router.use(requireAdmin);

// campo → { etiqueta, max, patron?, mensaje?, mayusculas? }
export const CAMPOS = {
  placa: { etiqueta: 'Placa', max: 20, mayusculas: true },
  peplink_sn: { etiqueta: 'Peplink: número de serie', max: 40, mayusculas: true },
  starlink_sn: { etiqueta: 'Starlink: número de serie', max: 60, mayusculas: true },
  sim1_operador: { etiqueta: 'SIM 1: operador', max: 40 },
  sim1_iccid: { etiqueta: 'SIM 1: ICCID', max: 30, patron: /^\d{18,22}F?$/i, mensaje: 'debe tener de 18 a 22 dígitos' },
  sim1_imsi: { etiqueta: 'SIM 1: IMSI', max: 20, patron: /^\d{14,15}$/, mensaje: 'debe tener 14 o 15 dígitos' },
  sim2_operador: { etiqueta: 'SIM 2: operador', max: 40 },
  sim2_iccid: { etiqueta: 'SIM 2: ICCID', max: 30, patron: /^\d{18,22}F?$/i, mensaje: 'debe tener de 18 a 22 dígitos' },
  sim2_imsi: { etiqueta: 'SIM 2: IMSI', max: 20, patron: /^\d{14,15}$/, mensaje: 'debe tener 14 o 15 dígitos' },
  tablet1_sn: { etiqueta: 'Tablet 1: número de serie', max: 60, mayusculas: true },
  tablet2_sn: { etiqueta: 'Tablet 2: número de serie', max: 60, mayusculas: true },
  fecha_instalacion: { etiqueta: 'Fecha de instalación', fecha: true },
};

const COLS = Object.keys(CAMPOS);

function validar(b, e) {
  const v = {};
  for (const [campo, def] of Object.entries(CAMPOS)) {
    if (def.fecha) {
      v[campo] = fechaDia(e, b[campo], def.etiqueta);
      continue;
    }
    let x = texto(e, b[campo], def.etiqueta, { max: def.max });
    if (x && def.mayusculas) x = x.toUpperCase();
    if (x && def.patron) {
      x = x.replace(/\s+/g, '');
      if (!def.patron.test(x)) e.push(`${def.etiqueta} ${def.mensaje}`);
    }
    v[campo] = x;
  }
  return v;
}

// GET /api/inventario → todos los motocarros con su inventario y si su Peplink aparece en InControl2
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT a.id AS "agenteId", a.nombre, a.activo, a.flota_id AS "flotaId", fl.nombre AS flota, ${COLS.map((c) => `i.${c}`).join(', ')}, i.updated_at AS actualizado,
              d.id AS "ic2Id", d.nombre AS "ic2Nombre", d.estado AS "ic2Estado"
         FROM agentes a
         LEFT JOIN flotas fl ON fl.id = a.flota_id
         LEFT JOIN inventario i ON i.agente_id = a.id
         LEFT JOIN ic2_dispositivos d ON i.peplink_sn IS NOT NULL AND upper(d.sn) = upper(i.peplink_sn)
        WHERE ($1::int IS NULL OR a.flota_id = $1)
        ORDER BY a.nombre`,
      [req.query.flota ? parseId(req.query.flota) : null]
    );
    res.json(rows);
  })
);

// GET /api/inventario/:id/bitacora
router.get(
  '/:id/bitacora',
  validarId(),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT id, usuario_nombre AS usuario, campo, valor_anterior AS anterior, valor_nuevo AS nuevo, ts
         FROM inventario_bitacora WHERE agente_id = $1 ORDER BY ts DESC, id DESC LIMIT 500`,
      [req.params.id]
    );
    res.json(rows.map((r) => ({ ...r, etiqueta: CAMPOS[r.campo]?.etiqueta ?? r.campo })));
  })
);

// PUT /api/inventario/:id → guarda el inventario del motocarro y registra cada campo que cambió
router.put(
  '/:id',
  validarId(),
  asyncHandler(async (req, res) => {
    const e = [];
    const nuevo = validar(req.body ?? {}, e);
    lanzarSiHayErrores(e);
    const agenteId = req.params.id;
    const resultado = await withTransaction(async (db) => {
      const { rows: ag } = await db.query('SELECT id FROM agentes WHERE id = $1', [agenteId]);
      if (!ag[0]) return null;
      const { rows: prev } = await db.query('SELECT * FROM inventario WHERE agente_id = $1 FOR UPDATE', [agenteId]);
      const anterior = prev[0] ?? {};
      const cambios = COLS.filter((c) => (anterior[c] ?? null) !== (nuevo[c] ?? null));
      if (!cambios.length) return { cambios: 0 };
      await db.query(
        `INSERT INTO inventario (agente_id, ${COLS.join(', ')}, updated_at)
         VALUES ($1, ${COLS.map((_, i) => `$${i + 2}`).join(', ')}, now())
         ON CONFLICT (agente_id) DO UPDATE SET ${COLS.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}, updated_at = now()`,
        [agenteId, ...COLS.map((c) => nuevo[c])]
      );
      await db.query(
        `INSERT INTO inventario_bitacora (agente_id, usuario_id, usuario_nombre, campo, valor_anterior, valor_nuevo)
         SELECT $1, $2, $3, * FROM unnest($4::text[], $5::text[], $6::text[])`,
        [
          agenteId,
          req.user.id,
          req.user.nombre,
          cambios,
          cambios.map((c) => anterior[c] ?? null),
          cambios.map((c) => nuevo[c] ?? null),
        ]
      );
      return { cambios: cambios.length };
    }).catch((err) => {
      if (err.code === '23505') {
        const campo = /starlink/.test(err.constraint ?? '') ? 'Starlink' : 'Peplink';
        err.message = `Ese número de serie de ${campo} ya está asignado a otro motocarro`;
        err.status = 409;
      }
      throw err;
    });
    if (!resultado) return res.status(404).json({ error: 'Motocarro no encontrado' });
    res.json({ ok: true, ...resultado });
  })
);

export default router;
