#!/usr/bin/env python3
"""Report engine for the ``bio-report`` CLI.

The Node CLI sends one JSON payload on stdin; this process reads the manifests,
result tables, figures and methods text, writes the Markdown report, optionally
renders a PDF with matplotlib, and prints exactly one JSON document on stdout.
Diagnostics are returned inside that document so stdout stays machine readable.

Usage:
    engine.py build   # payload on stdin
    engine.py check   # report the interpreter and matplotlib availability
"""

from __future__ import annotations

import csv
import datetime
import hashlib
import json
import os
import re
import sys
import textwrap
from pathlib import Path

ENGINE_VERSION = "0.1.0"
SCHEMA_VERSION = 1

MAX_HASH_BYTES = 64 * 1024 * 1024  # 64 MiB
MAX_TABLE_BYTES = 32 * 1024 * 1024
MAX_TABLE_ROWS = 20
MAX_TABLE_COLUMNS = 12
MAX_CELL_CHARS = 60
MAX_PARAMETER_CHARS = 160
MAX_COMMAND_CHARS = 600
MAX_TABLES = 200
MAX_FIGURES = 500
MAX_SUMMARY_TOOLS = 12

TABLE_SUFFIXES = (".csv", ".tsv")
FIGURE_SUFFIXES = (".png", ".pdf", ".svg")
SHA256_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")

PAGE_WIDTH = 108
PAGE_LINES = 58


class PdfUnavailable(RuntimeError):
    """Raised when matplotlib cannot be imported for PDF rendering."""


def emit(document: dict) -> None:
    json.dump(document, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def warning(warnings: list, message: str) -> None:
    warnings.append(message)


def first_string(mapping: object, *keys: str) -> str | None:
    if not isinstance(mapping, dict):
        return None
    for key in keys:
        value = mapping.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def normalize_sha256(value: object) -> str | None:
    if isinstance(value, str) and SHA256_PATTERN.match(value.strip()):
        return value.strip().lower()
    return None


def digest(path: Path) -> str | None:
    """Return the sha256 of *path*, or None when it is unreadable or too large."""
    try:
        if path.stat().st_size > MAX_HASH_BYTES:
            return None
        hasher = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                hasher.update(chunk)
        return hasher.hexdigest()
    except OSError:
        return None


def truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else f"{text[: limit - 1]}…"


def as_command(value: object) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    if isinstance(value, list):
        parts = [str(item) for item in value if str(item).strip()]
        return " ".join(parts) or None
    return None


def as_parameters(value: object) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, list):
        return {"args": value} if value else {}
    if isinstance(value, str) and value.strip():
        return {"raw": value.strip()}
    return {}


def normalize_files(value: object) -> list:
    """Normalize the many manifest shapes used for inputs and outputs."""
    entries = []

    def add(raw_path: object, raw_sha: object = None) -> None:
        if isinstance(raw_path, dict):
            path_value = first_string(raw_path, "path", "file", "name", "uri")
            sha_value = normalize_sha256(raw_path.get("sha256") or raw_path.get("hash"))
            if path_value is None:
                return
            entries.append({"path": path_value, "sha256": sha_value})
            return
        if isinstance(raw_path, str) and raw_path.strip():
            entries.append({"path": raw_path.strip(), "sha256": normalize_sha256(raw_sha)})

    if isinstance(value, list):
        for item in value:
            add(item)
    elif isinstance(value, dict):
        if any(key in value for key in ("path", "file", "name", "uri")):
            add(value)
        else:
            for raw_path, raw_sha in value.items():
                add(raw_path, raw_sha)
    return entries


def resolve_reference(base: Path, raw_path: str) -> Path | None:
    candidate = Path(raw_path).expanduser()
    if candidate.is_absolute():
        return candidate if candidate.exists() else None
    relative = (base / candidate)
    if relative.exists():
        return relative
    fallback = Path.cwd() / candidate
    return fallback if fallback.exists() else None


