// Flotas de motocarros (solo en la plataforma). Todos los usuarios las ven; solo el administrador las edita.
import { Router } from 'express';
import { query } from '../db/pool.js';
import { requireAdmin } from '../middleware/auth.js';
import { asyncHandler, validarId } from '../middleware/errors.js';
import { lanzarSiHayErrores, texto } from '../validacion.js';

const router = Router();

const COLS = `f.id, f.nombre, f.notas, f.activa, f.created_at AS creada,
  (SELECT count(*) FROM agentes a WHERE a.flota_id = f.id) AS motocarros`;

function validar(b, e) {
  return {
    nombre: texto(e, b.nombre, 'Nombre', { requerido: true, max: 60 }),
    notas: texto(e, b.notas, 'Notas', { max: 300 }),
  };
}

const duplicado = (err) => {
  if (err.code === '23505') {
    err.status = 409;
    err.message = 'Ya existe una flota con ese nombre';
  }
  throw err;
};

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await query(`SELECT ${COLS} FROM flotas f ORDER BY f.activa DESC, f.nombre`);
    res.json(rows);
  })
);

router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const e = [];
    const d = validar(req.body ?? {}, e);
    lanzarSiHayErrores(e);
    const { rows } = await query('INSERT INTO flotas (nombre, notas) VALUES ($1, $2) RETURNING id', [d.nombre, d.notas]).catch(duplicado);
    const r = await query(`SELECT ${COLS} FROM flotas f WHERE f.id = $1`, [rows[0].id]);
    res.status(201).json(r.rows[0]);
  })
);

router.put(
  '/:id',
  requireAdmin,
  validarId(),
  asyncHandler(async (req, res) => {
    const e = [];
    const d = validar(req.body ?? {}, e);
    lanzarSiHayErrores(e);
    const r = await query('UPDATE flotas SET nombre = $2, notas = $3, activa = $4 WHERE id = $1', [
      req.params.id,
      d.nombre,
      d.notas,
      req.body?.activa !== false,
    ]).catch(duplicado);
    if (!r.rowCount) return res.status(404).json({ error: 'Flota no encontrada' });
    const { rows } = await query(`SELECT ${COLS} FROM flotas f WHERE f.id = $1`, [req.params.id]);
    res.json(rows[0]);
  })
);

// Solo se puede borrar una flota vacía (primero se mueven sus motocarros a otra)
router.delete(
  '/:id',
  requireAdmin,
  validarId(),
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT count(*) AS n FROM agentes WHERE flota_id = $1', [req.params.id]);
    if (rows[0].n > 0) {
      return res.status(400).json({ error: `La flota tiene ${rows[0].n} motocarro(s). Muévelos a otra flota antes de borrarla.` });
    }
    const r = await query('DELETE FROM flotas WHERE id = $1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Flota no encontrada' });
    res.json({ ok: true });
  })
);

export default router;
