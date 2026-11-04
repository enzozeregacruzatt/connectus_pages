"""Corre scripts/crear_enlace.js con stdin en una terminal de verdad (pty), que es como se pide el secreto si no viene por un pipe.

El secreto llega por stdin de este programa, para que no quede en argv. La URL queda en el archivo, y lo que apareció en la terminal
sale por stderr.
Uso: python3 -I crear_enlace_terminal.py <node> <crear_enlace.js> <archivo_url> <argumentos...>
"""
import os
import pty
import select
import sys

node, script, url_file, *arguments = sys.argv[1:]
secret = sys.stdin.buffer.readline().rstrip(b'\n')
url_fd = os.open(url_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)

pid, terminal = pty.fork()
if pid == 0:
    # pty.fork deja también stdout en la terminal: la URL no debe mezclarse con los avisos.
    os.dup2(url_fd, 1)
    os.execv(node, [node, script, *arguments])

screen = b''


def read_more():
    global screen
    if not select.select([terminal], [], [], 20)[0]:
        sys.exit('crear_enlace.js no respondió.')
    try:
        data = os.read(terminal, 1024)
    except OSError:  # En Linux, leer una terminal cuyo proceso ya terminó da EIO en vez de EOF.
        data = b''
    screen += data
    return bool(data)


while b'Secreto: ' not in screen:
    if not read_more():
        sys.exit('crear_enlace.js terminó sin pedir el secreto.')
os.write(terminal, secret + b'\r')

while read_more():
    pass

sys.stderr.buffer.write(screen)
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