def complete_hashes(entries: list, base: Path, warnings: list, source: str) -> None:
    for entry in entries:
        if entry["sha256"]:
            continue
        reference = resolve_reference(base, entry["path"])
        if reference is None:
            warning(warnings, f"manifest {source}: no sha256 for '{entry['path']}' and the file was not found")
            continue
        computed = digest(reference)
        if computed is None:
            warning(warnings, f"manifest {source}: '{entry['path']}' is larger than 64 MiB or unreadable; record its sha256 in the manifest")
            continue
        entry["sha256"] = computed


def normalize_tool(item: object, source: str, base: Path, warnings: list) -> dict:
    mapping = item if isinstance(item, dict) else {}
    nested_tool = mapping.get("tool") if isinstance(mapping.get("tool"), dict) else None

    if nested_tool is not None:
        name = first_string(nested_tool, "name", "id")
        version = first_string(nested_tool, "version")
    else:
        name = first_string(mapping, "tool", "name", "tool_name", "software", "program")
        version = None
    version = version or first_string(mapping, "version", "tool_version", "software_version")
    if name is None:
        name = first_string(mapping, "id")
    if name is None:
        warning(warnings, f"manifest {source}: a record has no tool name")
    if version is None:
        warning(warnings, f"manifest {source}: tool '{name or 'unknown'}' has no version")

    record = {
        "source": source,
        "tool": name,
        "version": version,
        "command": as_command(mapping.get("command") or mapping.get("cmd") or mapping.get("command_line") or mapping.get("cmdline")),
        "parameters": as_parameters(mapping.get("parameters") or mapping.get("params") or mapping.get("args") or mapping.get("config")),
        "inputs": normalize_files(mapping.get("inputs")),
        "outputs": normalize_files(mapping.get("outputs")),
    }
    complete_hashes(record["inputs"], base, warnings, source)
    complete_hashes(record["outputs"], base, warnings, source)
    return record


def split_records(data: object) -> list:
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("tools", "runs", "entries", "records", "steps"):
            value = data.get(key)
            if isinstance(value, list):
                return value
    return [data]


def load_manifest(path: Path, warnings: list) -> dict:
    manifest = {"source": str(path), "sha256": None, "tools": []}
    try:
        manifest["sha256"] = digest(path)
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        warning(warnings, f"manifest {path}: cannot be read ({exc.strerror or exc}); skipped")
        return manifest
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        warning(warnings, f"manifest {path}: invalid JSON at line {exc.lineno} ({exc.msg}); skipped")
        return manifest

    base = path.parent
    for item in split_records(data):
        manifest["tools"].append(normalize_tool(item, str(path), base, warnings))
    if not manifest["tools"]:
        warning(warnings, f"manifest {path}: contains no tool records")
    return manifest


def read_table(path: Path, base: Path, warnings: list) -> dict:
    table = {
        "name": relative_name(path, base),
        "path": str(path),
        "columns": [],
        "rows": [],
        "row_count": 0,
        "column_count": 0,
        "error": None,
    }
    delimiter = "\t" if path.suffix.lower() == ".tsv" else ","
    try:
        if path.stat().st_size > MAX_TABLE_BYTES:
            warning(warnings, f"table {path}: larger than 32 MiB, reading rows for counts anyway")
        with path.open("r", encoding="utf-8", errors="replace", newline="") as handle:
            reader = csv.reader(handle, delimiter=delimiter)
            header = None
            for row in reader:
                if header is None:
                    header = row
                    continue
                table["row_count"] += 1
                if len(table["rows"]) < MAX_TABLE_ROWS:
                    table["rows"].append(row)
    except (OSError, csv.Error) as exc:
        table["error"] = str(exc)
        warning(warnings, f"table {path}: cannot be parsed ({exc}); listed without content")
        return table

    table["columns"] = list(header or [])
    width = max([len(table["columns"])] + [len(row) for row in table["rows"]])
    for index in range(len(table["columns"]), width):
        table["columns"].append(f"column_{index + 1}")
    table["column_count"] = width
    for row in table["rows"]:
        if len(row) < width:
            row.extend([""] * (width - len(row)))
    return table


