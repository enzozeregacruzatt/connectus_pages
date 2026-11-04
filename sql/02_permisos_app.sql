-- Corre como pages_owner. Son los permisos exactos de pages_app: sin SELECT en allowed_account, audit_log ni
-- sms_incoming_de_envio, y sin nada sobre dbconnectus.
GRANT SELECT ON connectus_pages.login TO 'pages_app'@'%';
GRANT SELECT ON connectus_pages.login_account TO 'pages_app'@'%';
GRANT SELECT ON connectus_pages.account TO 'pages_app'@'%';
GRANT SELECT ON connectus_pages.delivery TO 'pages_app'@'%';
GRANT SELECT ON connectus_pages.delivery_datos TO 'pages_app'@'%';
GRANT SELECT ON connectus_pages.sms TO 'pages_app'@'%';
GRANT SELECT ON connectus_pages.sms_de_cuenta TO 'pages_app'@'%';
GRANT SELECT ON connectus_pages.sms_de_numero TO 'pages_app'@'%';
GRANT SELECT ON connectus_pages.sms_de_envio TO 'pages_app'@'%';
GRANT SELECT ON connectus_pages.sms_ids_de_envio TO 'pages_app'@'%';
GRANT SELECT ON connectus_pages.incoming_ids_de_envio TO 'pages_app'@'%';
GRANT SELECT ON connectus_pages.link_de_envio TO 'pages_app'@'%';
GRANT SELECT ON connectus_pages.link_de_sms TO 'pages_app'@'%';
GRANT UPDATE (failed_attempts, locked_until, last_login_at) ON connectus_pages.login TO 'pages_app'@'%';
GRANT INSERT ON connectus_pages.audit_log TO 'pages_app'@'%';
GRANT EXECUTE ON FUNCTION connectus_pages.sms_cutoff_id TO 'pages_app'@'%';
GRANT SELECT, INSERT, UPDATE ON connectus_pages.delivery_stats TO 'pages_app'@'%';
-- Por columna: el estado y el avance de una exportación solo los escribe el trabajador.
GRANT SELECT ON connectus_pages.export_job TO 'pages_app'@'%';
GRANT INSERT (public_id, id_login, id_account, kind, id_delivery, delivery_name, start_date, end_date, dst_number, created_at)
  ON connectus_pages.export_job TO 'pages_app'@'%';
