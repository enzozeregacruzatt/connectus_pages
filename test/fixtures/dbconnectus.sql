-- Base dbconnectus falsa para las pruebas de integración. Todos los datos son inventados.
--
-- Solo trae las columnas e índices que usa la consulta, con los mismos tipos y charset que la plataforma, para que este repo
-- público no sirva de mapa de su esquema. `columna_fuera_del_contrato` es de relleno y no existe en la plataforma: si una vista
-- llegara a exponer más columnas de las permitidas, se nota porque esa aparece o porque pages_owner no puede leerla.
--
-- No lleva DROP a propósito: si se cargara por error en un servidor que ya tiene dbconnectus, falla en la primera sentencia.
--
-- Contenido:
-- - Cuentas 101 y 102, permitidas por los logins de prueba, y 999, prohibida: nunca debe aparecer en las vistas.
-- - 30.000 SMS, con id de 1 a 30.000 y created_at del 2026-10-01 a la madrugada del 2026-11-01, sin orden estricto respecto
--   del id: hasta 6 horas de desfase entre dos filas, menos que el margen de 1 día de la consulta. Aproximadamente 50 % de
--   la 101, 30 % de la 102 y 20 % de la 999.
-- - Números de 56900000001 a 56900000197, repartidos entre las tres cuentas.
-- - 56900000777: 300 SMS de la 102, entre el 2026-10-16 y el 2026-10-17, para paginar con número.
-- - 56900000999: solo en la cuenta 999.
-- - Filas especiales: ver las sentencias UPDATE del final.

SET NAMES utf8mb4;

CREATE DATABASE dbconnectus CHARACTER SET utf8mb3;
USE dbconnectus;

CREATE TABLE account (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(512) DEFAULT NULL,
  columna_fuera_del_contrato VARCHAR(16) DEFAULT 'no debe verse',
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3;

CREATE TABLE delivery (
  id INT NOT NULL AUTO_INCREMENT,
  id_account INT DEFAULT NULL,
  name VARCHAR(512) DEFAULT NULL,
  columna_fuera_del_contrato VARCHAR(16) DEFAULT 'no debe verse',
  PRIMARY KEY (id),
  KEY id_account__idx (id_account)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3;

CREATE TABLE sms_outgoing (
  id INT NOT NULL AUTO_INCREMENT,
  id_account INT DEFAULT NULL,
  id_delivery INT DEFAULT NULL,
  status VARCHAR(512) DEFAULT NULL,
  dst_number BIGINT NOT NULL,
  sms_content LONGTEXT,
  created_at DATETIME DEFAULT NULL,
  columna_fuera_del_contrato VARCHAR(16) DEFAULT 'no debe verse',
  PRIMARY KEY (id),
  KEY created_at_idx (created_at),
  KEY dst_number_idx (dst_number),
  KEY id_account__idx (id_account)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3;

INSERT INTO account (id, name) VALUES
  (101, 'Cuenta de prueba 101'),
  (102, 'Cuenta de prueba 102'),
  (999, 'Cuenta prohibida 999');

INSERT INTO delivery (id, id_account, name) VALUES
  (1, 101, 'Campaña de prueba 101-A'),
  (2, 101, 'Campaña de prueba 101-B'),
  (3, 101, 'Recordatorio de prueba 101'),
  (4, 102, 'Campaña de prueba 102-A'),
  (5, 102, 'Campaña de prueba 102-B'),
  (6, 999, 'Campaña prohibida 999'),
  (7, 102, 'Envío de la 102 citado por la 101');

-- Tabla normal y no TEMPORARY, porque MySQL no deja nombrar una temporal más de una vez en la misma consulta.
CREATE TABLE fixture_digit (d INT NOT NULL PRIMARY KEY) ENGINE=InnoDB;
INSERT INTO fixture_digit (d) VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9);

-- Módulos primos en dst_number y status, para que no queden atados a la cuenta, que depende de n % 10.
INSERT INTO sms_outgoing (id, id_account, id_delivery, status, dst_number, sms_content, created_at)
SELECT
  n,
  CASE WHEN n % 10 < 5 THEN 101 WHEN n % 10 < 8 THEN 102 ELSE 999 END,
  CASE
    WHEN n % 7 = 0 THEN NULL
    WHEN n % 10 < 5 THEN 1 + n % 3
    WHEN n % 10 < 8 THEN 4 + n % 2
    ELSE 6
  END,
  CASE n % 23
    WHEN 0 THEN 'NEW'
    WHEN 1 THEN 'UNDELIV'
    WHEN 2 THEN 'SENT_TO_ESME'
    WHEN 3 THEN 'ESME_ROK'
    WHEN 4 THEN 'QUEUED'
    WHEN 5 THEN 'OUTBALANCE'
    WHEN 6 THEN 'ESME_RTHROTTLED'
    WHEN 7 THEN NULL
    WHEN 8 THEN 'ESTADO_DESCONOCIDO'
    ELSE 'DELIVRD'
  END,
  56900000001 + n % 197,
  CONCAT('Mensaje de prueba ', n),
  '2026-10-01 03:00:00' + INTERVAL (n * 89 + (n * 7919) % 21600 - 10800) SECOND
FROM (
  SELECT a.d + 10 * b.d + 100 * c.d + 1000 * e.d + 10000 * f.d + 1 AS n
  FROM fixture_digit a
  CROSS JOIN fixture_digit b
  CROSS JOIN fixture_digit c
  CROSS JOIN fixture_digit e
  CROSS JOIN fixture_digit f
) numbers
WHERE n <= 30000;

DROP TABLE fixture_digit;

-- Contenido que no se debe interpretar: acentos y HTML.
UPDATE sms_outgoing SET id_account = 101, id_delivery = 1, status = 'DELIVRD', dst_number = 56900000002,
  sms_content = 'Campaña con acentos: ¿qué tal, canción?' WHERE id = 9000;
UPDATE sms_outgoing SET id_account = 101, id_delivery = 1, status = 'DELIVRD', dst_number = 56900000002,
  sms_content = '<script>alert(1)</script> & "comillas"' WHERE id = 9001;
-- Un SMS de la 101 que cita un envío de la 102: el nombre no debe aparecer al pedirlo con id_account = 101.
UPDATE sms_outgoing SET id_account = 101, id_delivery = 7, status = 'DELIVRD', dst_number = 56900000003 WHERE id = 9002;
-- Nulos que la columna admite: no deben aparecer en una búsqueda.
UPDATE sms_outgoing SET id_account = NULL, id_delivery = NULL WHERE id = 9003;
UPDATE sms_outgoing SET id_account = 101, id_delivery = NULL, created_at = NULL WHERE id = 9004;
UPDATE sms_outgoing SET id_account = 999, id_delivery = 6, dst_number = 56900000999 WHERE id BETWEEN 9005 AND 9010;
UPDATE sms_outgoing SET dst_number = 56900000777 WHERE id_account = 102 AND id BETWEEN 15000 AND 15999;

-- Sin estadísticas al día, el optimizador no elige los mismos índices que con una tabla cargada de a poco.
ANALYZE TABLE account, delivery, sms_outgoing;