def relative_name(path: Path, base: Path) -> str:
    try:
        return path.relative_to(base).as_posix()
    except ValueError:
        return path.name


def load_tables(directories: list, warnings: list) -> list:
    tables = []
    for raw_directory in directories:
        base = Path(raw_directory)
        try:
            candidates = sorted(
                (candidate for candidate in base.rglob("*") if candidate.is_file() and candidate.suffix.lower() in TABLE_SUFFIXES),
                key=lambda candidate: candidate.as_posix(),
            )
        except OSError as exc:
            warning(warnings, f"results directory {base}: cannot be scanned ({exc.strerror or exc}); skipped")
            continue
        for candidate in candidates:
            if len(tables) >= MAX_TABLES:
                warning(warnings, f"results directories: more than {MAX_TABLES} tables; remaining files were not read")
                return tables
            tables.append(read_table(candidate, base, warnings))
    return tables


def load_figures(directories: list, warnings: list) -> list:
    figures = []
    for raw_directory in directories:
        base = Path(raw_directory)
        try:
            candidates = sorted(
                (candidate for candidate in base.rglob("*") if candidate.is_file() and candidate.suffix.lower() in FIGURE_SUFFIXES),
                key=lambda candidate: candidate.as_posix(),
            )
        except OSError as exc:
            warning(warnings, f"figures directory {base}: cannot be scanned ({exc.strerror or exc}); skipped")
            continue
        for candidate in candidates:
            if len(figures) >= MAX_FIGURES:
                warning(warnings, f"figures directories: more than {MAX_FIGURES} figures; remaining files were not listed")
                return figures
            figures.append({
                "name": relative_name(candidate, base),
                "path": str(candidate),
                "type": candidate.suffix.lower().lstrip("."),
                "bytes": safe_size(candidate),
                "sha256": digest(candidate),
            })
    return figures


def safe_size(path: Path) -> int | None:
    try:
        return path.stat().st_size
    except OSError:
        return None


