// Métricas de InControl2 (Peplink) para el panel. Todo se lee de la base: la sincronización corre aparte.
import { Router } from 'express';
import { query } from '../db/pool.js';
import { requireAdmin } from '../middleware/auth.js';
import { asyncHandler, validarId } from '../middleware/errors.js';
import { ic2Configurado } from '../incontrol/cliente.js';
import { sincronizar, zonaIc2 } from '../incontrol/sync.js';
import { zonaAUtc } from '../horario.js';
import { conciliacion, detalleMotocarro, resumenFlota } from '../incontrol/consultas.js';

const router = Router();
const esAdmin = (req) => req.user?.rol === 'admin';
const reFecha = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/incontrol/estado → ¿está configurado? ¿cuándo se sincronizó por última vez?
router.get(
  '/estado',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT endpoint, ultimo_intento AS "ultimoIntento", ultimo_ok AS "ultimoOk", error FROM ic2_sync ORDER BY endpoint`
    );
    const { rows: c } = await query(
      `SELECT (SELECT count(*) FROM ic2_dispositivos) AS routers,
              (SELECT count(*) FROM ic2_dispositivos d JOIN inventario i ON upper(i.peplink_sn) = upper(d.sn)) AS vinculados`
    );
    res.json({ configurado: ic2Configurado(), endpoints: rows, ...c[0] });
  })
);

// GET /api/incontrol/flota → { agenteId: estado del router, WAN, SIM y ciclo de datos }
router.get(
  '/flota',
  asyncHandler(async (req, res) => {
    res.json({ generado: new Date().toISOString(), porAgente: await resumenFlota({ esAdmin: esAdmin(req) }) });
  })
);

// GET /api/incontrol/motocarros/:id
router.get(
  '/motocarros/:id',
  validarId(),
  asyncHandler(async (req, res) => {
    const d = await detalleMotocarro(req.params.id, { esAdmin: esAdmin(req) });
    if (!d) return res.json({ vinculado: false });
    res.json({ vinculado: true, ...d });
  })
);

// GET /api/incontrol/motocarros/:id/consumo?desde=YYYY-MM-DD&hasta=YYYY-MM-DD → conciliación por hora
router.get(
  '/motocarros/:id/consumo',
  validarId(),
  asyncHandler(async (req, res) => {
    // Fechas de calendario en la zona de la operación (desde 00:00 hasta el final del día "hasta")
    const dia = (s, extra = 0) => {
      const [y, m, d] = s.split('-').map(Number);
      return zonaAUtc(y, m, d + extra, 0, 0, zonaIc2());
    };
    const hasta = reFecha.test(req.query.hasta ?? '') ? dia(req.query.hasta, 1) : new Date();
    const desde = reFecha.test(req.query.desde ?? '') ? dia(req.query.desde) : new Date(hasta.getTime() - 2 * 86_400_000);
    if (!(hasta > desde)) return res.status(400).json({ error: 'El rango de fechas no es válido' });
    if (hasta - desde > 31 * 86_400_000) return res.status(400).json({ error: 'El rango máximo es de 31 días' });
    res.json(await conciliacion(req.params.id, desde, hasta));
  })
);

// GET /api/incontrol/diagnostico → última respuesta cruda de cada endpoint (para confirmar formatos)
router.get(
  '/diagnostico',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM ic2_sync ORDER BY endpoint');
    const { rows: sinVincular } = await query(
      `SELECT d.id, d.sn, d.nombre, d.estado FROM ic2_dispositivos d
        WHERE NOT EXISTS (SELECT 1 FROM inventario i WHERE upper(i.peplink_sn) = upper(d.sn)) ORDER BY d.nombre`
    );
    res.json({ configurado: ic2Configurado(), endpoints: rows, sinVincular });
  })
);

// POST /api/incontrol/sincronizar → corre una sincronización completa en segundo plano
router.post('/sincronizar', requireAdmin, (req, res) => {
  if (!ic2Configurado()) return res.status(400).json({ error: 'InControl2 no está configurado (revisa las variables IC2_*)' });
  sincronizar({ forzarCompleta: true }).catch((err) => console.error('InControl2 (manual):', err.message));
  res.status(202).json({ ok: true, mensaje: 'Sincronización iniciada; tarda alrededor de un minuto.' });
});

export default router;
