-- Corre como pages_owner. Son los permisos exactos de pages_app: sin SELECT en allowed_account ni en audit_log, y sin nada
-- sobre dbconnectus.
GRANT SELECT ON connectus_pages.login TO 'pages_app'@'%';
GRANT SELECT ON connectus_pages.login_account TO 'pages_app'@'%';
GRANT SELECT ON connectus_pages.sms TO 'pages_app'@'%';
GRANT SELECT ON connectus_pages.delivery TO 'pages_app'@'%';
GRANT SELECT ON connectus_pages.account TO 'pages_app'@'%';
GRANT UPDATE (failed_attempts, locked_until, last_login_at) ON connectus_pages.login TO 'pages_app'@'%';
GRANT INSERT ON connectus_pages.audit_log TO 'pages_app'@'%';
GRANT EXECUTE ON FUNCTION connectus_pages.sms_cutoff_id TO 'pages_app'@'%';
