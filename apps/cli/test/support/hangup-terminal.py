"""Run a command in a real terminal, then close that terminal on request.

The command leads its own session and is the terminal's foreground job; its output is copied to
stdout. A line on stdin closes the terminal the way a closed terminal window does: the shell hangs
up every process of its foreground job at once, then the terminal goes away. The exit status is the
command's, or 128 plus the signal that ended it.
"""

import os
import pty
import select
import signal
import sys

pid, master = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])

open_master = True
while open_master:
    readable, _, _ = select.select([master, sys.stdin], [], [])
    if sys.stdin in readable:
        sys.stdin.readline()
        os.killpg(os.tcgetpgrp(master), signal.SIGHUP)
        os.close(master)
        open_master = False
    elif master in readable:
        try:
            data = os.read(master, 65536)
        except OSError:
            data = b""
        if data == b"":
            os.close(master)
            open_master = False
        else:
            sys.stdout.buffer.write(data)
            sys.stdout.flush()

_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
