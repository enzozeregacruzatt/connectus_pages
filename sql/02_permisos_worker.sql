-- Corre como pages_owner. Son los permisos exactos de pages_worker: nada en login, login_account, allowed_account ni
-- sms_ids_de_envio, y nada sobre dbconnectus.
GRANT SELECT ON connectus_pages.account TO 'pages_worker'@'%';
GRANT SELECT ON connectus_pages.delivery TO 'pages_worker'@'%';
GRANT SELECT ON connectus_pages.sms_de_cuenta TO 'pages_worker'@'%';
GRANT SELECT ON connectus_pages.sms_de_numero TO 'pages_worker'@'%';
GRANT SELECT ON connectus_pages.sms_de_envio TO 'pages_worker'@'%';
GRANT SELECT ON connectus_pages.sms_incoming_de_envio TO 'pages_worker'@'%';
GRANT EXECUTE ON FUNCTION connectus_pages.sms_cutoff_id TO 'pages_worker'@'%';
GRANT EXECUTE ON PROCEDURE connectus_pages.purge_audit_log TO 'pages_worker'@'%';
GRANT INSERT ON connectus_pages.audit_log TO 'pages_worker'@'%';
GRANT SELECT, UPDATE, DELETE ON connectus_pages.export_job TO 'pages_worker'@'%';
-- Solo para borrar fotos viejas: el DELETE necesita leer las columnas de su WHERE, y las fotos no le hacen falta.
GRANT DELETE ON connectus_pages.delivery_stats TO 'pages_worker'@'%';
GRANT SELECT (id_delivery, updated_at) ON connectus_pages.delivery_stats TO 'pages_worker'@'%';
