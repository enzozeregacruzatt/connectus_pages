-- Corre como pages_owner: así queda de DEFINER sin que el master necesite SET_USER_ID para nombrarla.
-- Las rutinas y el trigger no necesitan log_bin_trust_function_creators con el binlog apagado, que este SQL asume.

SET NAMES utf8mb4;

-- La intercalación se fija para que usuarios y comparaciones se comporten igual en 5.7 (pruebas) y en 8.0 (producción),
-- que tienen defaults distintos.
CREATE DATABASE connectus_pages CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE connectus_pages.login (
  id INT NOT NULL AUTO_INCREMENT,
  username VARCHAR(64) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  token_version INT NOT NULL DEFAULT 0,
  link_version INT NOT NULL DEFAULT 0,
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until DATETIME NULL,
  last_login_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY login_username_idx (username)
) ENGINE=InnoDB;

-- Cambiar una clave con UPDATE invalida los tokens ya emitidos, sin depender de que alguien se acuerde de subir la versión.
CREATE DEFINER=CURRENT_USER TRIGGER connectus_pages.login_password_changed
  BEFORE UPDATE ON connectus_pages.login
  FOR EACH ROW
  SET NEW.token_version = IF(NEW.password_hash <> OLD.password_hash, OLD.token_version + 1, NEW.token_version);

CREATE TABLE connectus_pages.allowed_account (
  id_account INT NOT NULL,
  PRIMARY KEY (id_account)
) ENGINE=InnoDB;

CREATE TABLE connectus_pages.login_account (
  id_login INT NOT NULL,
  id_account INT NOT NULL,
  PRIMARY KEY (id_login, id_account),
  KEY login_account_id_account_idx (id_account),
  CONSTRAINT login_account_login_fk FOREIGN KEY (id_login) REFERENCES connectus_pages.login (id),
  CONSTRAINT login_account_allowed_fk FOREIGN KEY (id_account) REFERENCES connectus_pages.allowed_account (id_account)
) ENGINE=InnoDB;

CREATE TABLE connectus_pages.audit_log (
  id BIGINT NOT NULL AUTO_INCREMENT,
  id_login INT NULL,
  action VARCHAR(32) NOT NULL,
  id_account INT NULL,
  detail VARCHAR(255) NULL,
  ip VARCHAR(45) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY audit_log_created_at_idx (created_at)
) ENGINE=InnoDB;

CREATE TABLE connectus_pages.delivery_stats (
  id_delivery INT NOT NULL,
  id_account INT NOT NULL,
  counts JSON NULL,                 -- foto publicada: [{status, provider, country, n}], n numérico
  links_distinct INT NULL,
  clicks_sum BIGINT NULL,
  counted_at DATETIME NULL,         -- UTC, hora de inicio del cálculo de la foto
  work_phase ENUM('idle','counts','links') NOT NULL DEFAULT 'idle',
  work_counts JSON NULL,
  work_links_distinct INT NULL,
  work_clicks_sum BIGINT NULL,
  work_last_id INT NOT NULL DEFAULT 0,
  work_rows INT NOT NULL DEFAULT 0,
  work_step INT NOT NULL DEFAULT 5000,
  work_started_at DATETIME NULL,    -- UTC
  next_step_at DATETIME(3) NOT NULL,
  failed_at DATETIME NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id_delivery),
  KEY delivery_stats_updated_idx (updated_at)
) ENGINE=InnoDB;

CREATE TABLE connectus_pages.export_job (
  id BIGINT NOT NULL AUTO_INCREMENT,
  public_id CHAR(32) NOT NULL,      -- lo único que ve el cliente: crypto.randomBytes(16).toString('hex')
  id_login INT NOT NULL,
  id_account INT NOT NULL,
  kind ENUM('sms_csv','delivery_xlsx','incoming_xlsx') NOT NULL,
  id_delivery INT NULL,
  delivery_name VARCHAR(512) NULL,
  start_date DATE NULL,
  end_date DATE NULL,
  dst_number BIGINT NULL,
  state ENUM('new','processing','finished','failed') NOT NULL DEFAULT 'new',
  lo BIGINT NULL,
  hi BIGINT NULL,
  last_id BIGINT NOT NULL DEFAULT 0,
  rows_written INT NOT NULL DEFAULT 0,
  plain_bytes BIGINT NOT NULL DEFAULT 0,
  file_bytes BIGINT NOT NULL DEFAULT 0,
  crc32 INT UNSIGNED NOT NULL DEFAULT 0,
  storage_key VARCHAR(128) NULL,
  upload_id VARCHAR(1024) NULL,
  next_part INT NOT NULL DEFAULT 1,
  batch_size INT NOT NULL DEFAULT 2000,
  work_ms BIGINT NOT NULL DEFAULT 0,
  stalls INT NOT NULL DEFAULT 0,
  error_code VARCHAR(32) NULL,
  created_at DATETIME NOT NULL,     -- UTC
  finished_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY export_job_public_idx (public_id),
  KEY export_job_login_idx (id_login, id),
  KEY export_job_state_idx (state, id),
  KEY export_job_created_idx (created_at)
) ENGINE=InnoDB;

