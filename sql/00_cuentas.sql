-- Corre como master, desde scripts/aprovisionar_bd.sh, que cambia los marcadores de clave en una copia temporal.
-- Van sin comillas: corrido a mano, sin --force, se detiene en un error de sintaxis en vez de crear cuentas con una clave que está
-- en este repo público.

-- Un solo CREATE USER porque en 8.0 es atómico: si una de las dos cuentas ya existe, no se crea ninguna y no queda una
-- cuenta nueva con una clave que nadie guardó.
CREATE USER
  'pages_owner'@'%' IDENTIFIED BY __PW_OWNER__,
  'pages_app'@'%' IDENTIFIED BY __PW_APP__
  REQUIRE SSL;

-- Sin tope de consultas por hora: lo comparte toda la app y un login anónimo gasta 2 sentencias por intento, así que
-- cualquiera lo agotaría y dejaría la app en 503 hasta que se renueve el contador. La carga ya la acotan la concurrencia
-- reservada de la Lambda, las conexiones y MAX_EXECUTION_TIME.
ALTER USER 'pages_app'@'%'
  WITH MAX_USER_CONNECTIONS 8 MAX_CONNECTIONS_PER_HOUR 2000 MAX_QUERIES_PER_HOUR 0;

/*!80021 ALTER USER 'pages_owner'@'%' COMMENT 'DEFINER de las vistas de connectus_pages, queda bloqueada' */;
/*!80021 ALTER USER 'pages_app'@'%' COMMENT 'Lambda de connectus_pages, solo ve ese esquema' */;

-- Permisos directos, no por rol: con activate_all_roles_on_login=0, un DEFINER que dependa de un rol pierde el acceso.
GRANT SELECT (id, id_account, id_delivery, dst_number, sms_content, status, created_at)
  ON dbconnectus.sms_outgoing TO 'pages_owner'@'%';
GRANT SELECT (id, id_account, name) ON dbconnectus.delivery TO 'pages_owner'@'%';
GRANT SELECT (id, name) ON dbconnectus.account TO 'pages_owner'@'%';
GRANT ALL PRIVILEGES ON connectus_pages.* TO 'pages_owner'@'%' WITH GRANT OPTION;
