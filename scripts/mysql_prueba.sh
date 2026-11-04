#!/usr/bin/env bash
# mysqld desechable para las pruebas de integración: scripts/mysql_prueba.sh up|down|status
#
# Usa los binarios mysqld y mysql del PATH, siempre con --no-defaults y por TCP a 127.0.0.1:33077, para que ni ~/.my.cnf ni un
# socket por defecto lo lleven al MySQL del puerto 3306. El directorio se cambia con PAGES_TEST_MYSQL_DIR.
#
# 'up' deja las variables de las pruebas en test/.env.local (0600, ignorado por git), con claves generadas al azar.
set -euo pipefail
umask 077

readonly PORT=33077
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
readonly ROOT
tmp_base=${TMPDIR:-/tmp}
readonly DIR=${PAGES_TEST_MYSQL_DIR:-${tmp_base%/}/connectus_pages_mysql}
readonly DATA=$DIR/data
readonly PID_FILE=$DIR/mysqld.pid
readonly LOG=$DIR/mysqld.log
readonly MARK=$DIR/.connectus_pages_mysql
readonly READY=$DIR/listo
readonly ENV_LOCAL=$ROOT/test/.env.local

# En macOS, la ruta de un socket no puede pasar de 104 bytes y el TMPDIR de una sesión puede ser largo. Nadie usa este
# socket, pero mysqld exige uno válido.
SOCK=$DIR/mysql.sock
if [ "${#SOCK}" -gt 100 ]; then
  SOCK=/tmp/connectus_pages_mysql_$PORT.sock
fi
readonly SOCK

die() {
  printf 'mysql_prueba: %s\n' "$*" >&2
  exit 1
}

log() {
  printf 'mysql_prueba: %s\n' "$*" >&2
}

