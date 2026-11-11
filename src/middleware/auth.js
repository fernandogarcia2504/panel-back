import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { query } from '../db/pool.js';

// ---------- Usuarios del panel (cookie httpOnly) ----------
export const COOKIE_NAME = 'monitor_sesion';

export const signToken = (userId) =>
  jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET, { expiresIn: '12h', algorithm: 'HS256' });

export const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 12 * 60 * 60 * 1000,
  path: '/',
});

export const usuarioPublico = (u) => ({ id: u.id, username: u.username, nombre: u.nombre, rol: u.rol });

export async function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'Sesión expirada o no válida' });
  }
  try {
    const { rows } = await query('SELECT id, username, nombre, rol, activo FROM usuarios WHERE id = $1', [
      Number(payload.sub),
    ]);
    if (!rows[0]?.activo) return res.status(401).json({ error: 'Sesión no válida' });
    req.user = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.rol !== 'admin') return res.status(403).json({ error: 'Solo un administrador puede hacer esto' });
  next();
}

// ---------- Agentes (Authorization: Bearer <token>) ----------
export const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
export const nuevoToken = () => `mr_${crypto.randomBytes(24).toString('base64url')}`;

export async function requireAgente(req, res, next) {
  const m = /^Bearer\s+(mr_[\w-]{20,})$/.exec(req.headers.authorization ?? '');
  if (!m) return res.status(401).json({ error: 'Token de agente requerido' });
  try {
    const { rows } = await query('SELECT * FROM agentes WHERE token_hash = $1', [hashToken(m[1])]);
    if (!rows[0]) return res.status(401).json({ error: 'Token de agente no válido' });
    if (!rows[0].activo) return res.status(403).json({ error: 'Agente desactivado' });
    req.agente = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}
