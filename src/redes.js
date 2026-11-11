import { query } from './db/pool.js';
import { crearResolutor } from './salida.js';

// Resolución IP → AS (Team Cymru por DNS, con caché). Ver salida.js.
export const resolutor = crearResolutor();

// Clasificación automática de una red nueva según el nombre registrado del AS.
// Se puede corregir a mano en el panel (Configuración → Redes) y la corrección aplica a todo el histórico.
const AUTO = [
  [(asn, org) => asn === 14593 || /spacex|starlink/i.test(org), 'Starlink', 'principal'],
  [(asn, org) => /altan/i.test(org), 'Altán (Bait)', 'redundante'],
  [(asn, org) => /walmart|bait/i.test(org), 'Bait', 'redundante'],
  [(asn, org) => /at&t|att comunicaciones|iusacell|nextel|grupo ati/i.test(org), 'AT&T', 'redundante'],
  [(asn, org) => /radiomovil dipsa/i.test(org), 'Telcel', 'redundante'],
  [(asn, org) => /telefonica|movistar|pegaso/i.test(org), 'Movistar', 'redundante'],
];

export function clasificarAuto(asn, org) {
  const r = AUTO.find(([f]) => f(asn, org ?? ''));
  return r ? { nombre: r[1], tipo: r[2] } : { nombre: (org || `AS${asn}`).slice(0, 60), tipo: 'redundante' };
}

let mapa = null;
let mapaTs = 0;

export async function redesPorAsn() {
  if (mapa && Date.now() - mapaTs < 30_000) return mapa;
  const { rows } = await query('SELECT asn, nombre, tipo, org FROM redes');
  mapa = new Map(rows.map((r) => [r.asn, r]));
  mapaTs = Date.now();
  return mapa;
}

export function invalidarRedes() {
  mapa = null;
}

// Registra (o actualiza) una red vista
export async function registrarRed(info) {
  if (!info?.asn) return;
  const m = await redesPorAsn();
  if (m.has(info.asn)) {
    // ultima_vez con baja frecuencia para no escribir en cada sonda
    const r = m.get(info.asn);
    if (!r._tocada || Date.now() - r._tocada > 10 * 60_000) {
      r._tocada = Date.now();
      await query('UPDATE redes SET ultima_vez = now() WHERE asn = $1', [info.asn]);
    }
    return;
  }
  const { nombre, tipo } = clasificarAuto(info.asn, info.org);
  await query(
    `INSERT INTO redes (asn, nombre, tipo, org) VALUES ($1, $2, $3, $4) ON CONFLICT (asn) DO NOTHING`,
    [info.asn, nombre, tipo, info.org]
  );
  invalidarRedes();
}

// Describe una salida para el agente / el panel
export function describirRed(asn, ip, redes) {
  if (!ip) return { nombre: 'Sin conexión', tipo: 'sin_conexion' };
  const r = asn ? redes.get(asn) : null;
  if (r) return { nombre: r.nombre, tipo: r.tipo };
  return { nombre: asn ? `AS${asn}` : 'Identificando…', tipo: 'desconocida' };
}
