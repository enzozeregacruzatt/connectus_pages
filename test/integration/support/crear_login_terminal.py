"""Corre scripts/crear_login.js sin --generar, en una terminal de verdad (pty), que es como se usa en producción.

La clave llega por stdin, para que no quede en argv. El SQL queda en el archivo, como en el procedimiento documentado, y lo que
apareció en la terminal sale por stderr.
Uso: python3 -I crear_login_terminal.py <node> <crear_login.js> <usuario> <cuentas> <archivo_sql>
"""
import os
import pty
import select
import sys

node, script, username, accounts, sql_file = sys.argv[1:]
password = sys.stdin.buffer.readline().rstrip(b'\n')
sql_fd = os.open(sql_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)

pid, terminal = pty.fork()
if pid == 0:
    # pty.fork deja también stdout en la terminal: el SQL no debe mezclarse con los avisos.
    os.dup2(sql_fd, 1)
    os.execv(node, [node, script, '--usuario', username, '--cuentas', accounts])

screen = b''


def read_more():
    global screen
    if not select.select([terminal], [], [], 20)[0]:
        sys.exit('crear_login.js no respondió.')
    try:
        data = os.read(terminal, 1024)
    except OSError:  # En Linux, leer una terminal cuyo proceso ya terminó da EIO en vez de EOF.
        data = b''
    screen += data
    return bool(data)


for prompt in (b'Clave: ', b'Repite la clave: '):
    while prompt not in screen:
        if not read_more():
            sys.exit('crear_login.js terminó sin pedir la clave.')
    os.write(terminal, password + b'\r')

while read_more():
    pass

sys.stderr.buffer.write(screen)
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
