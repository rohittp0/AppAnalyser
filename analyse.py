#!/usr/bin/env python3
"""AppAnalyser — parse an unzipped app data export and serve a local HTML UI."""

from __future__ import annotations

import argparse
import base64
import http.server
import json
import shutil
import socketserver
import sqlite3
import subprocess
import sys
import tempfile
import threading
import tomllib
import webbrowser
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any

from google.protobuf import descriptor_pb2, descriptor_pool, json_format, message_factory


PREFERENCES_PROTO = """\
syntax = "proto2";
package androidx.datastore.preferences;

message PreferenceMap {
  map<string, Value> preferences = 1;
}
message Value {
  oneof value {
    bool boolean = 1;
    float float = 2;
    int32 integer = 3;
    int64 long = 4;
    string string = 5;
    StringSet string_set = 6;
    double double = 7;
    bytes bytes = 8;
  }
}
message StringSet {
  repeated string strings = 1;
}
"""


def load_config(path: Path) -> dict:
    with open(path, "rb") as fh:
        return tomllib.load(fh)


def compile_protos(proto_root: Path | None, proto_files: list[str], tmp: Path) -> Path:
    pref = tmp / "androidx_datastore_preferences.proto"
    pref.write_text(PREFERENCES_PROTO)
    out = tmp / "descriptors.pb"
    cmd: list[str] = ["protoc", "-I", str(tmp), "--include_imports",
                      f"--descriptor_set_out={out}"]
    if proto_root is not None and proto_files:
        cmd[3:3] = ["-I", str(proto_root)]
        cmd.extend(str(proto_root / p) for p in proto_files)
    cmd.append(str(pref))
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True)
    except FileNotFoundError as exc:
        raise SystemExit("protoc not found on PATH. Install protobuf compiler.") from exc
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"protoc failed:\n{exc.stderr}") from exc
    return out


def build_pool(desc_path: Path) -> descriptor_pool.DescriptorPool:
    pool = descriptor_pool.DescriptorPool()
    with open(desc_path, "rb") as fh:
        fds = descriptor_pb2.FileDescriptorSet.FromString(fh.read())
    for file in fds.file:
        pool.Add(file)
    return pool


def decode_proto(pool: descriptor_pool.DescriptorPool, fqn: str, raw: bytes) -> Any:
    desc = pool.FindMessageTypeByName(fqn)
    cls = message_factory.GetMessageClass(desc)
    msg = cls()
    msg.ParseFromString(raw)
    return json.loads(
        json_format.MessageToJson(msg, preserving_proto_field_name=True, indent=None)
    )


def decode_preferences(pool, raw: bytes) -> list[dict]:
    desc = pool.FindMessageTypeByName("androidx.datastore.preferences.PreferenceMap")
    cls = message_factory.GetMessageClass(desc)
    msg = cls()
    msg.ParseFromString(raw)
    out: list[dict] = []
    for key, val in msg.preferences.items():
        field = val.WhichOneof("value")
        if field is None:
            t, v = "null", None
        elif field == "string_set":
            t, v = "string_set", list(val.string_set.strings)
        elif field == "bytes":
            t, v = "bytes", base64.b64encode(val.bytes).decode()
        else:
            t = field
            v = getattr(val, field)
        out.append({"key": key, "type": t, "value": v})
    out.sort(key=lambda r: r["key"])
    return out


def stringify_sql(v: Any) -> Any:
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, bytes):
        return f"<bytes:{len(v)} b64:{base64.b64encode(v).decode()[:64]}…>"
    return str(v)


# --------------------------------------------------------------------------
# Per-section analysers

def analyse_databases(root: Path, out_dir: Path) -> list[dict]:
    db_dir = root / "databases"
    if not db_dir.is_dir():
        return []
    out_dir.mkdir(parents=True, exist_ok=True)
    summaries: list[dict] = []
    skip_suffixes = ("-journal", "-wal", "-shm")
    for path in sorted(db_dir.iterdir()):
        if not path.is_file() or path.name.endswith(skip_suffixes):
            continue
        try:
            data = _read_sqlite(path)
        except sqlite3.DatabaseError:
            continue
        out_file = out_dir / f"{path.name}.json"
        out_file.write_text(json.dumps(data))
        summaries.append({
            "name": path.name,
            "file": f"databases/{path.name}.json",
            "tables": [t["name"] for t in data["tables"]],
        })
    return summaries


