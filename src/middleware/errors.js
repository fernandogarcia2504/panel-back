// Envuelve handlers async para que los errores lleguen al manejador central
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Error de validación con lista de mensajes para el usuario
export class ValidationError extends Error {
  constructor(detalles) {
    super('Datos no válidos');
    this.detalles = Array.isArray(detalles) ? detalles : [detalles];
  }
}

// Convierte un parámetro a id entero positivo, o null si no es válido
export function parseId(valor) {
  const s = String(valor ?? '');
  if (!/^\d{1,10}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && n <= 2147483647 ? n : null;
}

export function validarId(param = 'id') {
  return (req, res, next) => {
    const id = parseId(req.params[param]);
    if (!id) return res.status(400).json({ error: 'Identificador no válido' });
    req.params[param] = id;
    next();
  };
}

export function notFound(req, res) {
  res.status(404).json({ error: 'Ruta no encontrada' });
}

// Códigos de error de PostgreSQL que son culpa de los datos enviados, no del servidor
const PG_ERRORES_CLIENTE = {
  23505: [409, 'Registro duplicado'],
  23503: [400, 'Hace referencia a un registro que no existe'],
  23514: [400, 'Algún valor está fuera del rango permitido'],
  23502: [400, 'Falta un campo obligatorio'],
  '22P02': [400, 'Formato de dato no válido'],
  22001: [400, 'Algún texto excede la longitud permitida'],
  22003: [400, 'Algún número está fuera de rango'],
  22007: [400, 'Fecha no válida'],
  22008: [400, 'Fecha fuera de rango'],
};

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof ValidationError) {
    return res.status(400).json({ error: err.message, detalles: err.detalles });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON no válido' });
  }
  if (err?.code && PG_ERRORES_CLIENTE[err.code]) {
    const [status, error] = PG_ERRORES_CLIENTE[err.code];
    return res.status(status).json({ error });
  }
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
}