-- MERGE es obligatorio: sobre una tabla tan grande, una vista materializada haría inservible la consulta.
--
-- El índice va fijado en la definición de la vista, y cada consulta elige la vista según su filtro: así el costo queda acotado por
-- las filas de esa cuenta, ese número o ese envío, y no depende de lo que decida el optimizador de cada versión. Un hint desde
-- afuera de la vista no llega a la tabla de adentro. Si alguien borra uno de estos índices, la vista falla con el error 1176.

CREATE ALGORITHM=MERGE DEFINER=CURRENT_USER SQL SECURITY DEFINER VIEW connectus_pages.sms_de_cuenta AS
  SELECT s.id, s.id_unique, s.id_account, s.id_delivery, s.src_number, s.dst_number, s.sms_content,
         s.status, s.dst_provider, s.created_at
  FROM dbconnectus.sms_outgoing s FORCE INDEX (id_account__idx)
  JOIN connectus_pages.allowed_account a ON a.id_account = s.id_account;

CREATE ALGORITHM=MERGE DEFINER=CURRENT_USER SQL SECURITY DEFINER VIEW connectus_pages.sms_de_numero AS
  SELECT s.id, s.id_unique, s.id_account, s.id_delivery, s.src_number, s.dst_number, s.sms_content,
         s.status, s.dst_provider, s.dst_country, s.created_at, s.updated_at
  FROM dbconnectus.sms_outgoing s FORCE INDEX (dst_number_idx)
  JOIN connectus_pages.allowed_account a ON a.id_account = s.id_account;

CREATE ALGORITHM=MERGE DEFINER=CURRENT_USER SQL SECURITY DEFINER VIEW connectus_pages.sms_de_envio AS
  SELECT s.id, s.id_unique, s.id_account, s.id_delivery, s.src_number, s.dst_number, s.sms_content,
         s.multiplier, s.status, s.dst_provider, s.dst_country, s.created_at, s.updated_at
  FROM dbconnectus.sms_outgoing s FORCE INDEX (id_delivery__idx)
  JOIN connectus_pages.allowed_account a ON a.id_account = s.id_account;

-- Para leer un SMS por id_unique: ahí el índice único gana solo.
CREATE ALGORITHM=MERGE DEFINER=CURRENT_USER SQL SECURITY DEFINER VIEW connectus_pages.sms AS
  SELECT s.id, s.id_unique, s.id_account, s.id_delivery, s.status, s.src_number, s.dst_number, s.sms_content,
         s.multiplier, s.created_at, s.updated_at, s.dst_provider, s.dst_country
  FROM dbconnectus.sms_outgoing s
  JOIN connectus_pages.allowed_account a ON a.id_account = s.id_account;

-- Esta vista, incoming_ids_de_envio y link_de_sms acotan por la cuenta del envío y no por la de cada fila: pedir la cuenta de la
-- fila obligaría a leerla, y el índice ya no cubriría la consulta. No devuelven datos de la fila, solo sirven para contar.
CREATE ALGORITHM=MERGE DEFINER=CURRENT_USER SQL SECURITY DEFINER VIEW connectus_pages.sms_ids_de_envio AS
  SELECT s.id, s.id_delivery
  FROM dbconnectus.delivery d
  JOIN connectus_pages.allowed_account a ON a.id_account = d.id_account
  JOIN dbconnectus.sms_outgoing s ON s.id_delivery = d.id;

CREATE ALGORITHM=MERGE DEFINER=CURRENT_USER SQL SECURITY DEFINER VIEW connectus_pages.delivery AS
  SELECT d.id, d.id_unique, d.id_account, d.id_product, d.delivery_type, d.name, d.deliver_at, d.created_at
  FROM dbconnectus.delivery d
  JOIN connectus_pages.allowed_account a ON a.id_account = d.id_account;

