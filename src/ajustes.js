import { query } from './db/pool.js';

// Valores por defecto de toda la flota. Se editan en el panel (Configuración).
export const AJUSTES_DEFECTO = {
  horario: { inicio: '06:00', fin: '22:00', dias: [1, 2, 3, 4, 5, 6, 7], zona: 'America/Mexico_City' },
  medicion: {
    intervaloSeg: 20, // una sonda cada N segundos dentro del horario
    tamanoMinimo: 350, // bytes mínimos del cuerpo de la sonda (≈ un alta de expediente)
    timeoutSeg: 10,
    latidoFueraSeg: 300, // fuera de horario, un "latido" cada N segundos para saber que la PC está viva (0 = no)
  },
  velocidad: {
    alCambiarASim: true, // una prueba de velocidad cada vez que la salida cambia a una red redundante
    esperaSeg: 20, // espera tras el cambio antes de medir (que la red se estabilice)
    maxMB: 4, // tamaño máximo por transferencia
    destino: 'central', // 'central' (funciona con la lista blanca) o 'cloudflare'
  },
  retencion: { diasMuestras: 30 }, // las muestras crudas se borran después; los reportes se conservan siempre
};

let cache = null;
let cacheTs = 0;

export async function obtenerAjustes() {
  if (cache && Date.now() - cacheTs < 30_000) return cache;
  const { rows } = await query('SELECT clave, valor FROM ajustes');
  const guardados = Object.fromEntries(rows.map((r) => [r.clave, r.valor]));
  cache = Object.fromEntries(
    Object.entries(AJUSTES_DEFECTO).map(([k, v]) => [k, { ...v, ...(guardados[k] ?? {}) }])
  );
  cacheTs = Date.now();
  return cache;
}

export async function guardarAjuste(clave, valor) {
  await query(
    `INSERT INTO ajustes (clave, valor) VALUES ($1, $2)
     ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = now()`,
    [clave, JSON.stringify(valor)]
  );
  cache = null;
}

// Configuración que recibe un agente (horario propio o el global)
export async function configDeAgente(agente) {
  const a = await obtenerAjustes();
  const config = {
    horario: agente.horario ?? a.horario,
    medicion: a.medicion,
    velocidad: a.velocidad,
  };
  return config;
}