check_dir() {
  case "$DIR" in
    /*) ;;
    *) die "PAGES_TEST_MYSQL_DIR debe ser una ruta absoluta: $DIR" ;;
  esac
  case "$DIR" in
    *[[:space:]]*) die "la ruta no puede tener espacios: $DIR" ;;
  esac
}

is_running() {
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid=$(cat "$PID_FILE" 2>/dev/null) || return 1
  case "$pid" in
    '' | *[!0-9]*) return 1 ;;
  esac
  # El pid puede haberse reciclado: solo cuenta si es un proceso con este datadir.
  ps -ww -p "$pid" -o command= 2>/dev/null | grep -Fq -- "--datadir=$DATA"
}

# Un mysqld puede seguir vivo aunque el puerto ya no escuche y el archivo de pid ya no exista: esto mira la lista de procesos.
pids_with_datadir() {
  local all
  all=$(ps -axww -o pid=,command=)
  printf '%s\n' "$all" | awk -v needle="--datadir=$DATA" 'index($0, needle) { print $1 }'
}

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null
}

mysql_root() {
  mysql --no-defaults --protocol=TCP -h 127.0.0.1 -P "$PORT" --connect-timeout=2 \
    --ssl-mode=VERIFY_CA --ssl-ca="$DATA/ca.pem" -u root "$@"
}

stop_server() {
  local pids pid i
  pids=$(pids_with_datadir)
  [ -n "$pids" ] || return 0
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
  done
  for i in $(seq 1 120); do
    [ -n "$(pids_with_datadir)" ] || return 0
    sleep 0.5
  done
  die "el mysqld $(pids_with_datadir | tr '\n' ' ')no terminó en 60 s; no se borra su datadir."
}

wipe_dir() {
  # Sin datadir, un mysqld vivo puede escribir sin parar en su log ya borrado, que no se ve con du.
  [ -z "$(pids_with_datadir)" ] || die "sigue vivo un mysqld con $DATA: no se borra."
  if [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    # Sin la marca, el directorio no es de este script: PAGES_TEST_MYSQL_DIR podría apuntar a cualquier parte.
    [ -f "$MARK" ] || die "$DIR no fue creado por este script: no se borra."
    rm -rf "$DIR"
  fi
  case "$SOCK" in
    "$DIR"/*) ;;
    *) rm -f "$SOCK" "$SOCK.lock" ;;
  esac
}

start_server() {
  mkdir -p "$DIR"
  : > "$MARK"
  # Tope por archivo, en bloques de 1 KiB, para que un log descontrolado no pueda llenar el disco.
  ulimit -f 4194304
  command -v mysqld >/dev/null || die 'no se encuentra mysqld en el PATH.'
  command -v mysql >/dev/null || die 'no se encuentra mysql en el PATH.'

  log "inicializando en $DIR"
  mysqld --no-defaults --initialize-insecure --datadir="$DATA" --log-error="$LOG" \
    || die "falló la inicialización; revisa $LOG"

  # binlog apagado y UTC, lo que el SQL asume: con binlog, CREATE FUNCTION pediría log_bin_trust_function_creators.
  # mysqlx con loose porque 5.7 no conoce la opción y 8.0 abriría otro puerto.
  log "levantando mysqld en 127.0.0.1:$PORT"
  mysqld --no-defaults --daemonize \
    --datadir="$DATA" --pid-file="$PID_FILE" --log-error="$LOG" --socket="$SOCK" \
    --port="$PORT" --bind-address=127.0.0.1 \
    --skip-log-bin --default-time-zone=+00:00 --loose-mysqlx=OFF \
    --innodb-buffer-pool-size=128M --innodb-flush-log-at-trx-commit=0 --performance-schema=OFF \
    >/dev/null 2>&1 || die "no levantó; revisa $LOG"

  local i
  for i in $(seq 1 120); do
    if [ -f "$DATA/ca.pem" ] && mysql_root -e 'SELECT 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  die "no respondió en 60 s; revisa $LOG"
}

create_login() {
  local username=$1 accounts=$2 password_file=$3
  node "$ROOT/scripts/crear_login.js" --usuario "$username" --cuentas "$accounts" --generar 2> "$password_file" \
    | mysql_root || die "no se pudo crear el login $username."
}

cmd_up() {
  check_dir
  if is_running && [ -f "$READY" ] && [ -f "$ENV_LOCAL" ]; then
    log "ya está arriba en 127.0.0.1:$PORT."
    return 0
  fi
  # Un mysqld a medio preparar o un datadir que quedó de antes no sirven: se parte de cero.
  stop_server
  if port_in_use; then
    die "el puerto $PORT lo usa otro proceso: no se toca."
  fi
  wipe_dir
  rm -f "$ENV_LOCAL"
  start_server

  log 'cargando el fixture'
  mysql_root < "$ROOT/test/fixtures/dbconnectus.sql" > /dev/null

  local work
  work=$(mktemp -d "${tmp_base%/}/connectus_pages_prueba.XXXXXX")
  # shellcheck disable=SC2064
  trap "rm -rf '$work'" EXIT

  MYSQL=mysql \
    MYSQL_ADMIN_ARGS='-u root' \
    MYSQL_HOST_ARGS="--protocol=TCP -h 127.0.0.1 -P $PORT --ssl-mode=VERIFY_CA --ssl-ca=$DATA/ca.pem" \
    OUT_ENV="$work/cuentas.env" \
    bash "$ROOT/scripts/aprovisionar_bd.sh"

  log 'creando logins de prueba'
  mysql_root -e 'INSERT INTO connectus_pages.allowed_account (id_account) VALUES (101), (102)'
  create_login demo 101,102 "$work/demo"
  create_login solo102 102 "$work/solo102"
  create_login inactivo 101 "$work/inactivo"
  mysql_root -e "UPDATE connectus_pages.login SET active = 0 WHERE username = 'inactivo'"

  local link_secret demo_id demo_url
  link_secret=$(python3 -I -c 'import secrets; print(secrets.token_hex(32))')
  demo_id=$(mysql_root -N -e "SELECT id FROM connectus_pages.login WHERE username = 'demo'")
  # La base es de mentira: crear_enlace.js solo emite para https, y scripts/dev.js pone este enlace en sus propias URL.
  demo_url=$(printf '%s' "$link_secret" | node "$ROOT/scripts/crear_enlace.js" \
    --base https://localhost/ --ranura a --login "$demo_id" --version 0 2>/dev/null)

  mkdir -p "$(dirname "$ENV_LOCAL")"
  {
    printf 'STAGE=local\n'
    printf 'DB_HOST=127.0.0.1\n'
    printf 'DB_PORT=%s\n' "$PORT"
    printf 'DB_SSL_CA_FILE=%s\n' "$DATA/ca.pem"
    printf 'DB_ADMIN_USER=root\n'
    cat "$work/cuentas.env"
    printf 'TOKEN_SECRET='
    python3 -I -c 'import secrets; print(secrets.token_hex(32))'
    printf 'LINK_SECRET_A=%s\n' "$link_secret"
    printf 'LINK_DEMO=%s\n' "${demo_url#*#e=}"
    printf 'LOGIN_DEMO_USER=demo\nLOGIN_DEMO_PASSWORD='
    tail -n 1 "$work/demo"
    printf 'LOGIN_SOLO102_USER=solo102\nLOGIN_SOLO102_PASSWORD='
    tail -n 1 "$work/solo102"
    printf 'LOGIN_INACTIVO_USER=inactivo\nLOGIN_INACTIVO_PASSWORD='
    tail -n 1 "$work/inactivo"
  } > "$ENV_LOCAL.tmp"
  mv "$ENV_LOCAL.tmp" "$ENV_LOCAL"

  : > "$READY"
  log "listo en 127.0.0.1:$PORT; variables en test/.env.local"
}

cmd_down() {
  check_dir
  stop_server
  wipe_dir
  rm -f "$ENV_LOCAL" "$ENV_LOCAL.tmp"
  log 'abajo.'
}

cmd_status() {
  check_dir
  if is_running; then
    if [ -f "$READY" ]; then
      echo "arriba: pid $(cat "$PID_FILE"), 127.0.0.1:$PORT, $DIR"
    else
      echo "a medio preparar: pid $(cat "$PID_FILE"), 127.0.0.1:$PORT, $DIR"
    fi
    return 0
  fi
  echo "abajo: $DIR"
  return 3
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *)
    echo 'Uso: scripts/mysql_prueba.sh up|down|status' >&2
    exit 2
    ;;
esac
