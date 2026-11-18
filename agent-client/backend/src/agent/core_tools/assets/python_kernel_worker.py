import ast
import contextlib
import io
import json
import os
import sys
import traceback

MAX_OUTPUT_CHARS = 50000

class CappedText(io.StringIO):
    def write(self, value):
        remaining = MAX_OUTPUT_CHARS - self.tell()
        if remaining > 0:
            super().write(value[:remaining])
        return len(value)

def execute(code, artifact_dir):
    stdout = CappedText()
    stderr = CappedText()
    value = None
    figures = []
    try:
        parsed = ast.parse(code, mode="exec")
        body = parsed.body
        last = body.pop() if body and isinstance(body[-1], ast.Expr) else None
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            if body:
                exec(compile(ast.Module(body=body, type_ignores=[]), "<agent-cell>", "exec"), GLOBALS, GLOBALS)
            if last:
                value = repr(eval(compile(ast.Expression(last.value), "<agent-cell>", "eval"), GLOBALS, GLOBALS))
        try:
            import matplotlib.pyplot as plt
            os.makedirs(artifact_dir, exist_ok=True)
            for number in plt.get_fignums():
                figure = plt.figure(number)
                name = "figure-%s.png" % number
                figure.savefig(os.path.join(artifact_dir, name), dpi=144, bbox_inches="tight")
                figures.append(name)
            plt.close("all")
        except Exception:
            pass
        return {"ok": True, "stdout": stdout.getvalue(), "stderr": stderr.getvalue(), "value": value, "figures": figures}
    except Exception:
        return {"ok": False, "stdout": stdout.getvalue(), "stderr": stderr.getvalue(), "error": traceback.format_exc(), "figures": figures}

GLOBALS = {"__name__": "__analysis_kernel__"}
for raw in sys.stdin:
    try:
        request = json.loads(raw)
        result = execute(str(request.get("code", "")), str(request.get("artifactDir", "")))
        result["id"] = request.get("id")
        print(json.dumps(result, ensure_ascii=False), flush=True)
    except Exception:
        print(json.dumps({"id": None, "ok": False, "error": traceback.format_exc()}), flush=True)