def _read_sqlite(path: Path) -> dict:
    conn = sqlite3.connect(path)
    conn.text_factory = lambda b: b.decode("utf-8", errors="replace")
    cur = conn.cursor()
    names = [r[0] for r in cur.execute(
        "SELECT name FROM sqlite_master WHERE type='table' "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()]
    tables: list[dict] = []
    for name in names:
        cols = cur.execute(f'PRAGMA table_info("{name}")').fetchall()
        columns = [
            {"name": c[1], "type": c[2] or "", "notnull": bool(c[3]), "pk": bool(c[5])}
            for c in cols
        ]
        try:
            rows = cur.execute(f'SELECT * FROM "{name}"').fetchall()
        except sqlite3.DatabaseError:
            rows = []
        rows = [[stringify_sql(v) for v in row] for row in rows]
        tables.append({"name": name, "columns": columns, "rows": rows})
    conn.close()
    return {"name": path.name, "tables": tables}


def analyse_shared_prefs(root: Path, out_dir: Path) -> list[dict]:
    sp_dir = root / "shared_prefs"
    if not sp_dir.is_dir():
        return []
    out_dir.mkdir(parents=True, exist_ok=True)
    summaries: list[dict] = []
    for path in sorted(sp_dir.glob("*.xml")):
        try:
            entries = _parse_shared_prefs(path)
        except ET.ParseError:
            continue
        out_file = out_dir / f"{path.name}.json"
        out_file.write_text(json.dumps({"name": path.name, "entries": entries}))
        summaries.append({
            "name": path.name,
            "file": f"shared_prefs/{path.name}.json",
            "entries": len(entries),
        })
    return summaries


def _parse_shared_prefs(path: Path) -> list[dict]:
    tree = ET.parse(path)
    entries: list[dict] = []
    for child in tree.getroot():
        tag = child.tag
        key = child.attrib.get("name", "?")
        if tag == "string":
            entries.append({"key": key, "type": "string", "value": child.text or ""})
        elif tag == "boolean":
            entries.append({"key": key, "type": "boolean",
                            "value": child.attrib.get("value") == "true"})
        elif tag in ("int", "long"):
            entries.append({"key": key, "type": tag,
                            "value": int(child.attrib.get("value", "0"))})
        elif tag == "float":
            entries.append({"key": key, "type": "float",
                            "value": float(child.attrib.get("value", "0"))})
        elif tag == "set":
            entries.append({"key": key, "type": "string_set",
                            "value": [c.text or "" for c in child]})
        else:
            entries.append({"key": key, "type": tag, "value": None})
    entries.sort(key=lambda r: r["key"])
    return entries


def analyse_datastore(root: Path, out_dir: Path, pool, config: dict) -> list[dict]:
    ds_dir = root / "datastore"
    if not ds_dir.is_dir():
        return []
    out_dir.mkdir(parents=True, exist_ok=True)
    mapping = config.get("datastore_mapping", {})
    pref_glob = config.get("datastore_preferences_glob", "*.preferences_pb")
    summaries: list[dict] = []
    for path in sorted(ds_dir.iterdir()):
        if not path.is_file():
            continue
        raw = path.read_bytes()
        payload: dict = {"name": path.name}
        try:
            if path.match(pref_glob):
                entries = decode_preferences(pool, raw)
                payload["kind"] = "preferences"
                payload["entries"] = entries
                size = len(entries)
            elif path.name in mapping:
                fqn = mapping[path.name]
                payload["kind"] = f"proto:{fqn}"
                payload["json"] = decode_proto(pool, fqn, raw)
                size = _tree_node_count(payload["json"])
            else:
                payload["kind"] = "unknown"
                payload["json"] = {
                    "(binary)": f"{len(raw)} bytes — add to [datastore_mapping] in config",
                }
                size = 1
        except Exception as exc:  # noqa: BLE001 — surface parse errors in UI
            payload["kind"] = "error"
            payload["error"] = str(exc)
            size = 0
        out_file = out_dir / f"{path.name}.json"
        out_file.write_text(json.dumps(payload))
        summaries.append({
            "name": path.name,
            "kind": payload["kind"],
            "file": f"datastore/{path.name}.json",
            "size": size,
        })
    return summaries


def _tree_node_count(obj: Any) -> int:
    if isinstance(obj, dict):
        return 1 + sum(_tree_node_count(v) for v in obj.values())
    if isinstance(obj, list):
        return 1 + sum(_tree_node_count(v) for v in obj)
    return 1


def analyse_meta(root: Path, data_dir: Path) -> dict:
    path = root / "meta.json"
    if not path.is_file():
        return {"present": False}
    try:
        meta = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        return {"present": True, "error": f"invalid JSON: {exc}"}
    (data_dir / "meta.json").write_text(json.dumps(meta))
    return {
        "present": True,
        "file": "meta.json",
        "applicationId": meta.get("applicationId"),
        "versionName": meta.get("versionName"),
        "exportedAt": meta.get("exportedAt"),
    }


def analyse_logs(root: Path, data_dir: Path) -> dict:
    logs_dir = root / "logs"
    if not logs_dir.is_dir():
        return {"count": 0, "file": None}
    entries: list[dict] = []
    for path in sorted(logs_dir.rglob("*.ndjson")):
        for raw in path.read_text(errors="replace").splitlines():
            raw = raw.strip()
            if not raw:
                continue
            try:
                entries.append(json.loads(raw))
            except json.JSONDecodeError:
                continue
    entries.sort(key=lambda e: e.get("ts", ""))
    out_file = data_dir / "logs.json"
    out_file.write_text(json.dumps(entries))
    return {"count": len(entries), "file": "logs.json"}


# --------------------------------------------------------------------------
# Export resolution & data generation

EXPORT_MARKERS = ("databases", "datastore", "shared_prefs", "logs", "meta.json")


def resolve_export_root(root: Path) -> Path:
    """Descend through single-directory wrappers (as zips often add one)
    until a directory containing a known export section is found."""
    cur = root
    while not any((cur / m).exists() for m in EXPORT_MARKERS):
        children = [p for p in cur.iterdir()
                    if p.name not in ("__MACOSX",) and not p.name.startswith(".")]
        if len(children) == 1 and children[0].is_dir():
            cur = children[0]
        else:
            break
    return cur


def extract_zip(zip_path: Path, dest: Path) -> Path:
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(dest)
    return resolve_export_root(dest)


def generate_data(export_root: Path, data_dir: Path, pool, config: dict) -> dict:
    # Wipe previously generated data (keep data_dir itself).
    if data_dir.exists():
        for child in data_dir.rglob("*"):
            if child.is_file():
                child.unlink()
    data_dir.mkdir(parents=True, exist_ok=True)
    index = {
        "export": str(export_root.resolve()),
        "meta":        analyse_meta(export_root, data_dir),
        "databases":   analyse_databases(export_root, data_dir / "databases"),
        "datastore":   analyse_datastore(export_root, data_dir / "datastore", pool, config),
        "shared_prefs": analyse_shared_prefs(export_root, data_dir / "shared_prefs"),
        "logs":        analyse_logs(export_root, data_dir),
    }
    (data_dir / "index.json").write_text(json.dumps(index))
    return index


# --------------------------------------------------------------------------
# Server

def _make_handler(web_dir: Path) -> type:
    # Serve from the given directory regardless of cwd.
    class Handler(http.server.SimpleHTTPRequestHandler):  # type: ignore[misc]
        def __init__(self, *a, **kw):  # noqa: D401
            super().__init__(*a, directory=str(web_dir), **kw)

        def log_message(self, fmt, *args):  # silence default stderr spam
            sys.stderr.write(f"  {self.address_string()} {fmt % args}\n")

    return Handler


class _Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True  # rebind ports stuck in TIME_WAIT after a restart
    daemon_threads = True


def _bind_server(preferred: int, web_dir: Path,
                 max_tries: int = 50) -> tuple[socketserver.ThreadingTCPServer, int]:
    """Bind to `preferred`, or the next free port above it if taken."""
    for port in range(preferred, preferred + max_tries):
        try:
            return _Server(("127.0.0.1", port), _make_handler(web_dir)), port
        except OSError:
            continue
    raise SystemExit(f"no free port in range {preferred}-{preferred + max_tries - 1}")


def serve(port: int, web_dir: Path, open_browser: bool) -> None:
    httpd, port = _bind_server(port, web_dir)
    with httpd:
        url = f"http://127.0.0.1:{port}/"
        print(f"AppAnalyser serving at {url}  (Ctrl-C to stop)")
        if open_browser:
            threading.Timer(0.4, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()


def serve_multi(entries: list[tuple[str, int, Path]], open_browser: bool) -> None:
    """Serve several web copies at once: (name, port, web_dir) per export."""
    servers: list[socketserver.ThreadingTCPServer] = []
    try:
        for name, port, web_dir in entries:
            httpd, port = _bind_server(port, web_dir)
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            servers.append(httpd)
            url = f"http://127.0.0.1:{port}/"
            print(f"AppAnalyser serving {name} at {url}")
            if open_browser:
                threading.Timer(0.4, lambda u=url: webbrowser.open(u)).start()
        print("Ctrl-C to stop all servers.")
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            print()
    finally:
        for httpd in servers:
            httpd.shutdown()
            httpd.server_close()


# --------------------------------------------------------------------------

MULTI_BASE_PORT = 8000


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--export", required=True, type=Path,
                    help="A single export .zip (single mode, served at --port), or a "
                         "folder of export .zips — each zip is served from a temp copy "
                         f"of web/ on ports {MULTI_BASE_PORT}, {MULTI_BASE_PORT + 1}, …")
    ap.add_argument("--config", required=True, type=Path, help="TOML config file.")
    ap.add_argument("--port", type=int, default=8765,
                    help="Port for single mode (ignored in multi-zip mode).")
    ap.add_argument("--no-open", action="store_true", help="Do not auto-open a browser.")
    ap.add_argument("--no-serve", action="store_true",
                    help="Only regenerate data JSON, do not start the HTTP server.")
    args = ap.parse_args()

    path: Path = args.export
    single_zip: Path | None = None
    zips: list[Path] = []
    if path.is_file() and zipfile.is_zipfile(path):
        single_zip = path
    elif path.is_dir():
        zips = sorted(p for p in path.glob("*.zip") if zipfile.is_zipfile(p))
        if not zips:
            raise SystemExit(f"{path} contains no .zip files")
    else:
        raise SystemExit(f"{path} is neither a zip file nor a directory")

    config = load_config(args.config)

    script_dir = Path(__file__).resolve().parent
    web_dir = script_dir / "web"

    with tempfile.TemporaryDirectory(prefix="appanalyser_") as tmp_s:
        tmp = Path(tmp_s)
        proto_root_cfg = config.get("proto_root")
        proto_root = (args.config.parent / proto_root_cfg).resolve() if proto_root_cfg else None
        proto_files = config.get("proto_files", [])
        proto_tmp = tmp / "protos"
        proto_tmp.mkdir()
        desc_path = compile_protos(proto_root, proto_files, proto_tmp)
        pool = build_pool(desc_path)

        if single_zip:
            root = extract_zip(single_zip, tmp / "export")
            index = generate_data(root, web_dir / "data", pool, config)
            _print_summary(index)
            if args.no_serve:
                return 0
            serve(args.port, web_dir, open_browser=not args.no_open)
            return 0

        entries: list[tuple[str, int, Path]] = []
        for i, zip_path in enumerate(zips):
            root = extract_zip(zip_path, tmp / f"export_{i}")
            web_copy = tmp / f"web_{i}"
            # Copy web/ without stale generated data; each copy gets its own data/.
            shutil.copytree(
                web_dir, web_copy,
                ignore=lambda d, names: ["data"] if Path(d) == web_dir else [],
            )
            index = generate_data(root, web_copy / "data", pool, config)
            print(f"[{zip_path.name}]")
            _print_summary(index)
            entries.append((zip_path.name, MULTI_BASE_PORT + i, web_copy))

        if args.no_serve:
            print("--no-serve: generated data lives in a temp dir and is discarded on exit.")
            return 0
        serve_multi(entries, open_browser=not args.no_open)
    return 0


def _print_summary(index: dict) -> None:
    dbs = index["databases"]
    ds = index["datastore"]
    sp = index["shared_prefs"]
    lg = index["logs"]
    meta = index["meta"]
    if meta.get("present") and not meta.get("error"):
        print(f"App: {meta.get('applicationId')} {meta.get('versionName')} "
              f"· exported {meta.get('exportedAt')}")
    elif meta.get("error"):
        print(f"  ! meta.json: {meta['error']}")
    else:
        print("No meta.json in export.")
    print(f"Parsed: {len(dbs)} databases, {len(ds)} datastore files, "
          f"{len(sp)} shared-prefs files, {lg['count']} log entries.")
    unknown = [d for d in ds if d.get("kind") == "unknown"]
    if unknown:
        print(f"  ! {len(unknown)} datastore file(s) have no mapping — "
              f"add them to [datastore_mapping] in the config:")
        for d in unknown:
            print(f"    - {d['name']}")
    errors = [d for d in ds if d.get("kind") == "error"]
    for d in errors:
        print(f"  ! parse error in {d['name']} (shown in UI)")


if __name__ == "__main__":
    sys.exit(main())
