// Ajustes globales, redes y usuarios del panel
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db/pool.js';
import { requireAdmin } from '../middleware/auth.js';
import { asyncHandler, validarId } from '../middleware/errors.js';
import { lanzarSiHayErrores, numero, opcion, texto } from '../validacion.js';
import { AJUSTES_DEFECTO, guardarAjuste, obtenerAjustes } from '../ajustes.js';
import { horarioValido } from '../horario.js';
import { invalidarRedes } from '../redes.js';

const router = Router();

// ---------- Ajustes ----------
router.get(
  '/ajustes',
  asyncHandler(async (req, res) => res.json({ ajustes: await obtenerAjustes(), defecto: AJUSTES_DEFECTO }))
);

const VALIDADORES = {
  horario: (v, e) => {
    const err = horarioValido(v);
    if (err) e.push(err);
    return { inicio: v?.inicio, fin: v?.fin, dias: [...new Set(v?.dias ?? [])].sort(), zona: v?.zona };
  },
  medicion: (v, e) => ({
    intervaloSeg: numero(e, v?.intervaloSeg, 'Intervalo', { min: 5, max: 600, entero: true }) ?? 20,
    tamanoMinimo: numero(e, v?.tamanoMinimo, 'Tamaño mínimo', { min: 0, max: 20000, entero: true }) ?? 0,
    timeoutSeg: numero(e, v?.timeoutSeg, 'Tiempo límite', { min: 2, max: 60, entero: true }) ?? 10,
    latidoFueraSeg: numero(e, v?.latidoFueraSeg, 'Latido fuera de horario', { min: 0, max: 3600, entero: true }) ?? 0,
  }),
  velocidad: (v, e) => ({
    alCambiarASim: v?.alCambiarASim === true,
    esperaSeg: numero(e, v?.esperaSeg, 'Espera', { min: 0, max: 600, entero: true }) ?? 20,
    maxMB: numero(e, v?.maxMB, 'Tamaño máximo', { min: 1, max: 8, entero: true }) ?? 4,
    destino: opcion(e, v?.destino, 'Destino', ['central', 'cloudflare'], { requerido: true }),
  }),
  retencion: (v, e) => ({
    diasMuestras: numero(e, v?.diasMuestras, 'Días de muestras', { min: 7, max: 730, entero: true }) ?? 30,
  }),
};

router.put(
  '/ajustes/:clave',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const validar = VALIDADORES[req.params.clave];
    if (!validar) return res.status(404).json({ error: 'Ajuste no encontrado' });
    const e = [];
    const valor = validar(req.body ?? {}, e);
    lanzarSiHayErrores(e);
    await guardarAjuste(req.params.clave, valor);
    res.json({ ajustes: await obtenerAjustes() });
  })
);

// ---------- Redes ----------
router.get(
  '/redes',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT asn, nombre, tipo, org, auto, primera_vez AS "primeraVez", ultima_vez AS "ultimaVez"
         FROM redes ORDER BY tipo, nombre`
    );
    res.json(rows);
  })
);

router.put(
  '/redes/:asn',
  requireAdmin,
  validarId('asn'),
  asyncHandler(async (req, res) => {
    const e = [];
    const nombre = texto(e, req.body?.nombre, 'Nombre', { requerido: true, max: 60 });
    const tipo = opcion(e, req.body?.tipo, 'Tipo', ['principal', 'redundante'], { requerido: true });
    lanzarSiHayErrores(e);
    const { rows } = await query(
      `INSERT INTO redes (asn, nombre, tipo, auto) VALUES ($1, $2, $3, FALSE)
       ON CONFLICT (asn) DO UPDATE SET nombre = EXCLUDED.nombre, tipo = EXCLUDED.tipo, auto = FALSE
       RETURNING asn, nombre, tipo, org, auto`,
      [req.params.asn, nombre, tipo]
    );
    invalidarRedes();
    // Los reportes guardados usan los nombres anteriores: se recalculan al consultarlos
    await query(`UPDATE operaciones SET reporte_obsoleto = TRUE WHERE estado = 'cerrada'`);
    res.json(rows[0]);
  })
);

// ---------- Usuarios ----------
router.get(
  '/usuarios',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      'SELECT id, username, nombre, rol, activo, created_at AS creado FROM usuarios ORDER BY nombre'
    );
    res.json(rows);
  })
);

router.post(
  '/usuarios',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const e = [];
    const username = texto(e, req.body?.username, 'Usuario', { requerido: true, max: 40 })?.toLowerCase();
    const nombre = texto(e, req.body?.nombre, 'Nombre', { requerido: true, max: 120 });
    const rol = opcion(e, req.body?.rol, 'Rol', ['admin', 'lectura'], { requerido: true });
    const password = req.body?.password;
    if (username && !/^[a-z0-9._-]{3,40}$/.test(username)) e.push('El usuario solo admite letras, números, punto y guion');
    if (typeof password !== 'string' || password.length < 10) e.push('La contraseña debe tener al menos 10 caracteres');
    lanzarSiHayErrores(e);
    const { rows } = await query(
      `INSERT INTO usuarios (username, nombre, password_hash, rol) VALUES ($1, $2, $3, $4)
       RETURNING id, username, nombre, rol, activo`,
      [username, nombre, await bcrypt.hash(password, 12), rol]
    );
    res.status(201).json(rows[0]);
  })
);

router.put(
  '/usuarios/:id',
  requireAdmin,
  validarId(),
  asyncHandler(async (req, res) => {
    if (req.params.id === req.user.id && req.body?.activo === false) {
      return res.status(400).json({ error: 'No puedes desactivar tu propio usuario' });
    }
    const { rows } = await query('UPDATE usuarios SET activo = $2 WHERE id = $1 RETURNING id, username, nombre, rol, activo', [
      req.params.id,
      req.body?.activo !== false,
    ]);
    if (!rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(rows[0]);
  })
);

export default router;
