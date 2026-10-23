#!/usr/bin/env python3
"""Import the verified development snapshot into an isolated local D1-compatible SQLite file."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
SNAPSHOT_DIR = ROOT / ".local/cloudflare-prep/zero3-dev-2026-10-23"
MIGRATIONS_DIR = ROOT / "scripts/d1/migrations"
DEFAULT_DATABASE = SNAPSHOT_DIR / "d1-local.sqlite"

TABLE_COLUMNS: dict[str, tuple[str, ...]] = {
    "idempotency_keys": (
        "id", "actor_id", "operation", "key", "request_hash",
        "response_payload", "resource_id", "created_at",
    ),
    "occupancy_modalities": (
        "id", "name", "normalized_name", "version", "created_at", "updated_at",
    ),
    "products": (
        "id", "name", "normalized_name", "modality_id", "suggested_price_cents",
        "is_active", "version", "created_at", "updated_at",
    ),
    "sales": (
        "id", "product_id", "sale_date", "product_name", "quantity",
        "unit_amount_cents", "total_cents", "customer_name", "notes", "status",
        "cancellation_reason", "version", "created_by", "updated_by",
        "created_at", "updated_at",
    ),
    "sales_goals": (
        "id", "month", "scope_key", "product_id", "product_name", "target_cents",
        "version", "updated_at",
    ),
    "sales_refunds": (
        "id", "sale_id", "refund_date", "amount_cents", "reason", "status",
        "void_reason", "version", "created_by", "updated_by", "created_at",
        "updated_at",
    ),
    "sales_history": (
        "id", "entity_type", "entity_id", "operation", "actor_id", "before_data",
        "after_data", "created_at",
    ),
    "sales_import_batches": (
        "id", "actor_id", "source", "file_hash", "status", "row_count",
        "created_at", "completed_at",
    ),
    "occupancy_records": (
        "id", "modality_id", "kind", "date", "month", "percentage",
        "reported_percentage", "presences", "capacity", "start_time", "end_time",
        "class_name", "scope_key", "notes", "source_file_hash", "source_sheet",
        "source_cell", "source_cells", "version", "created_by", "updated_by",
        "created_at", "updated_at", "deleted_at",
    ),
    "occupancy_history": (
        "id", "entity_type", "entity_id", "operation", "actor_id", "before_data",
        "after_data", "created_at",
    ),
}

JSON_COLUMNS = {
    "idempotency_keys": {"response_payload"},
    "sales_history": {"before_data", "after_data"},
    "occupancy_records": {"source_cells"},
    "occupancy_history": {"before_data", "after_data"},
}
INTEGER_COLUMNS = {
    "occupancy_modalities": {"version"},
    "products": {"suggested_price_cents", "version"},
    "sales": {"quantity", "unit_amount_cents", "total_cents", "version"},
    "sales_goals": {"target_cents", "version"},
    "sales_refunds": {"amount_cents", "version"},
    "sales_import_batches": {"row_count"},
    "occupancy_records": {"presences", "capacity", "version"},
}
TABLE_ORDER = tuple(TABLE_COLUMNS)


class SnapshotError(RuntimeError):
    """Raised when the snapshot is invalid or does not reconcile."""


def json_dumps_with_decimals(value: Any) -> str:
    """Serialize nested JSON without converting decimal number tokens to binary floats."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(json_dumps_with_decimals(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(
            json_dumps_with_decimals(str(key)) + ":" + json_dumps_with_decimals(item)
            for key, item in value.items()
        ) + "}"
    raise SnapshotError(f"Unsupported value in JSON payload: {type(value).__name__}")


