#!/usr/bin/env python3
"""
django-parser.py — Django migration AST walker for verify.

Reads Django migration files from a corpus root and emits one JSONL row per
file describing the ordered list of operations and metadata that the
TypeScript runner will convert into verify's MigrationOp form and feed to the
existing safety gate.

Scope: minimum needed to make DM-15 (DROP COLUMN with FK dependents) meaningful
on Read the Docs. CreateModel / AddField / RemoveField / DeleteModel /
RenameField / RenameModel / AlterField are extracted. Other operations are
recorded as 'unsupported' so the runner can skip them without losing ordering.

Metadata captured per file:
  - safe_after_deploy: bool | None — whether the class declares
    `safe = Safe.after_deploy(...)` (or any `Safe.<attr>()` call treated as
    deploy-window-sensitive by django_safemigrate). None if no `safe =` seen.
  - dependencies: list of [app_label, migration_name] from the Migration class.

Output: JSONL to stdout, one row per migration file, in deterministic order
(sorted by app then file name). The runner is responsible for dependency
ordering.

Usage:
  python3 django-parser.py <corpus_root>

Example:
  python3 django-parser.py scripts/mvp-migration/corpus/_repos/readthedocs/readthedocs
"""
from __future__ import annotations

import ast
import json
import sys
from pathlib import Path
from typing import Any

# Django model default table-name convention: "{app_label}_{model_name_lower}".
# Meta.db_table overrides are a known limitation for this first pass.
def default_table_name(app_label: str, model_name: str) -> str:
    return f"{app_label}_{model_name.lower()}"


def literal(node: ast.AST) -> Any:
    """Best-effort literal evaluation. Returns None if not a pure literal."""
    try:
        return ast.literal_eval(node)
    except Exception:
        return None


def kwarg_value(call: ast.Call, name: str) -> Any:
    for kw in call.keywords:
        if kw.arg == name:
            return literal(kw.value)
    return None


def op_class_name(call: ast.Call) -> str | None:
    """Return the final attribute/name of an operations-list Call node.

    Handles `migrations.RemoveField(...)` and bare `RemoveField(...)`.
    """
    f = call.func
    if isinstance(f, ast.Attribute):
        return f.attr
    if isinstance(f, ast.Name):
        return f.id
    return None


def extract_field_type(call_node: ast.AST) -> str | None:
    """For AlterField/AddField, field=models.X(...) — return 'X' lowercased.

    Returns None when the field argument is not a simple models.X(...) call.
    """
    if not isinstance(call_node, ast.Call):
        return None
    f = call_node.func
    if isinstance(f, ast.Attribute):
        return f.attr
    if isinstance(f, ast.Name):
        return f.id
    return None


def extract_field_call(call: ast.Call, name: str) -> ast.AST | None:
    """Return the raw AST node passed as the keyword `name` (e.g. `field=...`)."""
    for kw in call.keywords:
        if kw.arg == name:
            return kw.value
    return None


def extract_field_nullability(call_node: ast.AST) -> bool | None:
    """For a models.X(...) field call, return the value of the `null=` kwarg.

    Returns True if `null=True`, False if `null=False` is explicit, and None
    if the field call is not a Call node, is not a simple kwarg-literal form,
    or does not specify `null=` at all.

    Django's default when `null=` is unspecified is False (required), but
    the caller may want to treat None and False differently — e.g., when
    tracking field-state transitions across migrations, an unspecified value
    should inherit the existing state rather than override it to False.
    """
    if not isinstance(call_node, ast.Call):
        return None
    for kw in call_node.keywords:
        if kw.arg == "null":
            v = literal(kw.value)
            if isinstance(v, bool):
                return v
    return None


def is_safe_after_deploy(value: ast.AST) -> bool:
    """Return True if `value` is `Safe.<attr>()` call chain (Safe.after_deploy,
    Safe.before_deploy, Safe.always, etc.) — any explicit Safe annotation.

    We record presence of the annotation, not its specific flavor. The runner
    and classifier decide what to do with it.
    """
    if not isinstance(value, ast.Call):
        return False
    f = value.func
    if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name) and f.value.id == "Safe":
        return True
    return False