-- El motivo de un fallo se muestra si es un mensaje de negocio, y no si trae el texto de una excepción. has_base va aparte porque
-- el nombre y los contactos de la base admiten nulos, y no sirven para saber si tiene una.
CREATE ALGORITHM=MERGE DEFINER=CURRENT_USER SQL SECURITY DEFINER VIEW connectus_pages.delivery_datos AS
  SELECT d.id, d.id_unique, d.id_account, d.id_product, d.delivery_type, d.name, d.deliver_at, d.created_at, d.status,
         CASE WHEN d.error_status LIKE 'Error al procesar%' THEN NULL ELSE d.error_status END AS error_status,
         c.id IS NOT NULL AS has_base,
         c.name AS contact_list_name, c.number_of_contacts
  FROM dbconnectus.delivery d
  JOIN connectus_pages.allowed_account a ON a.id_account = d.id_account
  LEFT JOIN dbconnectus.contact_list c ON c.id = d.id_contact_list AND c.id_account = d.id_account;

CREATE ALGORITHM=MERGE DEFINER=CURRENT_USER SQL SECURITY DEFINER VIEW connectus_pages.account AS
  SELECT c.id, c.name
  FROM dbconnectus.account c
  JOIN connectus_pages.allowed_account a ON a.id_account = c.id;

CREATE ALGORITHM=MERGE DEFINER=CURRENT_USER SQL SECURITY DEFINER VIEW connectus_pages.sms_incoming_de_envio AS
  SELECT i.id, i.id_unique, i.id_account, i.id_delivery, i.src_number, i.dst_number, i.sms_content, i.created_at
  FROM dbconnectus.sms_incoming i FORCE INDEX (index_sms_incoming_on_id_delivery)
  JOIN connectus_pages.allowed_account a ON a.id_account = i.id_account;

CREATE ALGORITHM=MERGE DEFINER=CURRENT_USER SQL SECURITY DEFINER VIEW connectus_pages.incoming_ids_de_envio AS
  SELECT i.id, i.id_delivery
  FROM dbconnectus.delivery d
  JOIN connectus_pages.allowed_account a ON a.id_account = d.id_account
  JOIN dbconnectus.sms_incoming i ON i.id_delivery = d.id;

CREATE ALGORITHM=MERGE DEFINER=CURRENT_USER SQL SECURITY DEFINER VIEW connectus_pages.link_de_envio AS
  SELECT sd.id_delivery, sd.id_account, l.id_unique, l.clicks
  FROM dbconnectus.short_link_delivery sd FORCE INDEX (id_delivery__idx)
  JOIN connectus_pages.allowed_account a ON a.id_account = sd.id_account
  JOIN dbconnectus.short_link l ON l.id = sd.id_short_link;

CREATE ALGORITHM=MERGE DEFINER=CURRENT_USER SQL SECURITY DEFINER VIEW connectus_pages.link_de_sms AS
  SELECT s.id_delivery, s.id AS id_sms, l.id AS id_short_link, l.clicks
  FROM dbconnectus.delivery d
  JOIN connectus_pages.allowed_account a ON a.id_account = d.id_account
  JOIN dbconnectus.sms_outgoing s ON s.id_delivery = d.id
  JOIN dbconnectus.short_link_sms_outgoings x ON x.id_sms_outgoing = s.id
  JOIN dbconnectus.short_link l ON l.id = x.id_short_link;

CREATE DEFINER=CURRENT_USER FUNCTION connectus_pages.sms_cutoff_id(p_before DATETIME) RETURNS BIGINT
  READS SQL DATA
  SQL SECURITY DEFINER
  RETURN COALESCE(
    (SELECT id FROM dbconnectus.sms_outgoing WHERE created_at < p_before ORDER BY created_at DESC, id DESC LIMIT 1),
    0
  );

-- Es lo único con lo que el trabajador toca audit_log más allá del INSERT.
CREATE DEFINER=CURRENT_USER PROCEDURE connectus_pages.purge_audit_log()
  MODIFIES SQL DATA
  SQL SECURITY DEFINER
  DELETE FROM connectus_pages.audit_log WHERE created_at < UTC_TIMESTAMP() - INTERVAL 1 YEAR ORDER BY created_at LIMIT 1000;
