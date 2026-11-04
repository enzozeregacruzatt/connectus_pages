-- Base dbconnectus falsa para las pruebas de integración. Todos los datos son inventados.
--
-- Solo trae las columnas e índices que usan las vistas, con los mismos tipos y charset que la plataforma, más sum_multiplier_idx,
-- que ninguna vista usa pero compite con el índice del corte por fecha. Así los planes de las pruebas valen para algo, sin que este
-- repo público sirva de mapa de más. Los pocos `id` que ninguna vista pide están porque son la clave primaria.
-- `columna_fuera_del_contrato` es de relleno y no existe en la plataforma: si una vista llegara a exponer más columnas de las
-- permitidas, se nota porque esa aparece o porque pages_owner no puede leerla.
--
-- No lleva DROP de nada que exista antes: si se cargara por error en un servidor que ya tiene dbconnectus, falla en la primera
-- sentencia.
--
-- Contenido:
-- - Cuentas 101 y 102, permitidas por los logins de prueba, y 999, prohibida: nunca debe aparecer en las vistas.
-- - 30.000 SMS, con id de 1 a 30.000 y created_at del 2026-10-01 a la madrugada del 2026-11-01, sin orden estricto respecto
--   del id: hasta 6 horas de desfase entre dos filas, menos que el margen de 1 día de la consulta. Aproximadamente 50 % de
--   la 101, 30 % de la 102 y 20 % de la 999.
-- - Números de 56900000001 a 56900000197, repartidos entre las tres cuentas.
-- - 56900000777: 300 SMS de la 102, entre el 2026-10-16 y el 2026-10-17, para paginar con número.
-- - 56900000999: solo en la cuenta 999.
-- - Estados de cada categoría y fuera de ellas, también nulos, y proveedores y países de cada columna de las tablas de conteo.
-- - Envíos, todos de la 101 salvo donde se indica:
--     1      grande, de más de un tramo, con respuestas de más de un lote, y citado también por filas de otras cuentas.
--     2      mediano, sin nada especial.
--     3      mediano, con links por SMS en más de un tramo, además del link del envío.
--     4, 5   de la 102.
--     6      de la 999, con respuestas y links.
--     7      de la 102, citado por un SMS de la 101.
--     8      chico, con link único y respuestas.
--     9      en curso. 10, fallido con un mensaje de negocio. 11, fallido con el texto de una excepción.
--            Los tres, programados 2 horas antes de la hora fija de las pruebas de la API.
--     12     de otro producto.
--     13     sin deliver_at. 14, sin created_at. 15, con created_at en cero. 16, sin status.
--     17     nuevo y sin base. 18, con base de nombre y contactos nulos. 19, con base de otra cuenta.
--     20     con comodines y HTML en el nombre.
--     101-140  de relleno, para la lista: de a 3 con el mismo created_at, y sin SMS.
-- - Filas especiales: ver las sentencias UPDATE.

SET NAMES utf8mb4;

CREATE DATABASE dbconnectus CHARACTER SET utf8mb3;
USE dbconnectus;

