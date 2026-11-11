import pg from 'pg';

pg.types.setTypeParser(1082, (v) => v); // DATE como texto
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // NUMERIC como número
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // BIGINT (count, ids) como número

// Heroku Postgres exige SSL con certificado propio; en local (127.0.0.1 / socket) no se usa
const url = process.env.DATABASE_URL ?? '';
const local = /@(localhost|127\.0\.0\.1|%2F|\/)/i.test(url) || url.includes('host=/');
const ssl = process.env.PGSSL === '0' || local ? false : { rejectUnauthorized: false };

export const pool = new pg.Pool({ connectionString: url, ssl, max: Number(process.env.PG_POOL_MAX || 10) });

pool.on('error', (err) => console.error('Error inesperado en el pool de PostgreSQL:', err.message));

export const query = (text, params) => pool.query(text, params);

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function checkConnection() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL no está definida');
  const { rows } = await pool.query('SELECT current_database() AS db, version() AS v');
  console.log(`PostgreSQL conectado: ${rows[0].db} (${rows[0].v.split(' ').slice(0, 2).join(' ')})`);
}
