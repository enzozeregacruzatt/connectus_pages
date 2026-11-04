-- Corre como master, desde scripts/aprovisionar_bd.sh, que cambia los marcadores de clave en una copia temporal.
-- Van sin comillas: corrido a mano, sin --force, se detiene en un error de sintaxis en vez de crear cuentas con una clave que está
-- en este repo público.

-- Un solo CREATE USER porque en 8.0 es atómico: si una de las tres cuentas ya existe, no se crea ninguna y no queda una
-- cuenta nueva con una clave que nadie guardó.
CREATE USER
  'pages_owner'@'%' IDENTIFIED BY __PW_OWNER__,
  'pages_app'@'%' IDENTIFIED BY __PW_APP__,
  'pages_worker'@'%' IDENTIFIED BY __PW_WORKER__
  REQUIRE SSL;

-- Sin tope de consultas por hora: lo comparte toda la app y un login anónimo gasta 2 sentencias por intento, así que
-- cualquiera lo agotaría y dejaría la app en 503 hasta que se renueve el contador. La carga ya la acotan la concurrencia
-- reservada de la Lambda, las conexiones y MAX_EXECUTION_TIME.
ALTER USER 'pages_app'@'%'
  WITH MAX_USER_CONNECTIONS 8 MAX_CONNECTIONS_PER_HOUR 2000 MAX_QUERIES_PER_HOUR 0;

ALTER USER 'pages_worker'@'%' WITH MAX_USER_CONNECTIONS 2;

/*!80021 ALTER USER 'pages_owner'@'%' COMMENT 'DEFINER de las vistas de connectus_pages, queda bloqueada' */;
/*!80021 ALTER USER 'pages_app'@'%' COMMENT 'Lambda de connectus_pages, solo ve ese esquema' */;
/*!80021 ALTER USER 'pages_worker'@'%' COMMENT 'Trabajador de exportaciones de connectus_pages, solo ve ese esquema' */;

-- Permisos directos, no por rol: con activate_all_roles_on_login=0, un DEFINER que dependa de un rol pierde el acceso.
-- Por columna: lo que ninguna vista necesita, pages_owner tampoco lo puede leer.
GRANT SELECT (id, id_unique, id_account, id_delivery, status, src_number, dst_number, sms_content, multiplier, created_at, updated_at,
              dst_provider, dst_country)
  ON dbconnectus.sms_outgoing TO 'pages_owner'@'%';
GRANT SELECT (id, id_unique, id_account, id_product, id_contact_list, delivery_type, name, deliver_at, created_at, status, error_status)
  ON dbconnectus.delivery TO 'pages_owner'@'%';
GRANT SELECT (id, name) ON dbconnectus.account TO 'pages_owner'@'%';
GRANT SELECT (id, id_account, name, number_of_contacts) ON dbconnectus.contact_list TO 'pages_owner'@'%';
GRANT SELECT (id, id_unique, id_account, id_delivery, src_number, dst_number, sms_content, created_at)
  ON dbconnectus.sms_incoming TO 'pages_owner'@'%';
GRANT SELECT (id_account, id_delivery, id_short_link) ON dbconnectus.short_link_delivery TO 'pages_owner'@'%';
GRANT SELECT (id, id_unique, clicks) ON dbconnectus.short_link TO 'pages_owner'@'%';
GRANT SELECT (id_sms_outgoing, id_short_link) ON dbconnectus.short_link_sms_outgoings TO 'pages_owner'@'%';
GRANT ALL PRIVILEGES ON connectus_pages.* TO 'pages_owner'@'%' WITH GRANT OPTION;
