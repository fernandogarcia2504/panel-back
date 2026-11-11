import { ValidationError } from './middleware/errors.js';

// Helpers de validación. Los textos vacíos se guardan como NULL.

export function texto(errores, valor, campo, { requerido = false, max = 255 } = {}) {
  if (valor === undefined || valor === null || (typeof valor === 'string' && valor.trim() === '')) {
    if (requerido) errores.push(`${campo} es obligatorio`);
    return null;
  }
  if (typeof valor !== 'string') {
    errores.push(`${campo} debe ser texto`);
    return null;
  }
  const v = valor.trim();
  if (v.length > max) errores.push(`${campo} admite máximo ${max} caracteres`);
  return v;
}

export function numero(errores, valor, campo, { min, max, entero = false } = {}) {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = typeof valor === 'number' ? valor : Number(valor);
  if (!Number.isFinite(n) || (entero && !Number.isInteger(n))) {
    errores.push(`${campo} debe ser un número${entero ? ' entero' : ''}`);
    return null;
  }
  if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
    errores.push(`${campo} debe estar entre ${min} y ${max}`);
    return null;
  }
  return n;
}

export function opcion(errores, valor, campo, opciones, { requerido = false } = {}) {
  if (valor === undefined || valor === null || valor === '') {
    if (requerido) errores.push(`${campo} es obligatorio`);
    return null;
  }
  if (!opciones.includes(valor)) {
    errores.push(`${campo} no es válido`);
    return null;
  }
  return valor;
}

export function fechaDia(errores, valor, campo, { requerido = false } = {}) {
  if (!valor) {
    if (requerido) errores.push(`${campo} es obligatoria`);
    return null;
  }
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor) || Number.isNaN(Date.parse(valor))) {
    errores.push(`${campo} no es una fecha válida`);
    return null;
  }
  if (valor > new Date().toISOString().slice(0, 10)) errores.push(`${campo} no puede ser futura`);
  return valor;
}

export function fechaHora(errores, valor, campo) {
  if (!valor) return null;
  const d = new Date(valor);
  if (typeof valor !== 'string' || Number.isNaN(d.getTime())) {
    errores.push(`${campo} no es una fecha válida`);
    return null;
  }
  return d.toISOString();
}

export function lanzarSiHayErrores(errores) {
  if (errores.length) throw new ValidationError(errores);
}

// Escapa comodines de LIKE (% y _) para búsquedas literales
export const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');
