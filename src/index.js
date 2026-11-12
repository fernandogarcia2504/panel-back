import { createApp } from './app.js';
import { checkConnection } from './db/pool.js';
import { programarMantenimiento } from './mantenimiento.js';
import { programarSincronizacion } from './incontrol/sync.js';

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 10) {
  console.error('JWT_SECRET falta o es muy corto (mínimo 32 caracteres)');
  process.exit(1);
}

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || '0.0.0.0'; // Heroku necesita escuchar en todas las interfaces

try {
  await checkConnection();
  createApp().listen(PORT, HOST, () => console.log(`Central escuchando en http://${HOST}:${PORT}`));
  if (process.env.MANTENIMIENTO !== '0') programarMantenimiento(Number(process.env.MANT_CADA_MS || 60_000));
  if (process.env.IC2_SYNC !== '0') programarSincronizacion();
} catch (err) {
  console.error('No se pudo iniciar la central:', err.message);
  process.exit(1);
}
