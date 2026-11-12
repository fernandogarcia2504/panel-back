// Cliente de la API de InControl2 (Peplink). Documentación: https://incontrol2.peplink.com/api/ic2-api-doc
//
// - OAuth 2.0 "client credentials": el token dura ~2 días; se renueva solo y se reintenta una vez si caduca.
// - Límite de InControl2: 20 peticiones/s por organización. Aquí se hacen como máximo IC2_MAX_RPS (por defecto 5).
// - Todas las llamadas son nube → nube: NO consumen datos de las SIM de los motocarros.

const BASE = () => (process.env.IC2_API_URL || 'https://api.ic.peplink.com').replace(/\/+$/, '');
const TIMEOUT_MS = 20_000;

export const ic2Configurado = () => !!(process.env.IC2_CLIENT_ID && process.env.IC2_CLIENT_SECRET && process.env.IC2_ORG_ID);

export class Ic2Error extends Error {
  constructor(mensaje, { status = null, codigo = null } = {}) {
    super(mensaje);
    this.status = status;
    this.codigo = codigo;
  }
}

let token = null; // { valor, expira }
let pendiente = null;

async function pedirToken() {
  const cuerpo = new URLSearchParams({
    client_id: process.env.IC2_CLIENT_ID,
    client_secret: process.env.IC2_CLIENT_SECRET,
    grant_type: 'client_credentials',
  });
  const res = await fetch(`${BASE()}/api/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: cuerpo,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Ic2Error(`No se pudo obtener el token de InControl2 (HTTP ${res.status}${data.error ? `: ${data.error}` : ''})`, {
      status: res.status,
      codigo: data.error ?? null,
    });
  }
  const segundos = Number(data.expires_in) || 3600;
  // Se renueva 5 minutos antes de que caduque
  token = { valor: data.access_token, expira: Date.now() + Math.max(60, segundos - 300) * 1000 };
  return token.valor;
}

async function tokenVigente() {
  if (token && Date.now() < token.expira) return token.valor;
  if (!pendiente) pendiente = pedirToken().finally(() => (pendiente = null));
  return pendiente;
}

// Ritmo: separa las peticiones para no rebasar el límite de InControl2
let siguienteHueco = 0;
async function esperarTurno() {
  const rps = Math.min(20, Math.max(1, Number(process.env.IC2_MAX_RPS || 5)));
  const ahora = Date.now();
  const turno = Math.max(ahora, siguienteHueco);
  siguienteHueco = turno + Math.ceil(1000 / rps);
  if (turno > ahora) await new Promise((r) => setTimeout(r, turno - ahora));
}

const qs = (params = {}) => {
  const s = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)])
  ).toString();
  return s ? `?${s}` : '';
};

/**
 * GET a la API REST. `ruta` es relativa a /rest (p. ej. `/o/123/d`).
 * Devuelve `data` del sobre { resp_code, data } (o la respuesta completa si no trae sobre).
 */
export async function ic2Get(ruta, params, { reintento = true } = {}) {
  if (!ic2Configurado()) throw new Ic2Error('InControl2 no está configurado (faltan variables IC2_* en el .env)');
  await esperarTurno();
  const res = await fetch(`${BASE()}/rest${ruta}${qs(params)}`, {
    headers: { Authorization: `Bearer ${await tokenVigente()}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401 && reintento) {
    token = null; // token caducado o revocado: se pide otro y se reintenta una vez
    return ic2Get(ruta, params, { reintento: false });
  }
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 1500));
    if (reintento) return ic2Get(ruta, params, { reintento: false });
  }
  const tipo = res.headers.get('content-type') ?? '';
  const data = tipo.includes('json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `HTTP ${res.status}`;
    throw new Ic2Error(`InControl2 respondió con error en ${ruta}: ${msg}`, { status: res.status, codigo: data?.resp_code ?? null });
  }
  if (data && typeof data === 'object' && 'resp_code' in data) {
    if (data.resp_code !== 'SUCCESS') {
      throw new Ic2Error(`InControl2 (${ruta}): ${data.resp_code}${data.message ? ` · ${data.message}` : ''}`, {
        codigo: data.resp_code,
      });
    }
    return data.data;
  }
  return data;
}

export const orgId = () => process.env.IC2_ORG_ID;
export const grupoId = () => process.env.IC2_GROUP_ID || null;

// Solo para pruebas
export function _reiniciarCliente() {
  token = null;
  pendiente = null;
  siguienteHueco = 0;
}
