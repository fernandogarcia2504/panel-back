// Ventanas de operación según un horario en la zona horaria de la operación.
// IMPORTANTE: el agente tiene una copia idéntica de este código (agente/agente.js). Si cambias uno, cambia el otro.
//
// horario = { inicio: "06:00", fin: "22:00", dias: [1..7] (1 = lunes), zona: "America/Mexico_City" }
// Si fin <= inicio, la ventana cruza la medianoche (p. ej. 20:00 → 04:00). Si son iguales, dura 24 h.
// "dias" se refiere al día en que EMPIEZA la ventana.

const FORMATOS = new Map();
function formato(zona) {
  if (!FORMATOS.has(zona)) {
    FORMATOS.set(
      zona,
      new Intl.DateTimeFormat('en-US', {
        timeZone: zona,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    );
  }
  return FORMATOS.get(zona);
}

export function partesEnZona(fecha, zona) {
  const p = Object.fromEntries(formato(zona).formatToParts(fecha).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

// Fecha/hora "de reloj" en la zona → instante UTC (maneja cambios de horario)
export function zonaAUtc(y, m, d, h, mi, zona) {
  const objetivo = Date.UTC(y, m - 1, d, h, mi);
  let t = objetivo;
  for (let i = 0; i < 3; i++) {
    const p = partesEnZona(new Date(t), zona);
    const comoUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    t = objetivo - (comoUtc - t);
  }
  return new Date(t);
}

const hhmm = (s) => {
  const [h, m] = String(s).split(':').map(Number);
  return [h, m];
};

function ventanaQueEmpieza(horario, y, m, d) {
  const base = new Date(Date.UTC(y, m - 1, d));
  const yy = base.getUTCFullYear();
  const mm = base.getUTCMonth() + 1;
  const dd = base.getUTCDate();
  const dow = ((base.getUTCDay() + 6) % 7) + 1; // 1 = lunes ... 7 = domingo
  if (!horario.dias.includes(dow)) return null;
  const [hi, mi] = hhmm(horario.inicio);
  const [hf, mf] = hhmm(horario.fin);
  const inicio = zonaAUtc(yy, mm, dd, hi, mi, horario.zona);
  let fin = zonaAUtc(yy, mm, dd, hf, mf, horario.zona);
  if (fin <= inicio) fin = zonaAUtc(yy, mm, dd + 1, hf, mf, horario.zona);
  // Clave de la operación: fecha local + hora de inicio (dos ventanas el mismo día no se mezclan)
  const clave = `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}T${String(hi).padStart(2, '0')}${String(mi).padStart(2, '0')}`;
  return { clave, inicio, fin };
}

// Ventana en curso (o null si ahora está fuera de horario)
export function ventanaActual(horario, ahora = new Date()) {
  const p = partesEnZona(ahora, horario.zona);
  for (const delta of [0, -1]) {
    const v = ventanaQueEmpieza(horario, p.y, p.m, p.d + delta);
    if (v && ahora >= v.inicio && ahora < v.fin) return v;
  }
  return null;
}

// Próxima ventana que empieza después de "ahora"
export function proximaVentana(horario, ahora = new Date()) {
  const p = partesEnZona(ahora, horario.zona);
  for (let delta = 0; delta <= 8; delta++) {
    const v = ventanaQueEmpieza(horario, p.y, p.m, p.d + delta);
    if (v && v.inicio > ahora) return v;
  }
  return null;
}

// Ventana con una clave (fecha local de inicio) dada
export function ventanaDeClave(horario, clave) {
  const [y, m, d] = clave.slice(0, 10).split('-').map(Number);
  const h = clave.length > 10 ? { ...horario, inicio: `${clave.slice(11, 13)}:${clave.slice(13, 15)}` } : horario;
  return ventanaQueEmpieza({ ...h, dias: [1, 2, 3, 4, 5, 6, 7] }, y, m, d);
}

export function horarioValido(h) {
  const re = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!h || typeof h !== 'object') return 'Horario no válido';
  if (!re.test(h.inicio ?? '') || !re.test(h.fin ?? '')) return 'Las horas deben tener formato HH:MM';
  if (!Array.isArray(h.dias) || !h.dias.length || !h.dias.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)) {
    return 'Selecciona al menos un día';
  }
  try {
    formato(h.zona).format(new Date());
  } catch {
    return 'Zona horaria no válida';
  }
  return null;
}