def read_snapshot(snapshot_dir: Path = SNAPSHOT_DIR) -> tuple[dict[str, Any], dict[str, list[dict[str, Any]]]]:
    manifest_path = snapshot_dir / "manifest.json"
    if not manifest_path.is_file():
        raise SnapshotError(f"Snapshot manifest not found: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("format") != "zero3-pro-development-data-snapshot" or manifest.get("version") != 1:
        raise SnapshotError("Unsupported snapshot manifest format or version.")

    tables: dict[str, list[dict[str, Any]]] = {}
    declared_tables = manifest.get("tableFiles", {})
    expected_names = set(TABLE_COLUMNS)
    if set(declared_tables) != expected_names:
        raise SnapshotError("Snapshot table list does not match the ten-table D1 schema.")

    for table in TABLE_ORDER:
        file_info = declared_tables[table]
        table_path = snapshot_dir / "tables" / f"{table}.json"
        raw = table_path.read_bytes()
        if len(raw) != file_info.get("bytes"):
            raise SnapshotError(f"Snapshot size mismatch for {table}.")
        if hashlib.sha256(raw).hexdigest() != file_info.get("sha256"):
            raise SnapshotError(f"Snapshot SHA-256 mismatch for {table}.")
        rows = json.loads(raw, parse_float=Decimal)
        if not isinstance(rows, list) or len(rows) != file_info.get("rowCount"):
            raise SnapshotError(f"Snapshot row count mismatch for {table}.")
        for row in rows:
            if not isinstance(row, dict) or set(row) != set(TABLE_COLUMNS[table]):
                raise SnapshotError(f"Unexpected columns in snapshot table {table}.")
        if manifest["manifest"]["tableCounts"].get(table) != len(rows):
            raise SnapshotError(f"Manifest table count mismatch for {table}.")
        tables[table] = rows

    return manifest, tables


def sqlite_value(table: str, column: str, value: Any) -> Any:
    if value is None:
        return None
    if (table, column) in {
        ("idempotency_keys", "request_hash"),
        ("sales_import_batches", "file_hash"),
        ("occupancy_records", "source_file_hash"),
    } and not re.fullmatch(r"[a-f0-9]{64}", value):
        raise SnapshotError(f"Invalid SHA-256 value in {table}.{column}.")
    if table == "occupancy_records" and column == "source_cell" and not re.fullmatch(
        r"[A-Z]{1,4}[1-9][0-9]*", value
    ):
        raise SnapshotError("Invalid spreadsheet source cell in occupancy_records.")
    if column in JSON_COLUMNS.get(table, set()):
        return json_dumps_with_decimals(value)
    if table == "occupancy_records" and column in {"percentage", "reported_percentage"}:
        return format(value, "f") if isinstance(value, Decimal) else str(value)
    if column == "is_active" and table == "products":
        return int(bool(value))
    if column in INTEGER_COLUMNS.get(table, set()):
        if isinstance(value, Decimal):
            if value != value.to_integral_value():
                raise SnapshotError(f"Non-integer value in {table}.{column}.")
            value = int(value)
        if isinstance(value, bool) or not isinstance(value, int):
            raise SnapshotError(f"Invalid integer in {table}.{column}.")
        if abs(value) > 9007199254740991:
            raise SnapshotError(f"Unsafe integer in {table}.{column}.")
        return value
    if isinstance(value, Decimal):
        if value == value.to_integral_value():
            return int(value)
        return format(value, "f")
    return value


def apply_migrations(connection: sqlite3.Connection, migrations_dir: Path = MIGRATIONS_DIR) -> None:
    connection.execute(
        """CREATE TABLE IF NOT EXISTS _d1_migrations (
             name TEXT PRIMARY KEY NOT NULL,
             sha256 TEXT NOT NULL,
             applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
           )"""
    )
    for migration in sorted(migrations_dir.glob("[0-9][0-9][0-9][0-9]_*.sql")):
        raw = migration.read_bytes()
        checksum = hashlib.sha256(raw).hexdigest()
        existing = connection.execute(
            "SELECT sha256 FROM _d1_migrations WHERE name = ?", (migration.name,)
        ).fetchone()
        if existing:
            if existing[0] != checksum:
                raise SnapshotError(f"Applied migration was modified: {migration.name}.")
            continue

        sql = raw.decode("utf-8")
        try:
            connection.executescript(
                "BEGIN IMMEDIATE;\n"
                + sql
                + "\nINSERT INTO _d1_migrations (name, sha256) VALUES ("
                + "'" + migration.name.replace("'", "''") + "', "
                + "'" + checksum + "');\nCOMMIT;"
            )
        except Exception:
            if connection.in_transaction:
                connection.rollback()
            raise


def calculate_metrics(tables: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    sales = tables["sales"]
    active_sales = [row for row in sales if row["status"] == "active"]
    refunds = tables["sales_refunds"]
    active_refunds = [row for row in refunds if row["status"] == "active"]
    records = tables["occupancy_records"]
    measured = [row for row in records if row["presences"] is not None and row["capacity"] is not None]
    presences = sum(int(row["presences"]) for row in measured)
    capacity = sum(int(row["capacity"]) for row in measured)
    weighted = round(presences / capacity * 100, 6) if capacity else 0
    return {
        "sales": {
            "total": len(sales),
            "active": len(active_sales),
            "activeCents": str(sum(int(row["total_cents"]) for row in active_sales)),
            "activeQuantity": str(sum(int(row["quantity"]) for row in active_sales)),
            "refunds": len(refunds),
            "activeRefunds": len(active_refunds),
            "activeRefundsCents": str(sum(int(row["amount_cents"]) for row in active_refunds)),
            "netCents": str(
                sum(int(row["total_cents"]) for row in active_sales)
                - sum(int(row["amount_cents"]) for row in active_refunds)
            ),
            "goals": len(tables["sales_goals"]),
            "products": len(tables["products"]),
            "activeProducts": sum(bool(row["is_active"]) for row in tables["products"]),
        },
        "occupancy": {
            "records": len(records),
            "daily": sum(row["kind"] == "daily" for row in records),
            "monthly": sum(row["kind"] == "monthly" for row in records),
            "measured": len(measured),
            "legacy": len(records) - len(measured),
            "presences": str(presences),
            "capacity": str(capacity),
            "weightedPercent": weighted,
        },
    }


def verify_manifest_metrics(manifest: dict[str, Any], metrics: dict[str, Any]) -> None:
    expected = manifest["manifest"]
    counts = {table: len(rows) for table, rows in metrics["_tables"].items()}
    if counts != expected["tableCounts"] or sum(counts.values()) != expected["totalRows"]:
        raise SnapshotError("Snapshot row counts do not reconcile with the manifest.")

    for group in ("sales", "occupancy"):
        for key, expected_value in expected[group].items():
            actual_value = metrics[group].get(key)
            if isinstance(expected_value, (int, float)) and not isinstance(expected_value, bool):
                matches = actual_value == expected_value
            else:
                matches = str(actual_value) == str(expected_value)
            if not matches:
                raise SnapshotError(f"Snapshot {group} metric does not reconcile: {key}.")


def validate_database_path(database_path: Path, snapshot_dir: Path = SNAPSHOT_DIR) -> Path:
    resolved = database_path.resolve()
    expected_parent = snapshot_dir.resolve()
    if resolved.parent != expected_parent or not resolved.name.startswith("d1-local") or resolved.suffix != ".sqlite":
        raise SnapshotError(
            "Safety stop: the database must be a d1-local*.sqlite file inside the ignored snapshot directory."
        )
    return resolved


def import_snapshot(database_path: Path = DEFAULT_DATABASE, snapshot_dir: Path = SNAPSHOT_DIR) -> dict[str, Any]:
    database_path = validate_database_path(database_path, snapshot_dir)
    manifest, tables = read_snapshot(snapshot_dir)

    snapshot_metrics = calculate_metrics(tables)
    metrics = {
        **snapshot_metrics,
        "_tables": tables,
    }
    verify_manifest_metrics(manifest, metrics)

    database_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        apply_migrations(connection)
        if connection.execute("PRAGMA foreign_keys").fetchone()[0] != 1:
            raise SnapshotError("SQLite foreign-key enforcement is not enabled.")

        inserted: dict[str, int] = {}
        connection.execute("BEGIN IMMEDIATE")
        for table in TABLE_ORDER:
            columns = TABLE_COLUMNS[table]
            quoted_columns = ", ".join(f'"{column}"' for column in columns)
            placeholders = ", ".join("?" for _ in columns)
            statement = (
                f'INSERT OR IGNORE INTO "{table}" ({quoted_columns}) '
                f"VALUES ({placeholders})"
            )
            inserted[table] = 0
            for row in tables[table]:
                values = tuple(sqlite_value(table, column, row[column]) for column in columns)
                cursor = connection.execute(statement, values)
                inserted[table] += max(cursor.rowcount, 0)

                stored = connection.execute(
                    f'SELECT {quoted_columns} FROM "{table}" WHERE id = ?', (row["id"],)
                ).fetchone()
                expected_values = dict(zip(columns, values))
                if stored is None or any(stored[column] != expected_values[column] for column in columns):
                    raise SnapshotError(
                        f"Existing row conflicts with the snapshot in table {table}; it was not overwritten."
                    )

        database_counts = {
            table: connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            for table in TABLE_ORDER
        }
        if database_counts != manifest["manifest"]["tableCounts"]:
            raise SnapshotError("Local database contains extra or missing rows after import.")

        database_metrics = query_database_metrics(connection)
        for group in ("sales", "occupancy"):
            for key, expected_value in manifest["manifest"][group].items():
                actual_value = database_metrics[group].get(key)
                if isinstance(expected_value, (int, float)) and not isinstance(expected_value, bool):
                    matches = actual_value == expected_value
                else:
                    matches = str(actual_value) == str(expected_value)
                if not matches:
                    raise SnapshotError(f"Imported database {group} metric does not reconcile: {key}.")

        connection.commit()
        return {
            "path": str(database_path.relative_to(ROOT)),
            "inserted": inserted,
            "counts": database_counts,
            "totalRows": sum(database_counts.values()),
            "metrics": database_metrics,
            "snapshotSha256": manifest["integrity"]["digest"],
        }
    except Exception:
        if connection.in_transaction:
            connection.rollback()
        raise
    finally:
        connection.close()


def query_database_metrics(connection: sqlite3.Connection) -> dict[str, Any]:
    sales = connection.execute(
        """SELECT COUNT(*) AS total,
                  SUM(status = 'active') AS active,
                  COALESCE(SUM(CASE WHEN status = 'active' THEN total_cents ELSE 0 END), 0) AS active_cents,
                  COALESCE(SUM(CASE WHEN status = 'active' THEN quantity ELSE 0 END), 0) AS active_quantity
           FROM sales"""
    ).fetchone()
    refunds = connection.execute(
        """SELECT COUNT(*) AS total,
                  SUM(status = 'active') AS active,
                  COALESCE(SUM(CASE WHEN status = 'active' THEN amount_cents ELSE 0 END), 0) AS active_cents
           FROM sales_refunds"""
    ).fetchone()
    product_count = connection.execute(
        "SELECT COUNT(*) AS total, COALESCE(SUM(is_active), 0) AS active FROM products"
    ).fetchone()
    records = connection.execute(
        """SELECT COUNT(*) AS total,
                  SUM(kind = 'daily') AS daily,
                  SUM(kind = 'monthly') AS monthly,
                  SUM(presences IS NOT NULL AND capacity IS NOT NULL) AS measured,
                  COALESCE(SUM(presences), 0) AS presences,
                  COALESCE(SUM(capacity), 0) AS capacity
           FROM occupancy_records"""
    ).fetchone()
    total_capacity = records["capacity"]
    return {
        "sales": {
            "total": sales["total"],
            "active": sales["active"] or 0,
            "activeCents": str(sales["active_cents"]),
            "activeQuantity": str(sales["active_quantity"]),
            "refunds": refunds["total"],
            "activeRefunds": refunds["active"] or 0,
            "activeRefundsCents": str(refunds["active_cents"]),
            "netCents": str(sales["active_cents"] - refunds["active_cents"]),
            "goals": connection.execute("SELECT COUNT(*) FROM sales_goals").fetchone()[0],
            "products": product_count["total"],
            "activeProducts": product_count["active"],
        },
        "occupancy": {
            "records": records["total"],
            "daily": records["daily"] or 0,
            "monthly": records["monthly"] or 0,
            "measured": records["measured"] or 0,
            "legacy": records["total"] - (records["measured"] or 0),
            "presences": str(records["presences"]),
            "capacity": str(total_capacity),
            "weightedPercent": round(records["presences"] / total_capacity * 100, 6) if total_capacity else 0,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--database",
        type=Path,
        default=DEFAULT_DATABASE,
        help="Local ignored database path (must be d1-local*.sqlite under the snapshot directory).",
    )
    args = parser.parse_args()
    try:
        result = import_snapshot(args.database)
    except (SnapshotError, sqlite3.Error, OSError, ValueError, KeyError) as error:
        print(f"Import failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
