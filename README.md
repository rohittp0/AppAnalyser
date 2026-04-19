# AppAnalyser

Local web UI for exploring an unzipped data export from the app
(Settings → Manage Data → Export). Shows databases, proto / preference
datastore, shared prefs, and logs in a single browser view.

## Requirements

- Python 3.11+ (for `tomllib` in the standard library)
- `protoc` on your PATH (Protocol Buffers compiler)
- `pip install -r requirements.txt` → installs the `protobuf` Python package

```bash
# macOS
brew install protobuf
# Ubuntu / Debian
sudo apt-get install -y protobuf-compiler
```

## Run

Unzip the export zip first (e.g. into `~/Downloads/ta-export/`), then:

```bash
cd AppAnalyser
pip install -r requirements.txt
python analyse.py --export ~/Downloads/ta-export --config config.example.toml
```

That parses the export into `web/data/*.json` and starts a local server at
<http://127.0.0.1:8765/>. A browser tab auto-opens unless you pass
`--no-open`. Pass `--no-serve` to only regenerate the JSON.

Other flags: `--port <n>` changes the bind port.

## Config

See `config.example.toml` for the full schema. Four keys:

- `proto_root` — path to the directory holding your `.proto` files
  (relative to the config file).
- `proto_files` — list of proto filenames inside `proto_root`; all must
  compile together (use `--include_imports`-style dependency).
- `datastore_preferences_glob` — glob that matches androidx
  datastore-preferences files (rendered as a flat key/type/value table).
- `[datastore_mapping]` — maps `<filename>` → `<proto message FQN>`
  for every proto-based datastore file you want decoded.

Any `datastore/` file that doesn't match either rule is reported as
`(binary) — add to [datastore_mapping]`.

## UI

- **Databases**: pick a SQLite file → pick a table → sticky-header table
  with per-column tooltips (SQL type, PK, NOT NULL) and "Export CSV".
- **DataStore**: proto files render as a collapsible JSON tree (with
  Expand all / Collapse all). Preference-datastore files render as a
  key / type / value table with substring filter.
- **Shared Prefs**: key / type / value table with substring filter.
- **Logs**: logcat-style viewer (colour-coded severity) with filters for
  date range (`datetime-local` inputs), tag regex, message regex, and
  per-level checkboxes (V/D/I/W/E/A). Stack traces render indented in
  dim grey below the row. Render is capped at 5000 rows; tighten
  filters to see the rest.

## Layout

```
AppAnalyser/
├── analyse.py            # parses export → web/data/*.json + serves web/
├── config.example.toml
├── requirements.txt
├── web/
│   ├── index.html
│   ├── css/style.css
│   ├── js/app.js
│   └── data/             # generated per run (git-ignored)
└── README.md
```

`web/data/` is wiped on every run. Run the script again to refresh
against a different export — no need to restart anything else.
