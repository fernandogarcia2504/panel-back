import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';

import authRoutes from './routes/auth.js';
import agenteRoutes from './routes/agente.js';
import flotaRoutes from './routes/flota.js';
import agentesRoutes from './routes/agentes.js';
import operacionesRoutes from './routes/operaciones.js';
import adminRoutes from './routes/admin.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler, notFound } from './middleware/errors.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Detrás del router de Heroku (1 salto): req.ip = IP real de quien se conecta.
  // Los agentes deben conectarse DIRECTO a la central (no a través de Vercel) para ver su IP de salida.
  app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));
  app.use(helmet());
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  app.get('/api/health', (req, res) => res.json({ ok: true, hora: new Date().toISOString() }));

  // Agentes (token propio)
  app.use('/api/agente', agenteRoutes);

  // Panel (sesión)
  app.use('/api/auth', authRoutes);
  app.use('/api/flota', requireAuth, flotaRoutes);
  app.use('/api/agentes', requireAuth, agentesRoutes);
  app.use('/api/operaciones', requireAuth, operacionesRoutes);
  app.use('/api', requireAuth, adminRoutes);

  app.use('/api', notFound);
  app.use(errorHandler);
  return app;
}
