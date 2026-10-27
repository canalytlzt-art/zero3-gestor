import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthContext } from '@workspace/api-client-react';
import { parseOccupancyBackupFile } from '../lib/occupancy-backup-file';
import { handleOccupancyRequest } from './occupancy';
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  WorkerEnv,
} from './types';

type Row = Record<string, unknown>;

const modalityId = 'b0e64684-5990-4c9e-a3dc-886aa9242f31';
const actor: AuthContext = { userId: 'synthetic-admin', email: 'synthetic@example.test', authorized: true };

function row(
  id: string,
  kind: 'daily' | 'monthly',
  period: string,
  values: Partial<Row> = {},
): Row {
  const month = period.slice(0, 7);
  return {
    id,
    kind,
    date: kind === 'daily' ? period : null,
    month,
    modality_id: modalityId,
    modality_name: 'Modalidade sintética',
    percentage: '0',
    reported_percentage: null,
    presences: null,
    capacity: null,
    start_time: null,
    end_time: null,
    class_name: null,
    scope_key: '',
    notes: null,
    source_file_hash: null,
    source_sheet: null,
    source_cell: null,
    source_cells: null,
    version: 1,
    created_by: actor.userId,
    updated_by: actor.userId,
    created_at: '2026-07-01T10:00:00.000Z',
    updated_at: '2026-07-01T10:00:00.000Z',
    deleted_at: null,
    ...values,
  };
}

class BackupStatement implements D1PreparedStatement {
  private bindings: unknown[] = [];

  constructor(
    private readonly database: BackupFixtureD1,
    readonly query: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.bindings = values;
    return this;
  }

  first<T = Record<string, unknown>>(): Promise<T | null> {
    return Promise.resolve(null);
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return {
      success: true,
      results: await this.database.all<T>(this.query, this.bindings),
    };
  }

  run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return Promise.resolve({ success: true, meta: { changes: 0 } });
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    return (await this.all<unknown>()).results as T[];
  }
}

class BackupFixtureD1 implements D1Database {
  readonly queries: string[] = [];
  readonly records = [
    row('614ad842-46d2-413b-8ff3-8b2b0465ef31', 'daily', '2026-07-05', {
      percentage: '50',
      presences: 2,
      capacity: 4,
      start_time: '06:00:00',
      class_name: 'Noite',
      scope_key: 'noite',
    }),
    row('597a31b1-7f84-49ba-b441-ec2d8125a01a', 'daily', '2026-07-06', {
      percentage: '80',
      reported_percentage: '80',
      class_name: 'Manhã',
      scope_key: 'manha',
    }),
    row('a0822fd8-9aa5-4610-94d4-9c74f4455b62', 'monthly', '2026-07', {
      percentage: '72.5',
      reported_percentage: '72.5',
      class_name: 'Manhã',
      scope_key: 'manha',
    }),
    row('831ff53d-4855-4f0a-9df5-3b734e21d786', 'daily', '2026-08-01', {
      percentage: '25',
      presences: 1,
      capacity: 4,
      start_time: '06:00:00',
      class_name: 'Noite',
      scope_key: 'noite',
    }),
  ];

  prepare(query: string): D1PreparedStatement {
    this.queries.push(query);
    return new BackupStatement(this, query);
  }

  async all<T>(query: string): Promise<T[]> {
    const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized.includes('from occupancy_records r join occupancy_modalities m')) {
      return this.records as T[];
    }
    if (normalized.startsWith('select id, name, version from occupancy_modalities')) {
      return [{ id: modalityId, name: 'Modalidade sintética', version: 1 }] as T[];
    }
    throw new Error(`Unexpected fixture query: ${normalized}`);
  }

  async batch<T = unknown>(): Promise<D1Result<T>[]> {
    return [];
  }

  async exec(): Promise<D1Result> {
    return { success: true };
  }
}

async function createBackup(database: BackupFixtureD1, selection: unknown): Promise<Record<string, any>> {
  const response = await handleOccupancyRequest(
    new Request('https://zero3.test/occupancy/backup/period', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(selection),
    }),
    { DB: database } as WorkerEnv,
    actor,
    '/occupancy/backup/period',
  );
  assert.ok(response);
  const payload = await response.json() as Record<string, any>;
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload;
}

test('Worker backup counts only selected records and calculates summary with monthly precedence', async () => {
  const database = new BackupFixtureD1();
  const backup = await createBackup(database, { mode: 'months', months: ['2026-07'] });

  assert.equal(backup.counts.records, 3);
  assert.equal(backup.counts.totalRecords, 3);
  assert.equal(backup.summary.measuredRecords, 1);
  assert.equal(backup.summary.legacyRecords, 1, 'monthly legacy replaces daily legacy in its matching scope');
  assert.equal(backup.summary.presences, 2);
  assert.equal(backup.summary.capacity, 4);
  assert.equal(backup.summary.weightedPercentage, 50);
  assert.ok(database.queries.some((query) => query.includes('r.month IN (?)') && query.includes('LIMIT 50001')));

  const restoredFile = parseOccupancyBackupFile(JSON.stringify(backup));
  assert.equal(restoredFile.records.length, 3);
  assert.equal(restoredFile.counts.totalRecords, restoredFile.records.length);
});

test('Worker backup omits monthly records from partial months and keeps empty periods empty', async () => {
  const database = new BackupFixtureD1();
  const partialMonth = await createBackup(database, {
    mode: 'range',
    fromDate: '2026-07-02',
    toDate: '2026-07-31',
  });
  assert.deepEqual(partialMonth.records.map((item: any) => item.record.kind), ['daily', 'daily']);
  assert.equal(partialMonth.counts.totalRecords, 2);
  assert.equal(parseOccupancyBackupFile(JSON.stringify(partialMonth)).records.length, 2);

  const emptyMonth = await createBackup(database, { mode: 'months', months: ['2026-09'] });
  assert.equal(emptyMonth.counts.records, 0);
  assert.equal(emptyMonth.counts.totalRecords, 0);
  assert.deepEqual(emptyMonth.records, []);
});
