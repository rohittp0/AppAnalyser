# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install deps (requires `protoc` on PATH — `brew install protobuf`)
pip install -r requirements.txt

# Single mode: --export is an export .zip → regenerate web/data/*.json and
# start the UI at :8765
python analyse.py --export <export.zip> --config config.example.toml

# Multi mode: --export is a folder → every .zip inside is served from a
# temp copy of web/ on port 8000+index (next free port if taken).
python analyse.py --export <folder-of-zips> --config config.example.toml

# Useful flags: --port N (single mode only), --no-open (skip auto-opening
#               browser), --no-serve (only regenerate JSON, don't start
#               HTTP server)
```

There is no test suite, linter config, or build step. Iteration loop is:
rerun `analyse.py` → refresh browser (server serves `web/` directly, so
HTML/CSS/JS edits don't require rerunning the Python).

## Architecture

Two-stage pipeline with a hard boundary between them:

1. **`analyse.py`** (Python) parses an Android app data export into JSON and
   serves the `web/` directory. All parsing happens up-front on invocation;
   the HTTP server is just `http.server.SimpleHTTPRequestHandler` rooted at
   `web/`. There is **no API** — the frontend only reads static JSON files
   from `web/data/`.

2. **`web/`** (vanilla JS, no framework, no build) fetches
   `data/index.json` on boot, then lazy-loads per-file JSON on demand with
   a `Map` cache. All DOM rendering is string concatenation + `innerHTML`;
   every interpolated value must go through `escapeHtml()`.

### Export directory shape (input to `analyse.py`)

The export is expected to contain any subset of: `databases/` (SQLite),
`datastore/` (androidx DataStore — either `*.preferences_pb` or
proto-serialised), `shared_prefs/` (XML), `logs/` (`*.ndjson`, one JSON
object per line with `ts`/`lvl`/`tag`/`msg`/`thread`/`t` for traceback).
Each section has a dedicated `analyse_*` function in `analyse.py` and
produces a matching entry in `web/data/index.json` plus per-file JSON
under `web/data/<section>/`. `web/data/` is wiped on every run.

Input is always zipped: a single export `.zip` (extracted to a temp dir,
data generated in-place into `web/data`), or a folder of `.zip`s (multi
mode — `generate_data()` writes into a temp `copytree` copy of `web/`
per zip). `resolve_export_root()` descends through single-directory
wrappers inside a zip until it finds a known section. Temp dirs live
until the servers are stopped (Ctrl-C).

### DataStore proto decoding

This is the only non-trivial part:

- `compile_protos()` shells out to `protoc` with `--include_imports` and
  `--descriptor_set_out=` to produce a `FileDescriptorSet` in a temp dir.
  It always includes a built-in `androidx.datastore.preferences` schema
  (hardcoded as `PREFERENCES_PROTO` at the top of `analyse.py`) alongside
  the user's proto files.
- `build_pool()` loads that `FileDescriptorSet` into a
  `descriptor_pool.DescriptorPool`; `decode_proto()` resolves messages
  by fully-qualified name and uses `message_factory.GetMessageClass()` +
  `json_format.MessageToJson()` (with `preserving_proto_field_name=True`).
- Each file under `datastore/` is dispatched by the config: files
  matching `datastore_preferences_glob` go through `decode_preferences()`
  (flat key/type/value via the `Value` oneof); files listed in
  `[datastore_mapping]` are decoded as their mapped proto FQN. Unmapped
  files are written with `kind: "unknown"` so the UI can tell the user
  to add them to the config — **do not silently skip them**.
- Parse errors are caught per-file and surfaced as `kind: "error"` in the
  JSON payload so they render in the UI rather than killing the run.

### Config (`config.example.toml`)

Paths in the TOML are resolved **relative to the config file**, not the
cwd (see `args.config.parent / proto_root_cfg` in `main()`). Keep this in
mind when writing new keys that reference on-disk paths.

### Frontend conventions

- Four pages (`databases`, `datastore`, `shared_prefs`, `logs`) are each
  rendered by a `render<Section>()` function in `web/js/app.js`, swapped
  in/out by `setActivePage()` toggling a `.active` class on
  `#page-<name>` divs.
- `renderKvTable()` is shared between preference-datastore files and
  shared prefs; `renderJsonTree()` uses native `<details>`/`<summary>`
  with `open` attrs controlled by depth (expanded for depth < 2).
- Log view caps DOM to 5000 rows and reports the true total; all filter
  inputs feed into a single `applyLogFilter()` that iterates `LOGS` in
  memory (the whole log array is fetched once and cached).
- `safeRegex()` returns `null` on invalid regex — callers treat `null`
  as "no filter", so bad regex silently matches everything. Don't
  change this without checking every call site.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **AppAnalyser** (110 symbols, 281 relationships, 20 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/AppAnalyser/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/AppAnalyser/context` | Codebase overview, check index freshness |
| `gitnexus://repo/AppAnalyser/clusters` | All functional areas |
| `gitnexus://repo/AppAnalyser/processes` | All execution flows |
| `gitnexus://repo/AppAnalyser/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