def resolve_generated_at() -> str:
    """ISO 8601 UTC seconds; honours SOURCE_DATE_EPOCH for reproducible output."""
    epoch = os.environ.get("SOURCE_DATE_EPOCH")
    if epoch:
        try:
            moment = datetime.datetime.fromtimestamp(int(epoch), tz=datetime.timezone.utc)
            return moment.strftime("%Y-%m-%dT%H:%M:%SZ")
        except (ValueError, OverflowError, OSError):
            pass
    return datetime.datetime.now(tz=datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def plural(count: int, singular: str, plural_form: str | None = None) -> str:
    return f"{count} {singular if count == 1 else (plural_form or singular + 's')}"


def escape_cell(value: object) -> str:
    text = truncate(str(value), MAX_CELL_CHARS)
    return text.replace("\\", "\\\\").replace("|", "\\|").replace("\r", " ").replace("\n", " ").strip()


def demote_headings(text: str, target: int = 3) -> str:
    """Shift Markdown headings so supplied text nests under the report section."""
    levels = [len(match.group(1)) for match in re.finditer(r"^(#{1,6})\s+", text, flags=re.MULTILINE)]
    if not levels:
        return text
    shift = target - min(levels)
    if shift <= 0:
        return text

    def replace(match: re.Match) -> str:
        return "#" * min(6, len(match.group(1)) + shift) + " "

    return re.sub(r"^(#{1,6})\s+", replace, text, flags=re.MULTILINE)


def render_value(value: object) -> str:
    if isinstance(value, str):
        return truncate(value, MAX_PARAMETER_CHARS)
    try:
        rendered = json.dumps(value, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        rendered = str(value)
    return truncate(rendered, MAX_PARAMETER_CHARS)


def render_markdown(payload: dict, manifests: list, tables: list, figures: list, methods_text: str, generated_at: str) -> str:
    title = payload.get("title") or "Analysis Report"
    tools = [tool for manifest in manifests for tool in manifest["tools"]]
    lines = [f"# {title}", "", f"_Generated {generated_at} by bio-report {ENGINE_VERSION}._", ""]

    lines += ["## Summary", ""]
    lines.append(f"- {plural(len(manifests), 'manifest file')} describing {plural(len(tools), 'tool run')}")
    lines.append(f"- {plural(len(tables), 'result table')} and {plural(len(figures), 'figure')}")
    lines.append(f"- Methods: {'supplied' if methods_text else 'not supplied'}")
    named = [tool for tool in tools if tool.get("tool")]
    if named:
        summary = [f"`{tool['tool']}`{(' ' + tool['version']) if tool.get('version') else ''}" for tool in named[:MAX_SUMMARY_TOOLS]]
        if len(named) > MAX_SUMMARY_TOOLS:
            summary.append(f"+{len(named) - MAX_SUMMARY_TOOLS} more")
        lines.append(f"- Software: {', '.join(summary)}")
    lines.append("- Provenance records the generation time and a sha256 digest for every manifest and recorded input/output")

    lines += ["", "## Methods", ""]
    lines.append(demote_headings(methods_text.strip()) if methods_text.strip() else "_No methods file was supplied._")

    lines += ["", "## Parameters & software versions", ""]
    if not tools:
        lines.append("_No manifests were supplied._")
    else:
        lines += ["| Tool | Version | Manifest |", "| --- | --- | --- |"]
        for tool in tools:
            lines.append(
                f"| {escape_cell(tool['tool'] or 'unknown')} | {escape_cell(tool['version'] or 'unknown')} | `{escape_cell(tool['source'])}` |"
            )
        for tool in tools:
            heading = f"### {tool['tool'] or 'unknown tool'}"
            if tool["version"]:
                heading += f" {tool['version']}"
            lines += ["", heading, ""]
            lines.append(f"- Manifest: `{tool['source']}`")
            if tool["command"]:
                lines.append(f"- Command: `{escape_cell(truncate(tool['command'], MAX_COMMAND_CHARS))}`")
            parameter_items = sorted(tool["parameters"].items(), key=lambda item: str(item[0]))
            if parameter_items:
                lines.append("- Parameters:")
                for key, value in parameter_items:
                    lines.append(f"  - `{key}`: {escape_cell(render_value(value))}")
            else:
                lines.append("- Parameters: none recorded")
            lines.extend(render_file_list("Inputs", tool["inputs"]))
            lines.extend(render_file_list("Outputs", tool["outputs"]))

    lines += ["", "## Results tables", ""]
    if not tables:
        lines.append("_No result tables were supplied._")
    else:
        lines.append("\n\n".join(table_block(table) for table in tables))

    lines += ["", "## Figures", ""]
    if not figures:
        lines.append("_No figures were supplied._")
    else:
        lines += ["| Figure | Type | Size | sha256 |", "| --- | --- | --- | --- |"]
        for figure in figures:
            size = f"{figure['bytes']} B" if figure["bytes"] is not None else "unknown"
            lines.append(
                f"| {escape_cell(figure['name'])} | {figure['type']} | {size} | `{figure['sha256'] or 'unavailable'}` |"
            )
        lines += [""]
        for figure in figures:
            lines.append(f"- `{escape_cell(figure['name'])}` — `{figure['path']}`")

    lines += ["", "## Provenance", ""]
    lines.append(f"- Generated at: `{generated_at}`")
    lines.append(f"- Generator: `bio-report {ENGINE_VERSION}` (Python {sys.version.split()[0]})")
    lines.append(f"- Inputs: {len(manifests)} manifest(s), {len(tables)} table(s), {len(figures)} figure(s)")
    lines += ["", "### Manifests", ""]
    if not manifests:
        lines.append("_No manifests were supplied._")
    else:
        lines += ["| Manifest | sha256 |", "| --- | --- |"]
        for manifest in manifests:
            lines.append(f"| `{escape_cell(manifest['source'])}` | `{manifest['sha256'] or 'unavailable'}` |")

    lines += ["", "### Recorded files", ""]
    rows = []
    for manifest in manifests:
        for tool in manifest["tools"]:
            for entry in tool["inputs"]:
                rows.append(("input", entry["path"], entry["sha256"], tool["tool"]))
            for entry in tool["outputs"]:
                rows.append(("output", entry["path"], entry["sha256"], tool["tool"]))
    for figure in figures:
        rows.append(("figure", figure["path"], figure["sha256"], None))
    if not rows:
        lines.append("_No input or output files were recorded._")
    else:
        lines += ["| Role | Path | sha256 | Tool |", "| --- | --- | --- | --- |"]
        for role, raw_path, sha, tool in rows:
            lines.append(f"| {role} | `{escape_cell(raw_path)}` | `{sha or 'unavailable'}` | {escape_cell(tool or '')} |")
    lines.append("")

    return "\n".join(lines)


def table_block(table: dict) -> str:
    header = f"### {table['name']} ({plural(table['row_count'], 'row')} × {plural(table['column_count'], 'column')})"
    lines = [header, "", f"Source: `{table['path']}`"]
    if table["error"]:
        lines += ["", f"_Could not be parsed: {escape_cell(table['error'])}_"]
        return "\n".join(lines)
    if not table["columns"]:
        lines += ["", "_Empty table._"]
        return "\n".join(lines)

    columns = table["columns"][:MAX_TABLE_COLUMNS]
    lines += [""]
    lines.append(f"| {' | '.join(escape_cell(column) for column in columns)} |")
    lines.append(f"| {' | '.join('---' for _ in columns)} |")
    for row in table["rows"]:
        lines.append(f"| {' | '.join(escape_cell(cell) for cell in row[:MAX_TABLE_COLUMNS])} |")
    if table["column_count"] > MAX_TABLE_COLUMNS:
        lines += ["", f"_Showing the first {MAX_TABLE_COLUMNS} of {table['column_count']} columns._"]
    if table["row_count"] > len(table["rows"]):
        lines += ["", f"_Showing the first {len(table['rows'])} of {table['row_count']} rows._"]
    return "\n".join(lines)


def render_file_list(label: str, entries: list) -> list:
    if not entries:
        return []
    lines = [f"- {label}:"]
    for entry in entries:
        lines.append(f"  - `{entry['path']}` — sha256 `{entry['sha256'] or 'unavailable'}`")
    return lines


def plain_text(markdown: str) -> list:
    lines = []
    for raw in markdown.splitlines():
        line = raw.rstrip()
        if line.startswith("#"):
            text = line.lstrip("#").strip()
            if line.startswith("# "):
                lines += ["", text.upper(), "=" * min(len(text), PAGE_WIDTH)]
            elif line.startswith("## "):
                lines += ["", text.upper()]
            else:
                lines += ["", text]
            continue
        lines.append(re.sub(r"`([^`]*)`", r"\1", line))
    return lines


def paginate(lines: list) -> list:
    wrapped = []
    for line in lines:
        if not line:
            wrapped.append("")
            continue
        chunk = textwrap.wrap(line.expandtabs(4), width=PAGE_WIDTH, replace_whitespace=False, drop_whitespace=False, subsequent_indent="  ")
        wrapped.extend(chunk or [""])
    pages = [wrapped[start:start + PAGE_LINES] for start in range(0, len(wrapped), PAGE_LINES)]
    return pages or [[""]]


def render_pdf(markdown: str, destination: Path, generated_at: str, title: str) -> None:
    try:
        import matplotlib

        matplotlib.use("Agg")
        from matplotlib.backends.backend_pdf import PdfPages
        from matplotlib.figure import Figure
    except Exception as exc:  # ImportError, broken install, missing backend
        raise PdfUnavailable(f"matplotlib is not importable: {type(exc).__name__}: {exc}") from exc

    moment = datetime.datetime.strptime(generated_at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
    metadata = {
        "Title": title,
        "Creator": f"bio-report {ENGINE_VERSION}",
        "Producer": f"bio-report {ENGINE_VERSION} (matplotlib)",
        "CreationDate": moment,
        "ModDate": moment,
    }

    destination.parent.mkdir(parents=True, exist_ok=True)
    pages = paginate(plain_text(markdown))
    with PdfPages(str(destination), metadata=metadata) as pdf:
        for page in pages:
            figure = Figure(figsize=(8.5, 11))
            figure.text(0.06, 0.965, "\n".join(page), family="monospace", fontsize=7.2, va="top", ha="left", linespacing=1.35)
            pdf.savefig(figure)


def build(payload: dict) -> dict:
    warnings = []
    generated_at = resolve_generated_at()
    manifest_paths = [Path(raw) for raw in payload.get("manifests") or []]
    manifests = [load_manifest(path, warnings) for path in manifest_paths]
    tables = load_tables(payload.get("results_dirs") or [], warnings)
    figures = load_figures(payload.get("figures_dirs") or [], warnings)

    methods_path = payload.get("methods")
    methods_text = ""
    if methods_path:
        try:
            methods_text = Path(methods_path).read_text(encoding="utf-8")
        except OSError as exc:
            warning(warnings, f"methods {methods_path}: cannot be read ({exc.strerror or exc}); the section is empty")

    report = render_markdown(payload, manifests, tables, figures, methods_text, generated_at)
    output = Path(payload["output"])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(report, encoding="utf-8")

    document = {
        "schema_version": SCHEMA_VERSION,
        "ok": True,
        "outputs": {"markdown": str(output)},
        "counts": {"manifests": len(manifests), "tables": len(tables), "figures": len(figures)},
        "warnings": warnings,
    }

    pdf_path = payload.get("pdf")
    if pdf_path:
        destination = Path(pdf_path)
        try:
            render_pdf(report, destination, generated_at, payload.get("title") or "Analysis Report")
            document["outputs"]["pdf"] = str(destination)
        except PdfUnavailable as exc:
            document["ok"] = False
            document["error"] = {"code": "pdf-unavailable", "message": str(exc)}
            document["hint"] = (
                "install matplotlib into the interpreter that runs the engine "
                "(<repo>/.bioenv/bin/python -m pip install matplotlib), or drop --pdf; "
                "the Markdown report was still written"
            )
        except Exception as exc:  # noqa: BLE001 - convert any renderer failure into a contract error
            document["ok"] = False
            document["error"] = {"code": "pdf-failed", "message": f"{type(exc).__name__}: {exc}"}
            document["hint"] = "the Markdown report was still written; retry with --pdf after checking the figure paths"
    return document


def check() -> int:
    document = {
        "schema_version": SCHEMA_VERSION,
        "ok": True,
        "python": {
            "available": True,
            "path": sys.executable,
            "version": ".".join(str(part) for part in sys.version_info[:3]),
        },
    }
    try:
        import matplotlib

        document["matplotlib"] = {"available": True, "version": matplotlib.__version__, "error": None}
    except Exception as exc:  # noqa: BLE001 - any import failure means no PDF support
        document["matplotlib"] = {"available": False, "version": None, "error": f"{type(exc).__name__}: {exc}"}
    emit(document)
    return 0


def main(argv: list) -> int:
    if not argv or argv[0] not in ("build", "check"):
        sys.stderr.write("usage: engine.py build|check\n")
        return 2
    if argv[0] == "check":
        return check()

    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        emit({"schema_version": SCHEMA_VERSION, "ok": False, "error": {"code": "invalid-payload", "message": f"stdin is not valid JSON: {exc}"}})
        return 1

    try:
        document = build(payload)
    except Exception as exc:  # noqa: BLE001 - never let a traceback replace the JSON contract
        emit({
            "schema_version": SCHEMA_VERSION,
            "ok": False,
            "error": {"code": "engine-error", "message": f"{type(exc).__name__}: {exc}"},
            "hint": "check that --output and the input paths are writable and readable",
        })
        return 1
    emit(document)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
