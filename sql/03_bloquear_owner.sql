-- Corre como master. Un DEFINER bloqueado sigue funcionando: lo que se bloquea es entrar con esta cuenta.
ALTER USER 'pages_owner'@'%' ACCOUNT LOCK;
