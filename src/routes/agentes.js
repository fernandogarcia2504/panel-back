// Alta y administración de motocarros (agentes)
import { Router } from 'express';
import { query } from '../db/pool.js';
import { hashToken, nuevoToken, requireAdmin } from '../middleware/auth.js';
import { asyncHandler, parseId, validarId } from '../middleware/errors.js';
import { lanzarSiHayErrores, texto } from '../validacion.js';
import { horarioValido } from '../horario.js';

const router = Router();

const COLS = `id, nombre, notas, horario, activo, created_at AS "creado", ultima_vez AS "ultimaVez",
  version_agente AS version, so, flota_id AS "flotaId",
  (SELECT nombre FROM flotas f WHERE f.id = agentes.flota_id) AS flota`;

function validar(b, e) {
  const nombre = texto(e, b.nombre, 'Nombre', { requerido: true, max: 60 });
  const notas = texto(e, b.notas, 'Notas', { max: 300 });
  let horario = null;
  if (b.horario) {
    const err = horarioValido(b.horario);
    if (err) e.push(err);
    else {
      horario = {
        inicio: b.horario.inicio,
        fin: b.horario.fin,
        dias: [...new Set(b.horario.dias)].sort(),
        zona: b.horario.zona,
      };
    }
  }
  const flotaId = parseId(b.flotaId);
  if (!flotaId) e.push('Selecciona la flota');
  return { nombre, notas, horario, flotaId };
}

async function flotaExiste(id) {
  const { rows } = await query('SELECT 1 FROM flotas WHERE id = $1', [id]);
  return !!rows[0];
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const flota = req.query.flota ? parseId(req.query.flota) : null;
    const { rows } = await query(`SELECT ${COLS} FROM agentes WHERE ($1::int IS NULL OR flota_id = $1) ORDER BY nombre`, [flota]);
    res.json(rows);
  })
);

// Crea un motocarro y devuelve su token (solo esta vez)
router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const e = [];
    const d = validar(req.body ?? {}, e);
    if (d.flotaId && !(await flotaExiste(d.flotaId))) e.push('La flota no existe');
    lanzarSiHayErrores(e);
    const token = nuevoToken();
    const { rows } = await query(
      `INSERT INTO agentes (nombre, notas, horario, token_hash, flota_id) VALUES ($1, $2, $3, $4, $5) RETURNING ${COLS}`,
      [d.nombre, d.notas, d.horario ? JSON.stringify(d.horario) : null, hashToken(token), d.flotaId]
    );
    res.status(201).json({ ...rows[0], token });
  })
);

router.put(
  '/:id',
  requireAdmin,
  validarId(),
  asyncHandler(async (req, res) => {
    const e = [];
    const d = validar(req.body ?? {}, e);
    if (d.flotaId && !(await flotaExiste(d.flotaId))) e.push('La flota no existe');
    lanzarSiHayErrores(e);
    const activo = req.body?.activo !== false;
    const { rows } = await query(
      `UPDATE agentes SET nombre = $2, notas = $3, horario = $4, activo = $5, flota_id = $6 WHERE id = $1 RETURNING ${COLS}`,
      [req.params.id, d.nombre, d.notas, d.horario ? JSON.stringify(d.horario) : null, activo, d.flotaId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Motocarro no encontrado' });
    res.json(rows[0]);
  })
);

// Genera un token nuevo (el anterior deja de funcionar de inmediato)
router.post(
  '/:id/token',
  requireAdmin,
  validarId(),
  asyncHandler(async (req, res) => {
    const token = nuevoToken();
    const r = await query('UPDATE agentes SET token_hash = $2 WHERE id = $1', [req.params.id, hashToken(token)]);
    if (!r.rowCount) return res.status(404).json({ error: 'Motocarro no encontrado' });
    res.json({ token });
  })
);

// Borra el motocarro y TODO su histórico
router.delete(
  '/:id',
  requireAdmin,
  validarId(),
  asyncHandler(async (req, res) => {
    if (req.body?.confirmar !== true) return res.status(400).json({ error: 'Falta confirmar el borrado' });
    const r = await query('DELETE FROM agentes WHERE id = $1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Motocarro no encontrado' });
    res.json({ ok: true });
  })
);

export default router;
