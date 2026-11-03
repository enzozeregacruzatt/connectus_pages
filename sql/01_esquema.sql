-- Corre como pages_owner: así queda de DEFINER sin que el master necesite SET_USER_ID para nombrarla.
-- La función y el trigger no necesitan log_bin_trust_function_creators con el binlog apagado, que este SQL asume.

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

-- MERGE es obligatorio: sobre una tabla tan grande, una vista materializada haría inservible la consulta.
CREATE ALGORITHM=MERGE DEFINER=CURRENT_USER SQL SECURITY DEFINER VIEW connectus_pages.sms AS
  SELECT s.id, s.id_account, s.id_delivery, s.dst_number, s.sms_content, s.status, s.created_at
  FROM dbconnectus.sms_outgoing s
  JOIN connectus_pages.allowed_account a ON a.id_account = s.id_account;

CREATE ALGORITHM=MERGE DEFINER=CURRENT_USER SQL SECURITY DEFINER VIEW connectus_pages.delivery AS
  SELECT d.id, d.id_account, d.name
  FROM dbconnectus.delivery d
  JOIN connectus_pages.allowed_account a ON a.id_account = d.id_account;

CREATE ALGORITHM=MERGE DEFINER=CURRENT_USER SQL SECURITY DEFINER VIEW connectus_pages.account AS
  SELECT c.id, c.name
  FROM dbconnectus.account c
  JOIN connectus_pages.allowed_account a ON a.id_account = c.id;

CREATE DEFINER=CURRENT_USER FUNCTION connectus_pages.sms_cutoff_id(p_before DATETIME) RETURNS BIGINT
  READS SQL DATA
  SQL SECURITY DEFINER
  RETURN COALESCE(
    (SELECT id FROM dbconnectus.sms_outgoing WHERE created_at < p_before ORDER BY created_at DESC, id DESC LIMIT 1),
    0
  );
