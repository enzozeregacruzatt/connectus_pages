"""Corre un comando de shell en una terminal de verdad (pty) y teclea un texto, como quien responde al `mysql -p` del comando.

Teclea cuando en la pantalla aparece <espera>, pasados <demora> segundos, y escribe en stdout todo lo que apareció en la pantalla.
Uso: python3 -I terminal_mysql_p.py <comando> <espera> <demora> <texto>
"""
import os
import pty
import select
import sys
import time

command, wait_for, delay, typed = sys.argv[1:]
wait_for = wait_for.encode()
typed = typed.encode()

pid, terminal = pty.fork()
if pid == 0:
    os.execvp('bash', ['bash', '-c', command])

screen = b''


def read_more(timeout):
    global screen
    if not select.select([terminal], [], [], timeout)[0]:
        return True
    try:
        data = os.read(terminal, 1024)
    except OSError:  # En Linux, leer una terminal cuyo proceso ya terminó da EIO en vez de EOF.
        data = b''
    screen += data
    return bool(data)


deadline = time.monotonic() + 20
while wait_for not in screen:
    if time.monotonic() > deadline or not read_more(1):
        sys.exit('no apareció en la pantalla lo que se esperaba: %r' % screen)
until = time.monotonic() + float(delay)
while time.monotonic() < until and read_more(0.01):
    pass
os.write(terminal, typed + b'\r')

deadline = time.monotonic() + 20
while read_more(1):
    if time.monotonic() > deadline:
        sys.exit('el comando no terminó: %r' % screen)

sys.stdout.buffer.write(screen)
os.waitpid(pid, 0)
