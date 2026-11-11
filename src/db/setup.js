// Crea/actualiza las tablas y el primer usuario administrador. Idempotente (se ejecuta en cada despliegue).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { pool, checkConnection } from './pool.js';

try {
  await checkConnection();
  const dir = path.dirname(fileURLToPath(import.meta.url));
  await pool.query(await fs.readFile(path.join(dir, 'schema.sql'), 'utf8'));
  console.log('Tablas listas.');

  // Starlink se conoce de antemano: red principal
  await pool.query(
    `INSERT INTO redes (asn, nombre, tipo, org, auto) VALUES (14593, 'Starlink', 'principal', 'SPACEX-STARLINK', true)
     ON CONFLICT (asn) DO NOTHING`
  );

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM usuarios');
  if (rows[0].n === 0) {
    const username = (process.env.ADMIN_USER || 'admin').trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD;
    if (!password || password.length < 10) {
      throw new Error('Define ADMIN_PASSWORD (mínimo 10 caracteres) para crear el primer usuario');
    }
    await pool.query(`INSERT INTO usuarios (username, nombre, password_hash, rol) VALUES ($1, $2, $3, 'admin')`, [
      username,
      process.env.ADMIN_NAME || 'Administrador',
      await bcrypt.hash(password, 12),
    ]);
    console.log(`Usuario "${username}" creado.`);
  } else {
    console.log('Ya hay usuarios; no se crea ninguno.');
  }
} catch (err) {
  console.error('Error en db:setup:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
