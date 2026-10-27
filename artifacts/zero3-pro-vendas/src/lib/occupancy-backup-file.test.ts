import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOccupancyBackupFile } from './occupancy-backup-file';

const modalityId = 'b0e64684-5990-4c9e-a3dc-886aa9242f31';
const common = {
  month: '2026-07',
  modalityId,
  modalityName: 'Modalidade sintética',
  reportedPercentage: null,
  sourceFileHash: null,
  sourceSheet: null,
  sourceCell: null,
  sourceCells: null,
  notes: null,
  version: 1,
  createdAt: '2026-07-01T10:00:00.000Z',
  updatedAt: '2026-07-01T10:00:00.000Z',
};

const syntheticBackup = {
  format: 'zero3-pro-occupancy-backup',
  schemaVersion: 1,
  module: 'occupancy',
  origin: 'zero3-pro-occupancy-database',
  generatedAt: '2026-08-01T10:00:00.000Z',
  period: '2026-07',
  selection: { mode: 'months', months: ['2026-07'] },
  partial: true,
  counts: {
    records: 2,
    dailyRecords: 1,
    monthlyRecords: 1,
    modalities: 1,
    totalRecords: 2,
  },
  summary: {
    measuredRecords: 1,
    legacyRecords: 1,
    presences: 1,
    capacity: 2,
    weightedPercentage: 50,
  },
  modalities: [{ id: modalityId, name: 'Modalidade sintética', version: 1 }],
  records: [
    {
      scope: 'period',
      scopeKey: 'manha',
      record: {
        ...common,
        id: '614ad842-46d2-413b-8ff3-8b2b0465ef31',
        kind: 'daily',
        period: '2026-07-01',
        percentage: 50,
        presences: 1,
        capacity: 2,
        startTime: '06:00',
        endTime: null,
        className: 'Manhã',
      },
    },
    {
      scope: 'period',
      scopeKey: 'manha',
      record: {
        ...common,
        id: '597a31b1-7f84-49ba-b441-ec2d8125a01a',
        kind: 'monthly',
        period: '2026-07',
        percentage: 72.5,
        reportedPercentage: 72.5,
        presences: null,
        capacity: null,
        startTime: null,
        endTime: null,
        className: 'Manhã',
      },
    },
  ],
};

test('opens a versioned occupancy backup with exact IDs, counts, and legacy/measured data', () => {
  const parsed = parseOccupancyBackupFile(JSON.stringify(syntheticBackup));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.partial, true);
  assert.deepEqual(parsed.records.map(({ record }) => record.id), [
    '614ad842-46d2-413b-8ff3-8b2b0465ef31',
    '597a31b1-7f84-49ba-b441-ec2d8125a01a',
  ]);
  assert.equal(parsed.records[0]?.record.presences, 1);
  assert.equal(parsed.records[1]?.record.reportedPercentage, 72.5);
});

test('rejects unsupported backup versions, repeated IDs, and inconsistent totals', () => {
  assert.throws(() => parseOccupancyBackupFile(JSON.stringify({
    ...syntheticBackup,
    schemaVersion: 2,
  })), /literal value/i);

  const repeatedIds = {
    ...syntheticBackup,
    records: [
      syntheticBackup.records[0],
      {
        ...syntheticBackup.records[1],
        record: { ...syntheticBackup.records[1].record, id: syntheticBackup.records[0].record.id },
      },
    ],
  };
  assert.throws(() => parseOccupancyBackupFile(JSON.stringify(repeatedIds)), /ID de registro repetido/i);

  assert.throws(() => parseOccupancyBackupFile(JSON.stringify({
    ...syntheticBackup,
    counts: { ...syntheticBackup.counts, totalRecords: 7 },
  })), /contagens não correspondem/i);
});
