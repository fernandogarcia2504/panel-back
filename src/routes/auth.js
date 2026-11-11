import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { query } from '../db/pool.js';
import { COOKIE_NAME, cookieOptions, requireAuth, signToken, usuarioPublico } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errors.js';

const router = Router();

// 10 intentos por usuario+IP cada 15 min
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `${String(req.body?.username ?? '').toLowerCase().slice(0, 40)}|${req.ip}`,
  message: { error: 'Demasiados intentos. Intenta de nuevo en unos minutos.' },
});

const HASH_FICTICIO = bcrypt.hashSync('contrasena-que-no-existe', 12);

router.post(
  '/login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña son obligatorios' });
    }
    if (username.length > 40 || password.length > 200) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    const { rows } = await query('SELECT * FROM usuarios WHERE username = $1', [username.trim().toLowerCase()]);
    const u = rows[0];
    const ok = await bcrypt.compare(password, u?.password_hash ?? HASH_FICTICIO);
    if (!u || !u.activo || !ok) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    res.cookie(COOKIE_NAME, signToken(u.id), cookieOptions());
    res.json({ user: usuarioPublico(u) });
  })
);

router.post('/logout', (req, res) => {
  const { maxAge, ...opts } = cookieOptions();
  res.clearCookie(COOKIE_NAME, opts);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => res.json({ user: usuarioPublico(req.user) }));

router.post(
  '/password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { actual, nueva } = req.body ?? {};
    if (typeof nueva !== 'string' || nueva.length < 10 || nueva.length > 200) {
      return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 10 caracteres' });
    }
    const { rows } = await query('SELECT password_hash FROM usuarios WHERE id = $1', [req.user.id]);
    if (typeof actual !== 'string' || !(await bcrypt.compare(actual, rows[0].password_hash))) {
      return res.status(400).json({ error: 'La contraseña actual no es correcta' });
    }
    await query('UPDATE usuarios SET password_hash = $2 WHERE id = $1', [req.user.id, await bcrypt.hash(nueva, 12)]);
    res.json({ ok: true });
  })
);

export default router;
