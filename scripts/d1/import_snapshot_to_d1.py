#!/usr/bin/env python3
"""Apply the verified snapshot to Wrangler's local D1 database only."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import import_snapshot as snapshot


ROOT = snapshot.ROOT
SNAPSHOT_DIR = snapshot.SNAPSHOT_DIR
CONFIG = ROOT / "scripts/d1/wrangler.toml"
WRANGLER = ROOT / "scripts/node_modules/.bin/wrangler"
DATABASE = "zero3-pro-local-copy"
PERSIST_DIR = SNAPSHOT_DIR / "wrangler-state"
ROWS_PER_INSERT = 25


class WranglerD1Error(RuntimeError):
    pass


def run_wrangler(arguments: list[str]) -> str:
    if not WRANGLER.is_file():
        raise WranglerD1Error("Wrangler is not installed in the workspace scripts package.")
    command = [
        str(WRANGLER),
        *arguments,
        "--local",
        "--persist-to",
        str(PERSIST_DIR),
        "--config",
        str(CONFIG),
        "--cwd",
        str(ROOT),
    ]
    result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        raise WranglerD1Error(
            f"Wrangler local D1 command failed (exit {result.returncode}); no remote command was issued."
        )
    return result.stdout.strip()


def sql_literal(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        raise WranglerD1Error("Binary floating-point values are not accepted in migration SQL.")
    return "'" + str(value).replace("'", "''") + "'"


def fetch_table(table: str) -> list[dict[str, Any]]:
    columns = snapshot.TABLE_COLUMNS[table]
    query = f'SELECT {", ".join(f"{column}" for column in columns)} FROM "{table}" ORDER BY id'
    raw = run_wrangler(
        [
            "d1",
            "execute",
            DATABASE,
            "--command",
            query,
            "--json",
        ]
    )
    try:
        response = json.loads(raw)
        results = response[0]["results"]
    except (json.JSONDecodeError, IndexError, KeyError, TypeError) as error:
        raise WranglerD1Error(f"Unexpected local D1 response while reading {table}.") from error
    if not isinstance(results, list):
        raise WranglerD1Error(f"Unexpected local D1 result set for {table}.")
    return results


def values_for_row(table: str, row: dict[str, Any]) -> tuple[Any, ...]:
    return tuple(
        snapshot.sqlite_value(table, column, row[column])
        for column in snapshot.TABLE_COLUMNS[table]
    )


def compare_rows(table: str, expected: list[dict[str, Any]], actual: list[dict[str, Any]]) -> None:
    columns = snapshot.TABLE_COLUMNS[table]
    expected_by_id = {row["id"]: dict(zip(columns, values_for_row(table, row))) for row in expected}
    if len(expected_by_id) != len(expected):
        raise WranglerD1Error(f"Duplicate source ID in snapshot table {table}.")
    for row in actual:
        row_id = row.get("id")
        expected_row = expected_by_id.get(row_id)
        if expected_row is None:
            raise WranglerD1Error(
                f"Local D1 table {table} contains a row not present in the verified snapshot."
            )
        if any(row.get(column) != expected_row[column] for column in columns):
            raise WranglerD1Error(
                f"Local D1 row conflict in {table}; import stopped without overwriting it."
            )


def preflight(tables: dict[str, list[dict[str, Any]]]) -> None:
    # Check every pre-existing row before inserting anything, so conflicts cannot leave a partial load.
    for table in snapshot.TABLE_ORDER:
        compare_rows(table, tables[table], fetch_table(table))


def write_import_files(tables: dict[str, list[dict[str, Any]]], directory: Path) -> int:
    file_count = 0
    for table in snapshot.TABLE_ORDER:
        columns = snapshot.TABLE_COLUMNS[table]
        quoted_columns = ", ".join(f'"{column}"' for column in columns)
        rows = tables[table]
        for offset in range(0, len(rows), ROWS_PER_INSERT):
            statements = []
            for row in rows[offset : offset + ROWS_PER_INSERT]:
                values = values_for_row(table, row)
                literal_values = ", ".join(sql_literal(value) for value in values)
                statements.append(
                    f'INSERT INTO "{table}" ({quoted_columns}) VALUES ({literal_values}) '
                    "ON CONFLICT(id) DO NOTHING;"
                )
            sql_path = directory / f"{table}-{offset:06d}.sql"
            sql_path.write_text("\n".join(statements) + "\n", encoding="utf-8")
            run_wrangler(
                [
                    "d1",
                    "execute",
                    DATABASE,
                    "--file",
                    str(sql_path),
                ]
            )
            file_count += 1
    return file_count


def verify_database(
    manifest: dict[str, Any], tables: dict[str, list[dict[str, Any]]]
) -> dict[str, Any]:
    for table in snapshot.TABLE_ORDER:
        compare_rows(table, tables[table], fetch_table(table))

    results = run_wrangler(
        [
            "d1",
            "execute",
            DATABASE,
            "--command",
            """SELECT
                 (SELECT COUNT(*) FROM sales) AS sales_total,
                 (SELECT COUNT(*) FROM sales WHERE status = 'active') AS sales_active,
                 (SELECT COALESCE(SUM(total_cents), 0) FROM sales WHERE status = 'active') AS sales_cents,
                 (SELECT COALESCE(SUM(quantity), 0) FROM sales WHERE status = 'active') AS sales_quantity,
                 (SELECT COUNT(*) FROM sales_refunds) AS refunds,
                 (SELECT COUNT(*) FROM sales_refunds WHERE status = 'active') AS refunds_active,
                 (SELECT COALESCE(SUM(amount_cents), 0) FROM sales_refunds WHERE status = 'active') AS refunds_active_cents,
                 (SELECT COALESCE(SUM(total_cents), 0) FROM sales WHERE status = 'active')
                   - (SELECT COALESCE(SUM(amount_cents), 0) FROM sales_refunds WHERE status = 'active') AS net_cents,
                 (SELECT COUNT(*) FROM sales_goals) AS goals,
                 (SELECT COUNT(*) FROM products) AS products,
                 (SELECT COALESCE(SUM(is_active), 0) FROM products) AS products_active,
                 (SELECT COUNT(*) FROM occupancy_records) AS occupancy_records,
                 (SELECT COUNT(*) FROM occupancy_records WHERE kind = 'daily') AS occupancy_daily,
                 (SELECT COUNT(*) FROM occupancy_records WHERE kind = 'monthly') AS occupancy_monthly,
                 (SELECT COUNT(*) FROM occupancy_records WHERE presences IS NOT NULL AND capacity IS NOT NULL) AS occupancy_measured,
                 (SELECT COUNT(*) FROM occupancy_records)
                   - (SELECT COUNT(*) FROM occupancy_records WHERE presences IS NOT NULL AND capacity IS NOT NULL) AS occupancy_legacy,
                 (SELECT COALESCE(SUM(presences), 0) FROM occupancy_records) AS occupancy_presences,
                 (SELECT COALESCE(SUM(capacity), 0) FROM occupancy_records) AS occupancy_capacity,
                 (SELECT COUNT(*) FROM occupancy_history) AS occupancy_history,
                 (SELECT COUNT(*) FROM sales_history) AS sales_history,
                 (SELECT COUNT(*) FROM idempotency_keys) AS idempotency_keys,
                 (SELECT COUNT(*) FROM occupancy_modalities) AS occupancy_modalities,
                 (SELECT COUNT(*) FROM sales_import_batches) AS sales_import_batches;""",
            "--json",
        ]
    )
    try:
        row = json.loads(results)[0]["results"][0]
    except (json.JSONDecodeError, IndexError, KeyError, TypeError) as error:
        raise WranglerD1Error("Unexpected aggregate response from local D1.") from error

    expected = manifest["manifest"]
    expected_sales = expected["sales"]
    expected_occupancy = expected["occupancy"]
    checks = {
        "sales_total": expected_sales["total"],
        "sales_active": expected_sales["active"],
        "sales_cents": int(expected_sales["activeCents"]),
        "sales_quantity": int(expected_sales["activeQuantity"]),
        "refunds": expected_sales["refunds"],
        "refunds_active": expected_sales["activeRefunds"],
        "refunds_active_cents": int(expected_sales["activeRefundsCents"]),
        "net_cents": int(expected_sales["netCents"]),
        "goals": expected_sales["goals"],
        "products": expected_sales["products"],
        "products_active": expected_sales["activeProducts"],
        "occupancy_records": expected_occupancy["records"],
        "occupancy_daily": expected_occupancy["daily"],
        "occupancy_monthly": expected_occupancy["monthly"],
        "occupancy_measured": expected_occupancy["measured"],
        "occupancy_legacy": expected_occupancy["legacy"],
        "occupancy_presences": int(expected_occupancy["presences"]),
        "occupancy_capacity": int(expected_occupancy["capacity"]),
        "occupancy_history": expected["tableCounts"]["occupancy_history"],
        "sales_history": expected["tableCounts"]["sales_history"],
        "idempotency_keys": expected["tableCounts"]["idempotency_keys"],
        "occupancy_modalities": expected["tableCounts"]["occupancy_modalities"],
        "sales_import_batches": expected["tableCounts"]["sales_import_batches"],
    }
    for key, expected_value in checks.items():
        if row.get(key) != expected_value:
            raise WranglerD1Error(f"Local D1 aggregate does not match snapshot manifest: {key}.")

    return {
        "sales": {
            "total": row["sales_total"],
            "active": row["sales_active"],
            "activeCents": str(row["sales_cents"]),
            "activeQuantity": str(row["sales_quantity"]),
            "refunds": row["refunds"],
            "activeRefunds": row["refunds_active"],
            "activeRefundsCents": str(row["refunds_active_cents"]),
            "netCents": str(row["net_cents"]),
            "goals": row["goals"],
            "products": row["products"],
            "activeProducts": row["products_active"],
        },
        "occupancy": {
            "records": row["occupancy_records"],
            "daily": row["occupancy_daily"],
            "monthly": row["occupancy_monthly"],
            "measured": row["occupancy_measured"],
            "legacy": row["occupancy_legacy"],
            "presences": str(row["occupancy_presences"]),
            "capacity": str(row["occupancy_capacity"]),
            "weightedPercent": round(row["occupancy_presences"] / row["occupancy_capacity"] * 100, 6)
            if row["occupancy_capacity"]
            else 0,
        },
    }


def main() -> int:
    try:
        manifest, tables = snapshot.read_snapshot()
        snapshot_metrics = snapshot.calculate_metrics(tables)
        snapshot.verify_manifest_metrics(manifest, {**snapshot_metrics, "_tables": tables})

        if PERSIST_DIR.resolve().parent != SNAPSHOT_DIR.resolve():
            raise WranglerD1Error("Safety stop: Wrangler state must remain under the ignored snapshot directory.")

        run_wrangler(
            [
                "d1",
                "migrations",
                "apply",
                DATABASE,
            ]
        )
        preflight(tables)
        with tempfile.TemporaryDirectory(prefix="d1-import-", dir=SNAPSHOT_DIR) as temporary:
            file_count = write_import_files(tables, Path(temporary))
        verified_metrics = verify_database(manifest, tables)
        print(json.dumps({
            "database": DATABASE,
            "environment": "Wrangler local D1 only",
            "persistPath": str(PERSIST_DIR.relative_to(ROOT)),
            "migration": "0001_zero3_schema.sql",
            "importSqlFiles": file_count,
            "tableCounts": manifest["manifest"]["tableCounts"],
            "totalRows": manifest["manifest"]["totalRows"],
            "metrics": verified_metrics,
            "snapshotSha256": manifest["integrity"]["digest"],
        }, ensure_ascii=False, indent=2))
        return 0
    except (snapshot.SnapshotError, WranglerD1Error, OSError, ValueError, KeyError) as error:
        print(f"Local D1 transfer failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