def parse_operations(ops_list: ast.List, app_label: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for elt in ops_list.elts:
        if not isinstance(elt, ast.Call):
            continue
        cls = op_class_name(elt)
        if cls is None:
            continue
        line = getattr(elt, "lineno", 0)
        row: dict[str, Any] = {"django_op": cls, "line": line}

        if cls == "CreateModel":
            name = kwarg_value(elt, "name")
            if isinstance(name, str):
                row["table"] = default_table_name(app_label, name)
                row["model_name"] = name
            # Columns: we don't introspect field types for first pass — the
            # grounding gate only needs column names to exist. The runner will
            # create columns with type='unknown' and nullable=True.
            fields_node = extract_field_call(elt, "fields")
            cols: list[dict[str, Any]] = []
            fks: list[dict[str, Any]] = []
            if isinstance(fields_node, ast.List):
                for f_elt in fields_node.elts:
                    # Each entry is a 2-tuple: (name, models.X(...))
                    if isinstance(f_elt, ast.Tuple) and len(f_elt.elts) == 2:
                        fname_node, fcall = f_elt.elts
                        fname = literal(fname_node)
                        ftype = extract_field_type(fcall)
                        if isinstance(fname, str) and ftype:
                            cols.append({
                                "name": fname,
                                "type": ftype.lower(),
                                "nullable": extract_field_nullability(fcall),
                            })
                            # ForeignKey / OneToOneField — record FK to a target
                            # model. We do not resolve cross-app targets here;
                            # the runner resolves to table name from `to=`.
                            if ftype in ("ForeignKey", "OneToOneField") and isinstance(fcall, ast.Call):
                                to_val = None
                                # `to` may be first positional or keyword
                                if fcall.args:
                                    to_val = literal(fcall.args[0])
                                if to_val is None:
                                    to_val = kwarg_value(fcall, "to")
                                if isinstance(to_val, str):
                                    fks.append({"column": fname, "to": to_val})
            row["columns"] = cols
            row["foreign_keys"] = fks

        elif cls == "DeleteModel":
            name = kwarg_value(elt, "name")
            if isinstance(name, str):
                row["table"] = default_table_name(app_label, name)
                row["model_name"] = name

        elif cls == "AddField":
            mname = kwarg_value(elt, "model_name")
            fname = kwarg_value(elt, "name")
            if isinstance(mname, str):
                row["table"] = default_table_name(app_label, mname)
                row["model_name"] = mname
            if isinstance(fname, str):
                row["column"] = fname
            fcall = extract_field_call(elt, "field")
            ftype = extract_field_type(fcall) if fcall is not None else None
            row["field_type"] = ftype.lower() if ftype else None
            row["nullable"] = extract_field_nullability(fcall) if fcall is not None else None
            # Record FK target if this AddField creates a relation
            if ftype in ("ForeignKey", "OneToOneField") and isinstance(fcall, ast.Call):
                to_val = literal(fcall.args[0]) if fcall.args else kwarg_value(fcall, "to")
                if isinstance(to_val, str):
                    row["fk_to"] = to_val

        elif cls == "RemoveField":
            mname = kwarg_value(elt, "model_name")
            fname = kwarg_value(elt, "name")
            if isinstance(mname, str):
                row["table"] = default_table_name(app_label, mname)
                row["model_name"] = mname
            if isinstance(fname, str):
                row["column"] = fname

        elif cls == "AlterField":
            mname = kwarg_value(elt, "model_name")
            fname = kwarg_value(elt, "name")
            if isinstance(mname, str):
                row["table"] = default_table_name(app_label, mname)
                row["model_name"] = mname
            if isinstance(fname, str):
                row["column"] = fname
            fcall = extract_field_call(elt, "field")
            ftype = extract_field_type(fcall) if fcall is not None else None
            row["field_type"] = ftype.lower() if ftype else None
            row["nullable"] = extract_field_nullability(fcall) if fcall is not None else None

        elif cls == "RenameField":
            mname = kwarg_value(elt, "model_name")
            old = kwarg_value(elt, "old_name")
            new = kwarg_value(elt, "new_name")
            if isinstance(mname, str):
                row["table"] = default_table_name(app_label, mname)
                row["model_name"] = mname
            if isinstance(old, str):
                row["column"] = old
            if isinstance(new, str):
                row["new_name"] = new

        elif cls == "RenameModel":
            old = kwarg_value(elt, "old_name")
            new = kwarg_value(elt, "new_name")
            if isinstance(old, str):
                row["table"] = default_table_name(app_label, old)
                row["old_model_name"] = old
            if isinstance(new, str):
                row["new_name"] = default_table_name(app_label, new)
                row["new_model_name"] = new

        elif cls == "SeparateDatabaseAndState":
            # The state_operations are state-only (no SQL emitted). Per handoff,
            # this is the dominant Saleor FP pattern. Record the marker so the
            # runner/classifier can see it, but do not emit sub-operations.
            row["state_only"] = True

        else:
            # AddConstraint, RemoveConstraint, RunSQL, RunPython, AddIndex,
            # RemoveIndex, AlterModelOptions, AlterUniqueTogether, etc.
            row["unsupported"] = True

        out.append(row)
    return out


def parse_migration_file(path: Path, app_label: str) -> dict[str, Any] | None:
    try:
        src = path.read_text(encoding="utf-8")
    except Exception as e:
        return {"file": str(path), "parse_error": f"read: {e}"}
    try:
        tree = ast.parse(src, filename=str(path))
    except SyntaxError as e:
        return {"file": str(path), "parse_error": f"syntax: {e}"}

    # Find `class Migration(...):`
    mig_cls: ast.ClassDef | None = None
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == "Migration":
            mig_cls = node
            break
    if mig_cls is None:
        return None  # Not a migration file (or unusual layout) — skip silently.

    operations: list[dict[str, Any]] = []
    dependencies: list[list[str]] = []
    safe_after_deploy: bool | None = None

    for stmt in mig_cls.body:
        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1:
            tgt = stmt.targets[0]
            if isinstance(tgt, ast.Name):
                if tgt.id == "operations" and isinstance(stmt.value, ast.List):
                    operations = parse_operations(stmt.value, app_label)
                elif tgt.id == "dependencies" and isinstance(stmt.value, ast.List):
                    dep_val = literal(stmt.value)
                    if isinstance(dep_val, list):
                        for d in dep_val:
                            if isinstance(d, (list, tuple)) and len(d) == 2:
                                dependencies.append([str(d[0]), str(d[1])])
                elif tgt.id == "safe":
                    safe_after_deploy = is_safe_after_deploy(stmt.value)
        elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
            # `safe: Safe = Safe.after_deploy()` style
            if stmt.target.id == "safe" and stmt.value is not None:
                safe_after_deploy = is_safe_after_deploy(stmt.value)

    return {
        "file": str(path),
        "app": app_label,
        "name": path.stem,
        "dependencies": dependencies,
        "safe_after_deploy": safe_after_deploy,
        "operations": operations,
    }


def walk_corpus(root: Path) -> list[dict[str, Any]]:
    """Enumerate migration files under <root>/*/migrations/*.py.

    App label = the directory name two levels up from the file (the parent of
    the `migrations/` dir).
    """
    rows: list[dict[str, Any]] = []
    files = sorted(root.glob("*/migrations/*.py"))
    for f in files:
        if f.name == "__init__.py":
            continue
        app_label = f.parent.parent.name
        row = parse_migration_file(f, app_label)
        if row is not None:
            rows.append(row)
    return rows


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: django-parser.py <corpus_root>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    if not root.is_dir():
        print(f"not a directory: {root}", file=sys.stderr)
        return 2
    rows = walk_corpus(root)
    for row in rows:
        sys.stdout.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(
        f"[django-parser] {len(rows)} migration files parsed from {root}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
