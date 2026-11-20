"""Drive the compiled explorer through a real Unix PTY and report terminal facts."""

import errno
import fcntl
import json
import os
import select
import struct
import subprocess
import sys
import termios
import time


binary, cwd, mode = sys.argv[1:]
master, slave = os.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
original = termios.tcgetattr(slave)
environment = os.environ.copy()
for name in (
    "CI", "AI_AGENT", "CLAUDECODE", "CLAUDE_CODE", "CODEX_CI", "CODEX_SANDBOX",
    "CODEX_THREAD_ID", "CURSOR_AGENT", "CURSOR_TRACE_ID", "GEMINI_CLI",
    "OPENCODE", "OPENCODE_CLIENT",
):
    environment.pop(name, None)
environment.update(TERM="xterm", NO_COLOR="1")
child = subprocess.Popen(
    [binary, "explore", "--user"],
    cwd=cwd,
    env=environment,
    stdin=slave,
    stdout=slave,
    stderr=slave,
)
output = bytearray()


def read_until(marker):
    target = marker.encode()
    start = len(output)
    deadline = time.monotonic() + 15
    while target not in output[start:]:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"No {marker!r} after {bytes(output[-2000:])!r}")
        if not select.select([master], [], [], remaining)[0]:
            continue
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                raise RuntimeError(f"PTY closed before {marker!r}: {bytes(output[-2000:])!r}") from error
            raise
        if not data:
            raise RuntimeError(f"PTY ended before {marker!r}: {bytes(output[-2000:])!r}")
        output.extend(data)


def send(keys):
    os.write(master, keys)


def drain_until_exit():
    deadline = time.monotonic() + 15
    while child.poll() is None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"Child stayed alive after screen restore: {bytes(output[-2000:])!r}")
        if not select.select([master], [], [], min(remaining, 0.1))[0]:
            continue
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not data:
            break
        output.extend(data)
    child.wait(timeout=1)


try:
    read_until("Tack explorer")
    active = termios.tcgetattr(slave)
    send(b"/pty-fixture-skill")
    read_until("1 matches")
    send(b"\r")
    send(b"i")
    read_until("1 staged")
    send(b"c")
    read_until("Review: user")
    if mode == "interrupt":
        send(b"\x03")
    else:
        send(b"y")
        read_until("Applied: user")
        send(b"q")
        read_until("pty-fixture-skill")
        send(b"q")
    read_until("\x1b[?1049l")
    drain_until_exit()
    restored = termios.tcgetattr(slave)
    while select.select([master], [], [], 0)[0]:
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not data:
            break
        output.extend(data)
    flags = termios.ICANON | termios.ECHO
    print(json.dumps({
        "exitCode": child.returncode,
        "raw": active[3] & flags == 0,
        "restored": restored[3] & flags == original[3] & flags,
        "transcript": output.decode(errors="replace"),
    }))
finally:
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)
    os.close(master)
    if slave >= 0:
        os.close(slave)