CREATE TABLE account (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(512) DEFAULT NULL,
  columna_fuera_del_contrato VARCHAR(16) DEFAULT 'no debe verse',
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3;

CREATE TABLE contact_list (
  id INT NOT NULL AUTO_INCREMENT,
  id_account INT DEFAULT NULL,
  name VARCHAR(512) DEFAULT NULL,
  number_of_contacts INT DEFAULT NULL,
  columna_fuera_del_contrato VARCHAR(16) DEFAULT 'no debe verse',
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3;

CREATE TABLE delivery (
  id INT NOT NULL AUTO_INCREMENT,
  id_unique VARCHAR(32) NOT NULL,
  id_account INT DEFAULT NULL,
  delivery_type VARCHAR(512) DEFAULT NULL,
  name VARCHAR(512) DEFAULT NULL,
  deliver_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT NULL,
  id_product INT DEFAULT NULL,
  id_contact_list INT DEFAULT NULL,
  status VARCHAR(255) DEFAULT 'new',
  error_status VARCHAR(255) DEFAULT NULL,
  columna_fuera_del_contrato VARCHAR(16) DEFAULT 'no debe verse',
  PRIMARY KEY (id),
  UNIQUE KEY id_unique (id_unique),
  KEY delivery_account_created_idx (id_account, created_at),
  KEY id_account__idx (id_account)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3;

CREATE TABLE sms_outgoing (
  id INT NOT NULL AUTO_INCREMENT,
  id_unique VARCHAR(32) NOT NULL,
  id_account INT DEFAULT NULL,
  id_delivery INT DEFAULT NULL,
  status VARCHAR(512) DEFAULT NULL,
  src_number BIGINT NOT NULL,
  dst_number BIGINT NOT NULL,
  sms_content LONGTEXT,
  multiplier INT DEFAULT NULL,
  created_at DATETIME DEFAULT NULL,
  updated_at DATETIME DEFAULT NULL,
  dst_provider VARCHAR(512) DEFAULT NULL,
  dst_country VARCHAR(512) DEFAULT NULL,
  columna_fuera_del_contrato VARCHAR(16) DEFAULT 'no debe verse',
  PRIMARY KEY (id),
  UNIQUE KEY id_unique (id_unique),
  KEY created_at_idx (created_at),
  KEY sum_multiplier_idx (created_at, multiplier),
  KEY dst_number_idx (dst_number),
  KEY id_account__idx (id_account),
  KEY id_delivery__idx (id_delivery)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3;

CREATE TABLE sms_incoming (
  id INT NOT NULL AUTO_INCREMENT,
  id_unique VARCHAR(32) NOT NULL,
  id_account INT DEFAULT NULL,
  id_delivery INT DEFAULT NULL,
  src_number BIGINT NOT NULL,
  dst_number BIGINT NOT NULL,
  sms_content LONGTEXT,
  created_at DATETIME DEFAULT NULL,
  columna_fuera_del_contrato VARCHAR(16) DEFAULT 'no debe verse',
  PRIMARY KEY (id),
  KEY index_sms_incoming_on_id_delivery (id_delivery)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3;

CREATE TABLE short_link (
  id INT NOT NULL AUTO_INCREMENT,
  id_unique VARCHAR(7) NOT NULL,
  clicks INT DEFAULT NULL,
  columna_fuera_del_contrato VARCHAR(16) DEFAULT 'no debe verse',
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3;

CREATE TABLE short_link_delivery (
  id INT NOT NULL AUTO_INCREMENT,
  id_account INT DEFAULT NULL,
  id_short_link INT DEFAULT NULL,
  id_delivery INT DEFAULT NULL,
  columna_fuera_del_contrato VARCHAR(16) DEFAULT 'no debe verse',
  PRIMARY KEY (id),
  KEY id_delivery__idx (id_delivery)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3;

CREATE TABLE short_link_sms_outgoings (
  id BIGINT NOT NULL AUTO_INCREMENT,
  id_sms_outgoing INT DEFAULT NULL,
  id_short_link INT DEFAULT NULL,
  columna_fuera_del_contrato VARCHAR(16) DEFAULT 'no debe verse',
  PRIMARY KEY (id),
  KEY index_short_link_sms_outgoings_on_id_sms_outgoing (id_sms_outgoing)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

INSERT INTO account (id, name) VALUES
  (101, 'Cuenta de prueba 101'),
  (102, 'Cuenta de prueba 102'),
  (999, 'Cuenta prohibida 999');

INSERT INTO contact_list (id, id_account, name, number_of_contacts) VALUES
  (1, 101, 'Base de prueba 101', 9000),
  (2, 101, 'Base del envío en curso', 100),
  (3, 101, NULL, NULL),
  (4, 999, 'Base prohibida 999', 50),
  (5, 102, 'Base de prueba 102', 5000);

INSERT INTO delivery
  (id, id_unique, id_account, delivery_type, name, deliver_at, created_at, id_product, id_contact_list, status, error_status)
VALUES
  (1, MD5('envio-1'), 101, 'CUSTOM', 'Campaña de prueba 101-A', '2026-10-01 03:00:00', '2026-10-01 02:55:00', 1, 1, 'completed', NULL),
  (2, MD5('envio-2'), 101, 'CUSTOM', 'Campaña de prueba 101-B', '2026-10-01 04:00:00', '2026-10-01 03:55:00', 1, 1, 'completed', NULL),
  (3, MD5('envio-3'), 101, 'PLATFORM', 'Recordatorio de prueba 101', '2026-10-01 05:00:00', '2026-10-01 04:55:00', 1, 1, 'completed', NULL),
  (4, MD5('envio-4'), 102, 'CUSTOM', 'Campaña de prueba 102-A', '2026-10-01 03:00:00', '2026-10-01 02:55:00', 1, 5, 'completed', NULL),
  (5, MD5('envio-5'), 102, 'API', 'Campaña de prueba 102-B', '2026-10-01 04:00:00', '2026-10-01 03:55:00', 1, NULL, 'completed', NULL),
  (6, MD5('envio-6'), 999, 'CUSTOM', 'Campaña prohibida 999', '2026-10-01 03:00:00', '2026-10-01 02:55:00', 1, 4, 'completed', NULL),
  (7, MD5('envio-7'), 102, 'CUSTOM', 'Envío de la 102 citado por la 101', '2026-10-01 05:00:00', '2026-10-01 04:55:00', 1, 5, 'completed', NULL),
  (8, MD5('envio-8'), 101, 'CUSTOM', 'Envío chico con link único', '2026-10-24 09:00:00', '2026-10-24 08:55:00', 1, 1, 'completed', NULL),
  (9, MD5('envio-9'), 101, 'CUSTOM', 'Envío en curso', '2026-11-20 10:00:00', '2026-11-20 09:55:00', 1, 2, 'processing', NULL),
  (10, MD5('envio-10'), 101, 'CUSTOM', 'Envío fallido', '2026-11-20 10:00:00', '2026-11-20 09:50:00', 1, 1, 'failed', 'No hay saldo suficiente para el envío'),
  (11, MD5('envio-11'), 101, 'CUSTOM', 'Envío fallido por una excepción', '2026-11-20 10:00:00', '2026-11-20 09:45:00', 1, 1, 'failed', 'Error al procesar el archivo: detalle interno'),
  (12, MD5('envio-12'), 101, 'CUSTOM', 'Envío de otro producto', '2026-10-24 10:00:00', '2026-10-24 09:55:00', 2, 1, 'completed', NULL),
  (13, MD5('envio-13'), 101, 'API', 'Envío sin fecha programada', NULL, '2026-10-24 10:55:00', 1, NULL, 'completed', NULL),
  (14, MD5('envio-14'), 101, 'CUSTOM', 'Envío sin fecha de creación', '2026-10-24 12:00:00', NULL, 1, 1, 'completed', NULL),
  (16, MD5('envio-16'), 101, 'CUSTOM', 'Envío sin estado', '2026-10-24 14:00:00', '2026-10-24 13:55:00', 1, 1, NULL, NULL),
  (17, MD5('envio-17'), 101, 'CUSTOM', 'Envío nuevo sin base', '2026-10-24 15:00:00', '2026-10-24 14:55:00', 1, NULL, 'new', NULL),
  (18, MD5('envio-18'), 101, 'CUSTOM', 'Envío con base sin nombre', '2026-10-24 16:00:00', '2026-10-24 15:55:00', 1, 3, 'completed', NULL),
  (19, MD5('envio-19'), 101, 'CUSTOM', 'Envío con base de otra cuenta', '2026-10-24 17:00:00', '2026-10-24 16:55:00', 1, 4, 'completed', NULL),
  (20, MD5('envio-20'), 101, 'CUSTOM', 'Promo 100% _especial_ <b>ñandú</b>', '2026-10-24 18:00:00', '2026-10-24 17:55:00', 1, 1, 'completed', NULL);

-- El modo por defecto rechaza una fecha en cero: se relaja solo para esta fila.
SET SESSION sql_mode = '';
INSERT INTO delivery (id, id_unique, id_account, delivery_type, name, deliver_at, created_at, id_product, id_contact_list, status) VALUES
  (15, MD5('envio-15'), 101, 'CUSTOM', 'Envío con fecha de creación en cero', '2026-10-24 13:00:00', '0000-00-00 00:00:00', 1, 1, 'completed');
SET SESSION sql_mode = DEFAULT;

-- Tabla normal y no TEMPORARY, porque MySQL no deja nombrar una temporal más de una vez en la misma consulta.
CREATE TABLE fixture_digit (d INT NOT NULL PRIMARY KEY) ENGINE=InnoDB;
INSERT INTO fixture_digit (d) VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9);

INSERT INTO delivery (id, id_unique, id_account, delivery_type, name, deliver_at, created_at, id_product, status)
SELECT
  100 + n,
  MD5(CONCAT('envio-', 100 + n)),
  101,
  ELT(1 + n % 3, 'CUSTOM', 'PLATFORM', 'API'),
  CONCAT('Envío de relleno ', n),
  '2026-10-02 12:00:00' + INTERVAL (n - n % 3) HOUR,
  '2026-10-02 11:00:00' + INTERVAL (n - n % 3) HOUR,
  1,
  'completed'
FROM (SELECT a.d + 10 * b.d + 1 AS n FROM fixture_digit a CROSS JOIN fixture_digit b) numbers
WHERE n <= 40;

-- Módulos primos en dst_number, status, proveedor y país, para que no queden atados a la cuenta, que depende de n % 10.
INSERT INTO sms_outgoing (
  id, id_unique, id_account, id_delivery, status, src_number, dst_number, sms_content, multiplier, created_at, updated_at,
  dst_provider, dst_country
)
SELECT
  n,
  MD5(CONCAT('sms-', n)),
  CASE WHEN n % 10 < 5 THEN 101 WHEN n % 10 < 8 THEN 102 ELSE 999 END,
  CASE
    WHEN n % 7 = 0 THEN NULL
    WHEN n % 10 < 5 THEN CASE WHEN n % 3 = 0 THEN 3 WHEN n % 3 = 1 OR n % 2 = 0 THEN 1 ELSE 2 END
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
    WHEN 9 THEN 'ESME_RINVDSTADR'
    WHEN 10 THEN 'EXPIRED'
    ELSE 'DELIVRD'
  END,
  1000 + n % 2,
  56900000001 + n % 197,
  CONCAT('Mensaje de prueba ', n),
  1 + (n % 17 = 0),
  '2026-10-01 03:00:00' + INTERVAL (n * 89 + (n * 7919) % 21600 - 10800) SECOND,
  '2026-10-01 03:00:00' + INTERVAL (n * 89 + (n * 7919) % 21600 - 10800 + 60) SECOND,
  CASE n % 11
    WHEN 0 THEN 'Movistar'
    WHEN 1 THEN 'Entel'
    WHEN 2 THEN 'Claro'
    WHEN 3 THEN 'Wom'
    WHEN 4 THEN 'VTR'
    WHEN 5 THEN 'Virgin'
    WHEN 6 THEN 'Otros'
    WHEN 7 THEN 'Proveedor nuevo'
    WHEN 8 THEN NULL
    ELSE 'Entel'
  END,
  CASE n % 13
    WHEN 0 THEN 'Peru'
    WHEN 1 THEN 'Colombia'
    WHEN 2 THEN 'Mexico'
    WHEN 3 THEN 'Brasil'
    WHEN 4 THEN 'Argentina'
    WHEN 5 THEN 'Estados Unidos'
    WHEN 6 THEN NULL
    ELSE 'Chile'
  END
FROM (
  SELECT a.d + 10 * b.d + 100 * c.d + 1000 * e.d + 10000 * f.d + 1 AS n
  FROM fixture_digit a
  CROSS JOIN fixture_digit b
  CROSS JOIN fixture_digit c
  CROSS JOIN fixture_digit e
  CROSS JOIN fixture_digit f
) numbers
WHERE n <= 30000;

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
-- Filas con id_delivery de un envío de la 101 e id_account de otra cuenta: las vistas que devuelven datos no las muestran con la 101.
UPDATE sms_outgoing SET id_account = 102, id_delivery = 1 WHERE id = 9011;
UPDATE sms_outgoing SET id_account = 999, id_delivery = 1 WHERE id = 9012;
UPDATE sms_outgoing SET dst_number = 56900000777 WHERE id_account = 102 AND id BETWEEN 15000 AND 15999;

-- Los envíos chicos toman filas de la 101, para no mover el rango de fechas de las demás pruebas.
UPDATE sms_outgoing SET id_delivery = 8 WHERE id_account = 101 AND id BETWEEN 20000 AND 20039;
UPDATE sms_outgoing SET id_delivery = 9 WHERE id_account = 101 AND id BETWEEN 20100 AND 20119;
UPDATE sms_outgoing SET id_delivery = 10 WHERE id_account = 101 AND id BETWEEN 20200 AND 20209;
UPDATE sms_outgoing SET id_delivery = 12 WHERE id_account = 101 AND id BETWEEN 20300 AND 20339;
UPDATE sms_outgoing SET id_delivery = 13 WHERE id_account = 101 AND id BETWEEN 20400 AND 20439;

-- Respuestas: más de un lote de 2.000 en el envío 1, y las que no se deben ver.
INSERT INTO sms_incoming (id, id_unique, id_account, id_delivery, src_number, dst_number, sms_content, created_at)
SELECT
  n,
  MD5(CONCAT('respuesta-', n)),
  101,
  1,
  56900000001 + n % 197,
  1000 + n % 2,
  CONCAT('Respuesta de prueba ', n),
  '2026-10-02 08:00:00' + INTERVAL n MINUTE
FROM (SELECT a.d + 10 * b.d + 100 * c.d + 1000 * e.d + 1 AS n
      FROM fixture_digit a CROSS JOIN fixture_digit b CROSS JOIN fixture_digit c CROSS JOIN fixture_digit e) numbers
WHERE n <= 2300;

INSERT INTO sms_incoming (id, id_unique, id_account, id_delivery, src_number, dst_number, sms_content, created_at) VALUES
  (5001, MD5('respuesta-5001'), 101, 8, 56900000011, 1000, 'Sí, ¿cuándo?', '2026-10-24 10:00:00'),
  (5002, MD5('respuesta-5002'), 101, 8, 56900000012, 1000, '=1+1', '2026-10-24 10:01:00'),
  (5003, MD5('respuesta-5003'), 101, 8, 56900000013, 1000, '<b>no</b> & "gracias"', '2026-10-24 10:02:00'),
  (5004, MD5('respuesta-5004'), 101, NULL, 56900000014, 1000, 'Respuesta sin envío', '2026-10-24 10:03:00'),
  (5005, MD5('respuesta-5005'), 999, 6, 56900000015, 1000, 'Respuesta prohibida 999', '2026-10-24 10:04:00'),
  (5006, MD5('respuesta-5006'), 999, 6, 56900000016, 1000, 'Respuesta prohibida 999', '2026-10-24 10:05:00'),
  (5007, MD5('respuesta-5007'), 999, 1, 56900000017, 1000, 'Respuesta de la 999 a un envío de la 101', '2026-10-24 10:06:00');

-- Links. El 1, único del envío 8. El 2 y uno por cada SMS, del envío 3. El 3, de la 999. El 4 es de las filas ajenas de más abajo.
INSERT INTO short_link (id, id_unique, clicks) VALUES
  (1, 'lnkuno1', 42),
  (2, 'lnkuno2', 7),
  (3, 'lnkuno3', 99),
  (4, 'lnkuno4', 0);

INSERT INTO short_link_delivery (id_account, id_short_link, id_delivery) VALUES
  (101, 1, 8),
  (101, 2, 3),
  (999, 3, 6);

INSERT INTO short_link (id, id_unique, clicks)
SELECT 1000 + id, LEFT(MD5(CONCAT('link-', id)), 7), id % 5 FROM sms_outgoing WHERE id_delivery = 3;

INSERT INTO short_link_sms_outgoings (id_sms_outgoing, id_short_link)
SELECT id, 1000 + id FROM sms_outgoing WHERE id_delivery = 3;

INSERT INTO short_link_sms_outgoings (id_sms_outgoing, id_short_link)
SELECT id, 3 FROM sms_outgoing WHERE id_delivery = 6 AND id BETWEEN 9005 AND 9010;

-- Filas ajenas, de SMS que no están en este fixture. Con una tabla de unión chica, el optimizador empieza por ella y la recorre
-- entera, un plan que con una tabla grande nunca elegiría.
INSERT INTO short_link_sms_outgoings (id_sms_outgoing, id_short_link)
SELECT 1000000 + n, 4
FROM (
  SELECT a.d + 10 * b.d + 100 * c.d + 1000 * e.d + 10000 * f.d + 1 AS n
  FROM fixture_digit a
  CROSS JOIN fixture_digit b
  CROSS JOIN fixture_digit c
  CROSS JOIN fixture_digit e
  CROSS JOIN fixture_digit f
) numbers
WHERE n <= 21000;

DROP TABLE fixture_digit;

-- Sin estadísticas al día, el optimizador no elige los mismos índices que con una tabla cargada de a poco.
ANALYZE TABLE account, contact_list, delivery, sms_outgoing, sms_incoming, short_link, short_link_delivery, short_link_sms_outgoings;
