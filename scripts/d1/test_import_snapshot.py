from __future__ import annotations

import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import import_snapshot


class SnapshotImportTests(unittest.TestCase):
    def setUp(self) -> None:
        import_snapshot.SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.NamedTemporaryFile(
            prefix="d1-local-test-", suffix=".sqlite", dir=import_snapshot.SNAPSHOT_DIR, delete=False
        )
        temporary.close()
        self.database = Path(temporary.name)
        self.database.unlink()

    def tearDown(self) -> None:
        for path in (
            self.database,
            Path(f"{self.database}-shm"),
            Path(f"{self.database}-wal"),
        ):
            path.unlink(missing_ok=True)

    def test_import_is_idempotent_and_reconciles_manifest(self) -> None:
        first = import_snapshot.import_snapshot(self.database)
        second = import_snapshot.import_snapshot(self.database)

        self.assertEqual(first["totalRows"], 1360)
        self.assertEqual(second["totalRows"], 1360)
        self.assertEqual(sum(first["inserted"].values()), 1360)
        self.assertEqual(sum(second["inserted"].values()), 0)
        self.assertEqual(first["counts"], second["counts"])
        self.assertEqual(first["metrics"], second["metrics"])
        self.assertEqual(first["metrics"]["sales"]["activeCents"], "5561770")
        self.assertEqual(first["metrics"]["occupancy"]["presences"], "5512")
        self.assertEqual(first["metrics"]["occupancy"]["capacity"], "10330")
        self.assertAlmostEqual(first["metrics"]["occupancy"]["weightedPercent"], 53.359148)

        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM _d1_migrations").fetchone()[0], 1
            )
            self.assertEqual(
                connection.execute("SELECT COUNT(*) FROM sales").fetchone()[0], 80
            )

    def test_conflicting_existing_id_is_not_overwritten(self) -> None:
        import_snapshot.import_snapshot(self.database)
        with closing(sqlite3.connect(self.database)) as connection:
            connection.execute("UPDATE sales SET notes = 'local-only-change' WHERE id = (SELECT id FROM sales LIMIT 1)")
            connection.commit()

        with self.assertRaisesRegex(import_snapshot.SnapshotError, "was not overwritten"):
            import_snapshot.import_snapshot(self.database)

        with closing(sqlite3.connect(self.database)) as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT notes FROM sales WHERE notes = 'local-only-change'"
                ).fetchone()[0],
                "local-only-change",
            )

    def test_failed_table_insert_rolls_back_the_entire_data_load(self) -> None:
        with closing(sqlite3.connect(self.database)) as connection:
            import_snapshot.apply_migrations(connection)
            connection.execute(
                """CREATE TRIGGER reject_occupancy_history
                   BEFORE INSERT ON occupancy_history
                   BEGIN SELECT RAISE(ABORT, 'simulated D1 constraint failure'); END"""
            )
            connection.commit()

        with self.assertRaisesRegex(sqlite3.IntegrityError, "simulated D1 constraint failure"):
            import_snapshot.import_snapshot(self.database)

        with closing(sqlite3.connect(self.database)) as connection:
            for table in import_snapshot.TABLE_ORDER:
                self.assertEqual(
                    connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0], 0
                )

    def test_database_path_must_be_in_ignored_snapshot_folder(self) -> None:
        with self.assertRaisesRegex(import_snapshot.SnapshotError, "Safety stop"):
            import_snapshot.validate_database_path(import_snapshot.ROOT / "d1-local.sqlite")


if __name__ == "__main__":
    unittest.main()
