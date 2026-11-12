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

-- =====================================================================
-- Roles: administrador y soporte técnico (antes "lectura")
-- =====================================================================
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;
UPDATE usuarios SET rol = 'soporte' WHERE rol = 'lectura';
ALTER TABLE usuarios ALTER COLUMN rol SET DEFAULT 'soporte';
ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check CHECK (rol IN ('admin', 'soporte'));

-- =====================================================================
-- Inventario (fase 1: captura manual). Una fila por motocarro.
-- El nombre del motocarro es agentes.nombre. El número de serie del Peplink enlaza con InControl2.
-- =====================================================================
CREATE TABLE IF NOT EXISTS inventario (
  agente_id          INTEGER      PRIMARY KEY REFERENCES agentes (id) ON DELETE CASCADE,
  placa              VARCHAR(20),
  peplink_sn         VARCHAR(40),
  starlink_sn        VARCHAR(60),
  sim1_operador      VARCHAR(40),
  sim1_iccid         VARCHAR(30),
  sim1_imsi          VARCHAR(20),
  sim2_operador      VARCHAR(40),
  sim2_iccid         VARCHAR(30),
  sim2_imsi          VARCHAR(20),
  tablet1_sn         VARCHAR(60),
  tablet2_sn         VARCHAR(60),
  fecha_instalacion  DATE,
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS inventario_peplink_sn_uq ON inventario (upper(peplink_sn)) WHERE peplink_sn IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS inventario_starlink_sn_uq ON inventario (upper(starlink_sn)) WHERE starlink_sn IS NOT NULL;

-- Bitácora: un renglón por cada campo que cambia
CREATE TABLE IF NOT EXISTS inventario_bitacora (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agente_id       INTEGER      NOT NULL REFERENCES agentes (id) ON DELETE CASCADE,
  usuario_id      INTEGER      REFERENCES usuarios (id) ON DELETE SET NULL,
  usuario_nombre  VARCHAR(120) NOT NULL,
  campo           VARCHAR(40)  NOT NULL,
  valor_anterior  TEXT,
  valor_nuevo     TEXT,
  ts              TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventario_bitacora_agente_idx ON inventario_bitacora (agente_id, ts DESC);

-- =====================================================================
-- InControl2 (Peplink). Se llena con la sincronización periódica (src/incontrol/sync.js).
-- =====================================================================
-- Router tal como lo reporta InControl2 (estado actual)
CREATE TABLE IF NOT EXISTS ic2_dispositivos (
  id              INTEGER      PRIMARY KEY,                -- id del dispositivo en InControl2
  grupo_id        INTEGER,
  sn              VARCHAR(40)  NOT NULL,
  nombre          VARCHAR(120),
  modelo          VARCHAR(120),
  firmware        VARCHAR(40),
  estado          VARCHAR(20),                             -- online / offline
  ultima_vez      TIMESTAMPTZ,                             -- last_online
  offline_desde   TIMESTAMPTZ,
  clientes        INTEGER,
  uptime_s        BIGINT,
  latitud         DOUBLE PRECISION,
  longitud        DOUBLE PRECISION,
  ubicacion_ts    TIMESTAMPTZ,
  wan_activa      VARCHAR(80),                             -- nombre de la WAN por la que sale ahora
  actualizado     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ic2_dispositivos_sn_idx ON ic2_dispositivos (upper(sn));

-- Estado actual de cada WAN del router (Starlink, celular…)
CREATE TABLE IF NOT EXISTS ic2_wan (
  dispositivo_id  INTEGER      NOT NULL REFERENCES ic2_dispositivos (id) ON DELETE CASCADE,
  wan_id          INTEGER      NOT NULL,
  nombre          VARCHAR(80),
  tipo            VARCHAR(40),
  celular         BOOLEAN      NOT NULL DEFAULT FALSE,
  estado          VARCHAR(40),                             -- Connected, Disconnected, Standby…
  activa          BOOLEAN,                                 -- is_overall_up
  respaldo        BOOLEAN,                                 -- is_backup
  standby         VARCHAR(40),
  cuota_excedida  BOOLEAN,
  operador        VARCHAR(80),
  tecnologia      VARCHAR(20),
  senal_barras    SMALLINT,
  rssi            REAL,
  sinr            REAL,
  rsrp            REAL,
  rsrq            REAL,
  imei            VARCHAR(20),
  iccid           VARCHAR(30),
  imsi            VARCHAR(20),
  sim_activa      BOOLEAN,
  monitor_cuota   BOOLEAN,
  actualizado     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (dispositivo_id, wan_id)
);

-- Historial de lecturas (una por sincronización y router): base de la línea de tiempo y la trazabilidad
CREATE TABLE IF NOT EXISTS ic2_lecturas (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispositivo_id  INTEGER      NOT NULL REFERENCES ic2_dispositivos (id) ON DELETE CASCADE,
  ts              TIMESTAMPTZ  NOT NULL DEFAULT now(),
  estado          VARCHAR(20),
  wan_activa      VARCHAR(80),
  celular_estado  VARCHAR(40),
  sim_disponible  BOOLEAN,
  senal_barras    SMALLINT,
  rsrp            REAL,
  sinr            REAL,
  latitud         DOUBLE PRECISION,
  longitud        DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS ic2_lecturas_disp_ts_idx ON ic2_lecturas (dispositivo_id, ts DESC);

-- Consumo por hora y por WAN según InControl2 (bandwidth_per_device, type=hourly)
CREATE TABLE IF NOT EXISTS ic2_consumo_horario (
  dispositivo_id  INTEGER      NOT NULL REFERENCES ic2_dispositivos (id) ON DELETE CASCADE,
  hora            TIMESTAMPTZ  NOT NULL,                   -- inicio de la hora (UTC)
  wan_id          INTEGER      NOT NULL,
  wan_nombre      VARCHAR(80),
  celular         BOOLEAN      NOT NULL DEFAULT FALSE,
  bytes_subida    BIGINT       NOT NULL DEFAULT 0,
  bytes_bajada    BIGINT       NOT NULL DEFAULT 0,
  bytes_total     BIGINT       NOT NULL DEFAULT 0,          -- subida + bajada (o el total si InControl2 no las separa)
  actualizado     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (dispositivo_id, hora, wan_id)
);
CREATE INDEX IF NOT EXISTS ic2_consumo_hora_idx ON ic2_consumo_horario (hora);

-- Consumo por hora de cada SIM (identificada por IMSI) según InControl2 (sim_usages/hourly)
CREATE TABLE IF NOT EXISTS ic2_consumo_sim_horario (
  dispositivo_id  INTEGER      NOT NULL REFERENCES ic2_dispositivos (id) ON DELETE CASCADE,
  hora            TIMESTAMPTZ  NOT NULL,
  imsi            VARCHAR(20)  NOT NULL,
  bytes           BIGINT       NOT NULL DEFAULT 0,
  actualizado     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (dispositivo_id, hora, imsi)
);

-- Consumo de los sondeos del portal por hora (se conserva aunque se depuren las muestras crudas)
CREATE TABLE IF NOT EXISTS sondas_horario (
  agente_id       INTEGER      NOT NULL REFERENCES agentes (id) ON DELETE CASCADE,
  hora            TIMESTAMPTZ  NOT NULL,
  bytes_sim       BIGINT       NOT NULL DEFAULT 0,         -- sondas + pruebas de velocidad por red redundante (SIM)
  bytes_total     BIGINT       NOT NULL DEFAULT 0,
  segundos_sim    INTEGER      NOT NULL DEFAULT 0,         -- tiempo midiendo por SIM (failover)
  segundos_medidos INTEGER     NOT NULL DEFAULT 0,
  actualizado     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (agente_id, hora)
);

-- Bitácora de la sincronización y última respuesta cruda de cada endpoint (para diagnóstico)
CREATE TABLE IF NOT EXISTS ic2_sync (
  endpoint        VARCHAR(60)  PRIMARY KEY,
  ultimo_intento  TIMESTAMPTZ,
  ultimo_ok       TIMESTAMPTZ,
  error           VARCHAR(500),
  muestra         JSONB
);

-- =====================================================================
-- Flotas: agrupan motocarros dentro de la plataforma (no se sincroniza con InControl2)
-- =====================================================================
CREATE TABLE IF NOT EXISTS flotas (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre      VARCHAR(60)  NOT NULL,
  notas       VARCHAR(300),
  activa      BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS flotas_nombre_uq ON flotas (lower(nombre));
ALTER TABLE agentes ADD COLUMN IF NOT EXISTS flota_id INTEGER REFERENCES flotas (id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS agentes_flota_idx ON agentes (flota_id);

-- La primera vez: crea una flota y le asigna los motocarros que ya existían
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM flotas) THEN
    INSERT INTO flotas (nombre) VALUES ('Flota principal');
  END IF;
  UPDATE agentes SET flota_id = (SELECT min(id) FROM flotas) WHERE flota_id IS NULL;
END $$;
