#!/usr/bin/env bash
# Aprovisiona connectus_pages: 00 y 03 corren como master; 01 y 02, como pages_owner.
#
# Entorno:
#   MYSQL             cliente mysql. Por defecto, el del PATH.
#   MYSQL_ADMIN_ARGS  cómo conectar como master, por ejemplo: -u <master> -p
#                     Con -p, mysql pide la clave dos veces: en el paso 00 y en el 03. Solo admite -u, --user=, -p y --password,
#                     sin la clave; cualquier otro argumento termina con error.
#   MYSQL_HOST_ARGS   host, puerto y TLS, por ejemplo: -h <endpoint> -P 3306 --ssl-mode=VERIFY_IDENTITY --ssl-ca=<ca.pem>
#                     No hay host por defecto. Exige --ssl-mode=VERIFY_IDENTITY, porque por esta conexión viajan las claves
#                     nuevas y REQUIRE SSL no cubre al master. VERIFY_CA solo se acepta hacia 127.0.0.1. Solo admite -h, -P,
#                     --host=, --port=, --protocol=TCP, --ssl-mode= y --ssl-ca=; cualquier otro argumento termina con error.
#   OUT_ENV           archivo nuevo, 0600 y fuera de este repo, donde dejar DB_USER y DB_PASSWORD de pages_app, y WORKER_DB_USER y
#                     WORKER_DB_PASSWORD de pages_worker. Sin esto, las claves no se guardan en ningún lado y hay que fijar otras con
#                     ALTER USER.
#
# Paso siguiente, fuera de las pruebas: subir las claves a Parameter Store. Con file:// no quedan en argv.
#   (umask 077; sed -n 's/^DB_PASSWORD=//p' <OUT_ENV> | tr -d '\n' > <archivo>)
#   aws ssm put-parameter --name /connectus-pages/prod/db_password --type SecureString --value file://<archivo>
#   (umask 077; sed -n 's/^WORKER_DB_PASSWORD=//p' <OUT_ENV> | tr -d '\n' > <archivo>)
#   aws ssm put-parameter --name /connectus-pages/prod/worker_db_password --type SecureString --value file://<archivo>
#   rm <archivo> <OUT_ENV>
#
# Vuelta atrás, si falla a mitad de camino, como master:
#   DROP DATABASE IF EXISTS connectus_pages;
#   DROP USER IF EXISTS 'pages_owner'@'%', 'pages_app'@'%', 'pages_worker'@'%';
set -euo pipefail
umask 077

die() {
  printf 'aprovisionar_bd: %s\n' "$*" >&2
  exit 2
}

MYSQL=${MYSQL:-mysql}
MYSQL_ADMIN_ARGS=${MYSQL_ADMIN_ARGS:-}
MYSQL_HOST_ARGS=${MYSQL_HOST_ARGS:-}
OUT_ENV=${OUT_ENV:-}

[ -n "$MYSQL_HOST_ARGS" ] || die 'falta MYSQL_HOST_ARGS (host, puerto y TLS): no hay host por defecto.'
[ -n "$MYSQL_ADMIN_ARGS" ] || die 'falta MYSQL_ADMIN_ARGS (cómo conectar como master, por ejemplo -u <master> -p).'
command -v "$MYSQL" >/dev/null || die "no se encuentra el cliente $MYSQL."
command -v python3 >/dev/null || die 'no se encuentra python3.'

SQL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../sql" && pwd)
read -r -a ADMIN_ARGS <<< "$MYSQL_ADMIN_ARGS"
read -r -a HOST_ARGS <<< "$MYSQL_HOST_ARGS"

