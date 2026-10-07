"""
The live Python session on the account's cloud computer.

Started by service.mjs, one process per conversation, as the account's own
ordinary user — never as the service — and spoken to one JSON line at a time:
a request on stdin, the answer on what stdout was when it started. Everything a
cell prints, from `print` to a shell line to a C library writing straight to
its file descriptor, goes to a file kept for that cell instead, so nothing a
cell writes can be mistaken for an answer, and the order of what it said is
the order it said it in.

Its namespace is what makes it a notebook rather than a script: what one call
defines, the next call still has — a table loaded once stays loaded.

Standard library only: it has to start on a machine where nothing has been
installed yet.
"""
import ast
import base64
import io
import json
import linecache
import os
import shlex
import subprocess
import sys
import tempfile
import traceback

# The protocol keeps its own copies of stdin and stdout; the cell gets neither.
_answers = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
_requests = os.fdopen(os.dup(0), "r", encoding="utf-8")
_null = os.open(os.devnull, os.O_RDONLY)
os.dup2(_null, 0)
sys.stdin = open(os.devnull, encoding="utf-8")

# Descriptors 1 and 2 both point at one file, emptied before each cell.
_capture = tempfile.TemporaryFile(mode="w+b")
os.dup2(_capture.fileno(), 1)
os.dup2(_capture.fileno(), 2)
sys.stdout = io.TextIOWrapper(os.fdopen(1, "wb", closefd=False), encoding="utf-8", errors="replace", line_buffering=True)
sys.stderr = io.TextIOWrapper(os.fdopen(2, "wb", closefd=False), encoding="utf-8", errors="replace", line_buffering=True)

OUTPUT_LIMIT = 60000
RESULT_LIMIT = 20000

namespace = {"__name__": "__main__", "__builtins__": __builtins__}


def _shell(command):
    """A `!` line: run in the shell, its output in the cell's, in order."""
    sys.stdout.flush()
    sys.stderr.flush()
    done = subprocess.run(command, shell=True)
    if done.returncode:
        print("(exit %d)" % done.returncode)


namespace["__synz_shell__"] = _shell


def _transform(code):
    """`!cmd` and `%pip …` as a notebook reads them; every other line as written."""
    lines = []
    for line in code.split("\n"):
        body = line.lstrip()
        indent = line[: len(line) - len(body)]
        if body.startswith("!"):
            lines.append("%s__synz_shell__(%r)" % (indent, body[1:]))
        elif body.startswith("%pip ") or body.startswith("%pip\t"):
            command = "%s -m pip %s" % (shlex.quote(sys.executable), body[5:])
            lines.append("%s__synz_shell__(%r)" % (indent, command))
        else:
            lines.append(line)
    return "\n".join(lines)


def _show(value):
    try:
        text = repr(value)
    except Exception as err:  # a value that cannot say what it is
        text = "<unprintable %s: %s>" % (type(value).__name__, err)
    return text[:RESULT_LIMIT]


def _run(code):
    """Run a cell; the value of its last line, if it is an expression, comes back."""
    source = _transform(code)
    # So a traceback can quote the line that failed.
    linecache.cache["<cell>"] = (len(source), None, source.splitlines(True), "<cell>")
    tree = ast.parse(source, "<cell>", "exec")
    last = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        last = ast.Expression(tree.body.pop().value)
    exec(compile(tree, "<cell>", "exec"), namespace)
    if last is not None:
        value = eval(compile(last, "<cell>", "eval"), namespace)
        if value is not None:
            namespace["_"] = value
            return _show(value)
    return None


def _trace():
    """The traceback from the cell's own frames, not this file's."""
    kind, err, tb = sys.exc_info()
    frames = [f for f in traceback.extract_tb(tb) if not f.filename.endswith("kernel.py")]
    text = "".join(traceback.format_list(frames) + traceback.format_exception_only(kind, err))
    return text[-6000:]


def _figures():
    """Every open matplotlib figure as a PNG, then closed — four at most."""
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return []
    shots = []
    try:
        for number in plt.get_fignums()[:4]:
            buffer = io.BytesIO()
            plt.figure(number).savefig(buffer, format="png", dpi=110, bbox_inches="tight")
            data = buffer.getvalue()
            if len(data) <= 3000000:
                shots.append(base64.b64encode(data).decode("ascii"))
    finally:
        plt.close("all")
    return shots


def _empty_capture():
    sys.stdout.flush()
    sys.stderr.flush()
    os.lseek(1, 0, os.SEEK_SET)
    os.ftruncate(1, 0)


def _read_capture():
    sys.stdout.flush()
    sys.stderr.flush()
    size = os.lseek(1, 0, os.SEEK_END)
    start = max(0, size - OUTPUT_LIMIT)
    os.lseek(1, start, os.SEEK_SET)
    chunks = []
    while True:
        chunk = os.read(1, 65536)
        if not chunk:
            break
        chunks.append(chunk)
    text = b"".join(chunks).decode("utf-8", "replace")
    return ("... [%d bytes cut] ...\n" % start if start else "") + text


def main():
    while True:
        try:
            raw = _requests.readline()
        except KeyboardInterrupt:
            # An interrupt that arrived just after the cell finished.
            continue
        if not raw:
            return
        try:
            request = json.loads(raw)
        except ValueError:
            continue
        _empty_capture()
        result = None
        error = None
        try:
            result = _run(str(request.get("code") or ""))
        except KeyboardInterrupt:
            error = "Interrupted: the cell ran past its time limit. What it had set before that point is kept."
        except SystemExit:
            error = "The cell called exit(); the session goes on."
        except BaseException:
            error = _trace()
        images = []
        try:
            images = _figures()
        except Exception as err:
            error = (error or "") + "\n(The figures could not be saved: %s)" % err
        try:
            output = _read_capture()
        except Exception:
            output = ""
        answer = {"id": request.get("id"), "output": output, "result": result, "error": error, "images": images}
        _answers.write(json.dumps(answer) + "\n")
        _answers.flush()


if __name__ == "__main__":
    main()
