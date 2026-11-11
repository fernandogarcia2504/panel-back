-- Esquema de la central de monitoreo. Idempotente: se puede ejecutar en cada despliegue.

CREATE TABLE IF NOT EXISTS usuarios (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      VARCHAR(40)  NOT NULL UNIQUE CHECK (username = lower(username) AND length(username) >= 3),
  nombre        VARCHAR(120) NOT NULL,
  password_hash TEXT         NOT NULL,
  rol           VARCHAR(10)  NOT NULL DEFAULT 'admin' CHECK (rol IN ('admin', 'lectura')),
  activo        BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Ajustes globales (horario por defecto, intervalo, velocidad, retención...)
CREATE TABLE IF NOT EXISTS ajustes (
  clave      VARCHAR(40) PRIMARY KEY,
  valor      JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un agente = la PC de un motocarro
CREATE TABLE IF NOT EXISTS agentes (
  id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre          VARCHAR(60)  NOT NULL UNIQUE,
  notas           VARCHAR(300),
  token_hash      CHAR(64)     NOT NULL UNIQUE,     -- sha256 del token; el token solo se muestra al crearlo
  horario         JSONB,                            -- NULL = usa el horario global
  activo          BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- Estado en vivo (se actualiza con cada sonda)
  ultima_vez      TIMESTAMPTZ,
  ultima_ip       VARCHAR(45),
  ultima_asn      INTEGER,
  ultima_colo     VARCHAR(8),
  en_operacion    BOOLEAN      NOT NULL DEFAULT FALSE,
  operacion_clave VARCHAR(16),
  version_agente  VARCHAR(20),
  so              VARCHAR(60),
  desfase_ms      INTEGER                            -- diferencia entre el reloj de la PC y el del servidor
);
ALTER TABLE agentes ADD COLUMN IF NOT EXISTS red_desde TIMESTAMPTZ;      -- desde cuándo está en la red actual
ALTER TABLE agentes ADD COLUMN IF NOT EXISTS intervalo_ms INTEGER;       -- intervalo con el que está midiendo
ALTER TABLE agentes ADD COLUMN IF NOT EXISTS red_pendiente BOOLEAN NOT NULL DEFAULT FALSE; -- IP nueva aún sin identificar

-- Redes vistas (por número de AS) y cómo se llaman / clasifican
CREATE TABLE IF NOT EXISTS redes (
  asn         INTEGER      PRIMARY KEY,
  nombre      VARCHAR(60)  NOT NULL,
  tipo        VARCHAR(12)  NOT NULL DEFAULT 'redundante' CHECK (tipo IN ('principal', 'redundante')),
  org         VARCHAR(200),
  auto        BOOLEAN      NOT NULL DEFAULT TRUE,   -- FALSE = editada a mano en el panel
  primera_vez TIMESTAMPTZ  NOT NULL DEFAULT now(),
  ultima_vez  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Una operación = una ventana de horario de un motocarro (p. ej. 2026-11-10 de 06:00 a 22:00)
CREATE TABLE IF NOT EXISTS operaciones (
  id                 INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agente_id          INTEGER     NOT NULL REFERENCES agentes (id) ON DELETE CASCADE,
  clave              VARCHAR(16) NOT NULL,           -- fecha y hora local de inicio, YYYY-MM-DDTHHMM
  inicio_programado  TIMESTAMPTZ NOT NULL,
  fin_programado     TIMESTAMPTZ NOT NULL,
  intervalo_ms       INTEGER     NOT NULL,
  estado             VARCHAR(10) NOT NULL DEFAULT 'en_curso' CHECK (estado IN ('en_curso', 'cerrada')),
  fin_reportado      TIMESTAMPTZ,                    -- el agente avisó que terminó
  reporte            JSONB,                          -- se guarda al cerrar; se recalcula si llegan datos tarde
  reporte_obsoleto   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agente_id, clave)
);
CREATE INDEX IF NOT EXISTS operaciones_inicio_idx ON operaciones (inicio_programado DESC);

-- Cada sonda medida por un agente
CREATE TABLE IF NOT EXISTS muestras (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agente_id       INTEGER     NOT NULL REFERENCES agentes (id) ON DELETE CASCADE,
  operacion_id    INTEGER     NOT NULL REFERENCES operaciones (id) ON DELETE CASCADE,
  uid             VARCHAR(36) NOT NULL,              -- generado por el agente: evita duplicados al reenviar
  ts              TIMESTAMPTZ NOT NULL,
  ok              BOOLEAN     NOT NULL,
  latencia_ms     REAL,
  bytes_enviados  INTEGER     NOT NULL DEFAULT 0,
  bytes_recibidos INTEGER     NOT NULL DEFAULT 0,
  ip              VARCHAR(45),
  asn             INTEGER,
  error           VARCHAR(120),
  UNIQUE (agente_id, uid)
);
CREATE INDEX IF NOT EXISTS muestras_operacion_ts_idx ON muestras (operacion_id, ts);
CREATE INDEX IF NOT EXISTS muestras_sin_asn_idx ON muestras (ip) WHERE asn IS NULL AND ip IS NOT NULL;
CREATE INDEX IF NOT EXISTS muestras_ts_idx ON muestras (ts);

-- Eventos del agente: arranque, inicio/fin de operación, pruebas de velocidad
CREATE TABLE IF NOT EXISTS eventos (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agente_id    INTEGER     NOT NULL REFERENCES agentes (id) ON DELETE CASCADE,
  operacion_id INTEGER     REFERENCES operaciones (id) ON DELETE CASCADE,
  uid          VARCHAR(36) NOT NULL,
  ts           TIMESTAMPTZ NOT NULL,
  tipo         VARCHAR(20) NOT NULL,
  datos        JSONB,
  UNIQUE (agente_id, uid)
);
CREATE INDEX IF NOT EXISTS eventos_operacion_idx ON eventos (operacion_id, ts);