# Sin --ssl-mode, el cliente usa PREFERRED: no valida el certificado y un intermediario puede forzar texto plano.
# Lista cerrada: el cliente acepta muchas escrituras de lo mismo (--ssl-mode DISABLED, --ssl_mode, --loose-ssl-mode, --skip_ssl,
# --loose-host) y gana la última, así que perseguir las peligrosas no alcanza. El argumento no se repite en el error: si ahí
# hubiera una clave, quedaría en la pantalla.
check_tls() {
  local allowed='MYSQL_HOST_ARGS solo admite -h X, -hX, --host=X, -P N, -PN, --port=N, --protocol=TCP, --ssl-mode=X y --ssl-ca=X.'
  local ssl_mode='' ssl_modes=0 host='' hosts=0 expecting='' arg
  for arg in "${HOST_ARGS[@]}"; do
    case "$expecting" in
      host)
        [[ "$arg" != -* ]] || die "$allowed"
        host=$arg
        expecting=''
        continue
        ;;
      port)
        [[ "$arg" =~ ^[0-9]+$ ]] || die "$allowed"
        expecting=''
        continue
        ;;
    esac
    case "$arg" in
      --ssl-mode=*)
        ssl_mode=${arg#*=}
        ssl_modes=$((ssl_modes + 1))
        ;;
      --ssl-ca=* | --protocol=TCP) ;;
      -h)
        expecting=host
        hosts=$((hosts + 1))
        ;;
      --host=*)
        host=${arg#--host=}
        hosts=$((hosts + 1))
        ;;
      -h*)
        host=${arg#-h}
        hosts=$((hosts + 1))
        ;;
      -P) expecting=port ;;
      --port=*) [[ "${arg#--port=}" =~ ^[0-9]+$ ]] || die "$allowed" ;;
      -P*) [[ "${arg#-P}" =~ ^[0-9]+$ ]] || die "$allowed" ;;
      *) die "$allowed" ;;
    esac
  done
  [ -z "$expecting" ] || die "$allowed"
  # Si se repiten, gana el último: uno inofensivo al principio no debe poder tapar otro al final.
  [ "$ssl_modes" = 1 ] || die 'MYSQL_HOST_ARGS debe llevar --ssl-mode=VERIFY_IDENTITY, una sola vez.'
  [ "$hosts" = 1 ] && [ -n "$host" ] || die 'MYSQL_HOST_ARGS debe llevar el host, una sola vez.'
  case "$ssl_mode" in
    VERIFY_IDENTITY) ;;
    VERIFY_CA) [ "$host" = 127.0.0.1 ] || die 'MYSQL_HOST_ARGS solo puede usar --ssl-mode=VERIFY_CA hacia 127.0.0.1.' ;;
    *) die 'MYSQL_HOST_ARGS debe llevar --ssl-mode=VERIFY_IDENTITY.' ;;
  esac
}
check_tls

# También lista cerrada: va en la misma línea que MYSQL_HOST_ARGS, y esa lista no lleva --tls-version ni --ssl-cipher, que por aquí
# bajarían el TLS del master, y --loose-password=X dejaría la clave en argv.
check_admin_args() {
  local allowed='MYSQL_ADMIN_ARGS solo admite -u X, -uX, --user=X, -p y --password; no puede llevar la clave: con -p, mysql la pide.'
  local expecting_user=0 arg
  for arg in "${ADMIN_ARGS[@]}"; do
    if [ "$expecting_user" = 1 ]; then
      [[ "$arg" != -* ]] || die "$allowed"
      expecting_user=0
      continue
    fi
    case "$arg" in
      -u) expecting_user=1 ;;
      -u?* | --user=?* | -p | --password) ;;
      *) die "$allowed" ;;
    esac
  done
  [ "$expecting_user" = 0 ] || die "$allowed"
}
check_admin_args

tmp_base=${TMPDIR:-/tmp}
T=$(mktemp -d "${tmp_base%/}/aprovisionar_bd.XXXXXX")
finished=0
out_env_created=0
cleanup() {
  rm -rf "$T"
  if [ "$finished" = 0 ] && [ "$out_env_created" = 1 ]; then
    rm -f "$OUT_ENV"
  fi
}
trap cleanup EXIT

# Se crea antes de tocar la base: si no se pudiera escribir al final, la clave ya generada se perdería.
if [ -n "$OUT_ENV" ]; then
  (set -C; : > "$OUT_ENV") 2>/dev/null || die "no se pudo crear OUT_ENV ($OUT_ENV): si ya existe, no se sobrescribe."
  out_env_created=1
