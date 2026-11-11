// Identifica la "salida a internet" de una petición: la IP pública con la que llegó y a qué red pertenece
// (Starlink, Telcel, etc.). Sirve para ver cuándo el router hace failover de un enlace a otro.
//
// El proveedor se obtiene por DNS con el servicio público de Team Cymru (gratuito, sin cuenta):
//   <ip invertida>.origin.asn.cymru.com  TXT → "14593 | 98.97.0.0/18 | US | arin | 2019-02-12"
//   AS14593.asn.cymru.com                TXT → "14593 | US | arin | 2019-02-12 | SPACEX-STARLINK, US"
import dns from 'node:dns/promises';
import net from 'node:net';

const TTL_OK_MS = 6 * 60 * 60 * 1000; // las IPs cambian de dueño muy rara vez
const TTL_ERROR_MS = 2 * 60 * 1000; // si falló la consulta, reintenta en 2 minutos
const TIMEOUT_MS = 2500;

export const sinMapeo = (ip) => (typeof ip === 'string' && ip.startsWith('::ffff:') ? ip.slice(7) : ip);

export function esPrivada(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254)
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
  }
  return true;
}

function expandirV6(ip) {
  const [cabeza, cola] = ip.split('::');
  const a = cabeza ? cabeza.split(':') : [];
  const b = ip.includes('::') && cola ? cola.split(':') : [];
  const grupos = ip.includes('::') ? [...a, ...Array(8 - a.length - b.length).fill('0'), ...b] : a;
  return grupos.map((g) => g.padStart(4, '0')).join('');
}

export function nombreConsulta(ip) {
  if (net.isIPv4(ip)) return `${ip.split('.').reverse().join('.')}.origin.asn.cymru.com`;
  return `${expandirV6(ip).split('').reverse().join('.')}.origin6.asn.cymru.com`;
}

// "SPACEX-STARLINK, US" → "SPACEX-STARLINK";  "Radiomovil Dipsa, S.A. de C.V., MX" → "Radiomovil Dipsa, S.A. de C.V."
const limpiarOrg = (s) => s.replace(/,\s*[A-Z]{2}\s*$/, '').trim();

// Nombres comerciales de redes comunes en México (el nombre registrado completo queda en "org")
const NOMBRES_CONOCIDOS = [
  [/radiomovil dipsa/i, 'Telcel'],
  [/at&t|att comunicaciones|iusacell|nextel|grupo ati/i, 'AT&T'],
  [/telefonica|movistar|pegaso/i, 'Movistar'],
  [/altan/i, 'Altán (Red Compartida)'],
  [/uninet|telmex/i, 'Telmex'],
  [/total ?play/i, 'Totalplay'],
  [/mega ?cable/i, 'Megacable'],
  [/cablevision|izzi/i, 'izzi'],
];

// Nombre corto para mostrar
export function proveedorDe(asn, org) {
  if (asn === 14593 || /spacex|starlink/i.test(org ?? '')) return 'Starlink';
  const conocido = NOMBRES_CONOCIDOS.find(([re]) => re.test(org ?? ''));
  return conocido ? conocido[1] : org || (asn ? `AS${asn}` : null);
}

const conTimeout = (p) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout DNS')), TIMEOUT_MS))]);

export function crearResolutor(resolveTxt = (n) => dns.resolveTxt(n)) {
  const cache = new Map(); // ip → { valor, expira, promesa }

  async function consultar(ip) {
    const txt = await conTimeout(resolveTxt(nombreConsulta(ip)));
    const [asns, prefijo, pais] = txt[0].join('').split('|').map((s) => s.trim());
    const asn = Number(asns.split(/\s+/)[0]);
    let org = null;
    try {
      const t2 = await conTimeout(resolveTxt(`AS${asn}.asn.cymru.com`));
      org = limpiarOrg(t2[0].join('').split('|').pop());
    } catch {
      /* sin nombre: queda solo el número de AS */
    }
    return { asn, prefijo, pais, org, proveedor: proveedorDe(asn, org) };
  }

  function lanzar(ip) {
    const entrada = { valor: null, expira: Date.now() + TTL_ERROR_MS, promesa: null };
    entrada.promesa = consultar(ip)
      .then((v) => {
        entrada.valor = v;
        entrada.expira = Date.now() + TTL_OK_MS;
        return v;
      })
      .catch(() => null)
      .finally(() => {
        entrada.promesa = null;
      });
    cache.set(ip, entrada);
    if (cache.size > 5000) cache.delete(cache.keys().next().value);
    return entrada;
  }

  function entradaDe(ip) {
    const e = cache.get(ip);
    if (e && (e.promesa || Date.now() < e.expira)) return e;
    return lanzar(ip);
  }

  return {
    // No espera: devuelve lo que haya en caché (o null) y, si hace falta, lanza la consulta en segundo plano
    enCache(ip) {
      if (esPrivada(ip)) return null;
      return entradaDe(ip).valor;
    },
    // Espera la consulta (con tiempo límite)
    async obtener(ip) {
      if (esPrivada(ip)) return null;
      const e = entradaDe(ip);
      return e.promesa ? await e.promesa : e.valor;
    },
  };
}

// IP pública real del cliente. Detrás de Cloudflare Tunnel, cloudflared se conecta desde localhost y la IP
// del visitante viene en Cf-Connecting-IP; solo se confía en ese encabezado si la conexión es local.
export function ipCliente(req) {
  const remota = sinMapeo(req.socket?.remoteAddress);
  const cf = req.headers['cf-connecting-ip'];
  if (cf && (remota === '127.0.0.1' || remota === '::1') && net.isIP(cf)) return sinMapeo(cf);
  return sinMapeo(req.ip);
}

// Centro de datos de Cloudflare que atendió la petición (sufijo de Cf-Ray, p. ej. "...-QRO")
const coloDe = (req) => (req.headers['cf-ray'] ?? '').split('-')[1] || null;

export function describirSalida(req, ip, info) {
  const privada = esPrivada(ip);
  return {
    ip,
    asn: info?.asn ?? null,
    org: info?.org ?? null,
    proveedor: privada ? 'Red local' : (info?.proveedor ?? null),
    pais: req.headers['cf-ipcountry'] ?? info?.pais ?? null,
    colo: coloDe(req),
  };
}