else
  printf 'aprovisionar_bd: sin OUT_ENV, las claves de pages_app y pages_worker no se guardan en ningún lado.\n' >&2
fi

# Las claves solo existen en $T, con 0600: python las escribe y mysql las lee por stdin o por archivo de opciones.
python3 -I - "$SQL_DIR/00_cuentas.sql" "$T/00.sql" "$T/owner.cnf" "$T/app.clave" "$T/worker.clave" <<'EOF'
import re, secrets, sys
origen, copia, owner_cnf, app_clave, worker_clave = sys.argv[1:]
sql = open(origen, encoding='utf-8').read()
claves = {'__PW_OWNER__': secrets.token_hex(24), '__PW_APP__': secrets.token_hex(24), '__PW_WORKER__': secrets.token_hex(24)}
for marcador, clave in claves.items():
    sql, n = re.subn(marcador, "'%s'" % clave, sql)
    n == 1 or sys.exit('se esperaba un marcador %s y hay %d' % (marcador, n))
open(copia, 'w', encoding='utf-8').write(sql)
open(owner_cnf, 'w').write('[client]\nuser=pages_owner\npassword=%s\n' % claves['__PW_OWNER__'])
open(app_clave, 'w').write(claves['__PW_APP__'])
open(worker_clave, 'w').write(claves['__PW_WORKER__'])
EOF

# --no-defaults y --defaults-file, y no --defaults-extra-file: ~/.my.cnf se lee después del archivo extra y le ganaría, así
# que un user o password puesto ahí haría correr 01 y 02 con otra cuenta, y otro DEFINER. ~/.mylogin.cnf se lee igual, también con
# esas dos opciones y después de ellas: en as_owner se apunta a un archivo que no existe, porque un [client] con el master, que es
# lo que deja mysql_config_editor por defecto, tendría el mismo efecto.
as_master() {
  "$MYSQL" --no-defaults "${ADMIN_ARGS[@]}" "${HOST_ARGS[@]}"
}
as_owner() {
  MYSQL_TEST_LOGIN_FILE="$T/no_existe" "$MYSQL" --defaults-file="$T/owner.cnf" "${HOST_ARGS[@]}"
}

echo 'aprovisionar_bd: 00, cuentas (como master)' >&2
if ! as_master < "$T/00.sql" 2> "$T/00.err"; then
  if grep -q 'ERROR 1396' "$T/00.err"; then
    die 'pages_owner, pages_app o pages_worker ya existen: no se genera otra clave. Para rehacerlo, ver "Vuelta atrás" en este script.'
  fi
  cat "$T/00.err" >&2
  die 'falló el paso 00. Ver "Vuelta atrás" en este script.'
fi

echo 'aprovisionar_bd: 01, esquema (como pages_owner)' >&2
as_owner < "$SQL_DIR/01_esquema.sql" || die 'falló el paso 01. Ver "Vuelta atrás" en este script.'

echo 'aprovisionar_bd: 02, permisos de pages_app (como pages_owner)' >&2
as_owner < "$SQL_DIR/02_permisos_app.sql" || die 'falló el paso 02. Ver "Vuelta atrás" en este script.'

echo 'aprovisionar_bd: 02, permisos de pages_worker (como pages_owner)' >&2
as_owner < "$SQL_DIR/02_permisos_worker.sql" || die 'falló el paso 02. Ver "Vuelta atrás" en este script.'

echo 'aprovisionar_bd: 03, bloquear pages_owner (como master)' >&2
as_master < "$SQL_DIR/03_bloquear_owner.sql" || die 'falló el paso 03: pages_owner sigue sin bloquear. Córrelo a mano.'

if [ -n "$OUT_ENV" ]; then
  {
    printf 'DB_USER=pages_app\nDB_PASSWORD='
    cat "$T/app.clave"
    printf '\nWORKER_DB_USER=pages_worker\nWORKER_DB_PASSWORD='
    cat "$T/worker.clave"
    printf '\n'
  } >> "$OUT_ENV"
fi
finished=1
echo 'aprovisionar_bd: listo. pages_owner quedó bloqueada.' >&2
