import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useUser } from '@clerk/react';
import { Download, FileSpreadsheet, FileText, RefreshCw, Upload } from 'lucide-react';
import * as XLSX from 'xlsx';
import {
  getGetOccupancyRecordsQueryKey,
  useCreateOccupancyBackup,
  useGetOccupancyRecords,
  usePreviewOccupancyBackupRestore,
  useRestoreOccupancyBackup,
} from '@workspace/api-client-react';
import type {
  GetOccupancyRecordsParams,
  OccupancyBackup,
  OccupancyBackupRestoreAction,
  OccupancyBackupRestorePreview,
  OccupancyBackupSelection,
  OccupancyModality,
  OccupancyRecord,
} from '@workspace/api-client-react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MAX_OCCUPANCY_BACKUP_BYTES, parseOccupancyBackupFile } from '@/lib/occupancy-backup-file';
import { createOccupancyCsv, createOccupancyWorkbook, occupancyReportFileName, selectEffectiveOccupancyRecords } from '@/lib/occupancy-report';
import { getSaoPauloMonthKey } from '@/lib/sales-utils';

const selectionStoragePrefix = 'zero3-pro-occupancy-report-selection:';
const weekDays = [
  { value: 1, label: 'Seg' }, { value: 2, label: 'Ter' }, { value: 3, label: 'Qua' },
  { value: 4, label: 'Qui' }, { value: 5, label: 'Sex' }, { value: 6, label: 'Sáb' }, { value: 7, label: 'Dom' },
];
const inputClass = 'h-10 w-full rounded-xl border border-[#ded7e7] bg-white px-3 text-sm text-[#30283c] outline-none focus:border-[#7656b8]';
const buttonClass = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-[#ded7e7] bg-white px-3.5 text-xs font-bold text-[#5d4a78] transition hover:bg-[#f7f4fa] disabled:cursor-not-allowed disabled:opacity-50';

function freshSelection(): OccupancyBackupSelection {
  return { mode: 'months', months: [getSaoPauloMonthKey()], startTimes: [], weekdays: [] };
}

function validSavedSelection(value: unknown): value is OccupancyBackupSelection {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<OccupancyBackupSelection>;
  if (!['months', 'quarter', 'range', 'all'].includes(item.mode ?? '')) return false;
  if (item.mode === 'months' && (!Array.isArray(item.months) || item.months.some((month) => typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)))) return false;
  if (item.mode === 'quarter' && (!Number.isInteger(item.year) || !Number.isInteger(item.quarter))) return false;
  if (item.mode === 'range' && (typeof item.fromDate !== 'string' || typeof item.toDate !== 'string')) return false;
  return true;
}

function downloadFile(content: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
    anchor.remove();
  }, 1000);
}

function errorText(error: unknown) {
  const details = error && typeof error === 'object'
    ? error as { message?: unknown; data?: { error?: unknown } }
    : null;
  return typeof details?.data?.error === 'string' ? details.data.error
    : typeof details?.message === 'string' ? details.message
      : 'Não foi possível concluir. Atualize a base e tente novamente.';
}

function buildQuery(selection: OccupancyBackupSelection): GetOccupancyRecordsParams {
  const params: GetOccupancyRecordsParams = { kind: 'all' };
  if (selection.mode === 'months') params.months = selection.months?.join(',');
  if (selection.mode === 'quarter') {
    params.year = selection.year;
    params.quarter = selection.quarter;
  }
  if (selection.mode === 'range') {
    params.fromDate = selection.fromDate;
    params.toDate = selection.toDate;
  }
  if (selection.modalityId) params.modalityId = selection.modalityId;
  if (selection.startTimes?.length) params.startTimes = selection.startTimes.join(',');
  if (selection.weekdays?.length) params.weekdays = selection.weekdays.join(',');
  return params;
}

function formatInteger(value: number) {
  return value.toLocaleString('pt-BR');
}

function pct(value: number | null) {
  return value === null ? '—' : `${value.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
}

function conflictActionLabel(action: OccupancyBackupRestoreAction['action']) {
  if (action === 'update') return 'Atualizar existente';
  if (action === 'keep-both') return 'Manter os dois';
  return 'Ignorar este conflito';
}

export default function OccupancyReportsDialog({
  modalities,
  allRecords,
  onRestored,
}: {
  modalities: OccupancyModality[];
  allRecords: OccupancyRecord[];
  onRestored: () => Promise<unknown>;
}) {
  const { user, isLoaded } = useUser();
  const userId = user?.id ?? null;
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<OccupancyBackupSelection>(freshSelection);
  const [selectionLoadedFor, setSelectionLoadedFor] = useState<string | null>(null);
  const [monthToAdd, setMonthToAdd] = useState(getSaoPauloMonthKey());
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupNotice, setBackupNotice] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [uploadedBackup, setUploadedBackup] = useState<OccupancyBackup | null>(null);
  const [restorePreview, setRestorePreview] = useState<OccupancyBackupRestorePreview | null>(null);
  const [restoreActions, setRestoreActions] = useState<Record<string, OccupancyBackupRestoreAction['action']>>({});
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const createBackup = useCreateOccupancyBackup();
  const previewRestore = usePreviewOccupancyBackupRestore();
  const restoreBackup = useRestoreOccupancyBackup();

  useEffect(() => {
    if (!isLoaded || !userId || selectionLoadedFor === userId) return;
    let initial = freshSelection();
    try {
      const raw = localStorage.getItem(`${selectionStoragePrefix}${userId}`);
      const saved: unknown = raw ? JSON.parse(raw) : null;
      if (validSavedSelection(saved)) initial = saved;
    } catch {
      localStorage.removeItem(`${selectionStoragePrefix}${userId}`);
    }
    setSelection(initial);
    setSelectionLoadedFor(userId);
  }, [isLoaded, selectionLoadedFor, userId]);

  useEffect(() => {
    if (userId && selectionLoadedFor === userId) {
      localStorage.setItem(`${selectionStoragePrefix}${userId}`, JSON.stringify(selection));
    }
  }, [selection, selectionLoadedFor, userId]);

  const queryParams = useMemo(() => buildQuery(selection), [selection]);
  const queryProblem = useMemo(() => {
    if (selection.mode === 'months' && !selection.months?.length) return 'Escolha pelo menos um mês.';
    if (selection.mode === 'range') {
      if (!selection.fromDate || !selection.toDate) return 'Informe a data inicial e final.';
      if (selection.fromDate > selection.toDate) return 'A data inicial deve ser anterior ou igual à data final.';
    }
    return null;
  }, [selection]);
  const recordsQuery = useGetOccupancyRecords(queryParams, {
    query: {
      queryKey: getGetOccupancyRecordsQueryKey(queryParams),
      enabled: open && Boolean(userId) && !queryProblem,
      refetchOnWindowFocus: false,
    },
  });
  const records = recordsQuery.data ?? [];
  const effectiveRecords = useMemo(() => selectEffectiveOccupancyRecords(records, selection), [records, selection]);
  const measuredRecords = effectiveRecords.filter((record) => record.presences !== null && record.capacity !== null);
  const presencesTotal = measuredRecords.reduce((total, record) => total + (record.presences ?? 0), 0);
  const capacityTotal = measuredRecords.reduce((total, record) => total + (record.capacity ?? 0), 0);
  const weightedPercentage = capacityTotal ? presencesTotal / capacityTotal * 100 : null;
  const legacyCount = effectiveRecords.length - measuredRecords.length;
  const timeOptions = useMemo(
    () => [...new Set(allRecords.map((record) => record.startTime).filter((value): value is string => Boolean(value)))].sort(),
    [allRecords],
  );
  const years = useMemo(() => {
    const allYears = [...new Set([getSaoPauloMonthKey().slice(0, 4), ...allRecords.map((record) => record.month.slice(0, 4))])];
    return allYears.sort().reverse();
  }, [allRecords]);

  function changeMode(mode: OccupancyBackupSelection['mode']) {
    if (mode === 'months') setSelection({ mode, months: [getSaoPauloMonthKey()], modalityId: selection.modalityId, startTimes: [], weekdays: [] });
    else if (mode === 'quarter') {
      const [year, month] = getSaoPauloMonthKey().split('-').map(Number);
      setSelection({ mode, year, quarter: Math.ceil(month / 3), modalityId: selection.modalityId, startTimes: [], weekdays: [] });
    } else if (mode === 'range') {
      const month = getSaoPauloMonthKey();
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date());
      setSelection({ mode, fromDate: `${month}-01`, toDate: today, modalityId: selection.modalityId, startTimes: [], weekdays: [] });
    } else {
      setSelection({ mode, modalityId: selection.modalityId, startTimes: [], weekdays: [] });
    }
  }

  function toggleTime(value: string) {
    const current = selection.startTimes ?? [];
    setSelection({ ...selection, startTimes: current.includes(value) ? current.filter((item) => item !== value) : [...current, value].sort() });
  }

  function toggleWeekday(value: number) {
    const current = selection.weekdays ?? [];
    setSelection({ ...selection, weekdays: current.includes(value) ? current.filter((item) => item !== value).sort() : [...current, value].sort() });
  }

  async function exportWorkbook() {
    setBackupError(null);
    try {
      const workbook = createOccupancyWorkbook(records, selection);
      const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
      const period = selection.mode === 'months' ? selection.months?.join('_') ?? 'periodo'
        : selection.mode === 'quarter' ? `${selection.year}_T${selection.quarter}`
          : selection.mode === 'range' ? `${selection.fromDate}_${selection.toDate}` : 'todo_historico';
      downloadFile(bytes, occupancyReportFileName(period, 'xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    } catch (error) {
      setBackupError(errorText(error));
    }
  }

  function exportCsv() {
    setBackupError(null);
    const period = selection.mode === 'months' ? selection.months?.join('_') ?? 'periodo'
      : selection.mode === 'quarter' ? `${selection.year}_T${selection.quarter}`
        : selection.mode === 'range' ? `${selection.fromDate}_${selection.toDate}` : 'todo_historico';
    downloadFile(createOccupancyCsv(records), occupancyReportFileName(period, 'csv'), 'text/csv;charset=utf-8');
  }

  async function exportBackup() {
    setBackupError(null);
    setBackupNotice(null);
    try {
      const backup = await createBackup.mutateAsync({ data: selection });
      downloadFile(JSON.stringify(backup, null, 2), occupancyReportFileName(backup.period, 'json'), 'application/json;charset=utf-8');
      setBackupNotice(`Backup gerado com ${formatInteger(backup.counts.records)} registro(s) e ${backup.counts.modalities} modalidade(s).${backup.partial ? ' Cópia parcial, conforme os filtros.' : ''}`);
    } catch (error) {
      setBackupError(errorText(error));
    }
  }

  async function readBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    setRestoreError(null);
    setRestoreNotice(null);
    setUploadedBackup(null);
    setRestorePreview(null);
    if (!file) return;
    if (file.size > MAX_OCCUPANCY_BACKUP_BYTES) {
      setRestoreError('O arquivo ultrapassa o limite de 8 MB. Exporte períodos menores.');
      return;
    }
    try {
      const backup = parseOccupancyBackupFile(await file.text());
      setUploadedBackup(backup);
      const preview = await previewRestore.mutateAsync({ data: { backup } });
      setRestorePreview(preview);
      setRestoreActions(Object.fromEntries(preview.conflicts.map((conflict) => [
        `${conflict.entityType}:${conflict.backupId}`, 'ignore',
      ])));
    } catch (error) {
      setRestoreError(errorText(error));
    }
  }

  async function confirmRestoreNow() {
    if (!uploadedBackup || !restorePreview) return;
    setRestoreError(null);
    try {
      const actions: OccupancyBackupRestoreAction[] = restorePreview.conflicts.map((conflict) => ({
        entityType: conflict.entityType,
        backupId: conflict.backupId,
        action: restoreActions[`${conflict.entityType}:${conflict.backupId}`] ?? 'ignore',
      }));
      const result = await restoreBackup.mutateAsync({ data: { backup: uploadedBackup, actions } });
      setRestoreNotice(`Restauração concluída: ${result.insertedRecords} inserido(s), ${result.updatedRecords} atualizado(s), ${result.identicalRecords} já existente(s), ${result.ignoredRecords} ignorado(s)${result.keptDistinct ? ` e ${result.keptDistinct} mantido(s) separadamente` : ''}.`);
      setUploadedBackup(null);
      setRestorePreview(null);
      setConfirmRestore(false);
      await onRestored();
    } catch (error) {
      setRestoreError(errorText(error));
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => { setOpen(true); setBackupError(null); }}
        className="inline-flex h-11 items-center gap-2 rounded-xl border border-[#ded7e7] bg-white px-4 text-sm font-bold text-[#5d4a78] transition hover:bg-[#f7f4fa]"
        data-testid="button-occupancy-reports"
      >
        <FileSpreadsheet size={15} /> Relatórios e backup
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92dvh] max-w-3xl overflow-y-auto border-[#e7e1e9] bg-[#fffefc] p-5 sm:rounded-[24px] sm:p-6">
          <DialogHeader>
            <DialogTitle className="text-xl font-extrabold tracking-[-.04em] text-[#171522]">Relatórios de check-in e ocupação</DialogTitle>
            <DialogDescription className="text-sm text-[#77717f]">
              Estes filtros não alteram os gráficos. A seleção fica salva apenas para sua conta e não contém dados de vendas.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 rounded-2xl border border-[#e7e1e9] bg-white p-4 md:grid-cols-2">
            <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">
              Período
              <select className={`${inputClass} mt-1.5`} value={selection.mode} onChange={(event) => changeMode(event.target.value as OccupancyBackupSelection['mode'])} data-testid="select-occupancy-report-mode">
                <option value="months">Um ou vários meses</option>
                <option value="quarter">Trimestre</option>
                <option value="range">Intervalo personalizado</option>
                <option value="all">Todo o histórico</option>
              </select>
            </label>
            <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">
              Modalidade
              <select
                className={`${inputClass} mt-1.5`}
                value={selection.modalityId ?? ''}
                onChange={(event) => setSelection({ ...selection, modalityId: event.target.value || null })}
                data-testid="select-occupancy-report-modality"
              >
                <option value="">Todas as modalidades</option>
                {modalities.map((modality) => <option key={modality.id} value={modality.id}>{modality.name}</option>)}
              </select>
            </label>

            {selection.mode === 'months' && (
              <div className="md:col-span-2">
                <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Meses selecionados</label>
                <div className="mt-1.5 flex gap-2">
                  <input type="month" className={inputClass} value={monthToAdd} onChange={(event) => setMonthToAdd(event.target.value)} data-testid="input-occupancy-report-month" />
                  <button type="button" className={buttonClass} onClick={() => setSelection({
                    ...selection,
                    months: [...new Set([...(selection.months ?? []), monthToAdd])].sort(),
                  })} disabled={!monthToAdd || selection.months?.includes(monthToAdd)} data-testid="button-add-occupancy-report-month">Adicionar</button>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(selection.months ?? []).map((month) => (
                    <button key={month} type="button" onClick={() => setSelection({ ...selection, months: (selection.months ?? []).filter((item) => item !== month) })} className="rounded-full bg-[#f0eafb] px-3 py-1.5 text-xs font-bold text-[#6845a6]" aria-label={`Remover ${month}`}>{month} ×</button>
                  ))}
                </div>
              </div>
            )}
            {selection.mode === 'quarter' && (
              <div className="grid grid-cols-2 gap-3 md:col-span-2">
                <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Ano
                  <select className={`${inputClass} mt-1.5`} value={selection.year ?? ''} onChange={(event) => setSelection({ ...selection, year: Number(event.target.value) })}>
                    {years.map((year) => <option key={year} value={year}>{year}</option>)}
                  </select>
                </label>
                <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Trimestre
                  <select className={`${inputClass} mt-1.5`} value={selection.quarter ?? 1} onChange={(event) => setSelection({ ...selection, quarter: Number(event.target.value) })}>
                    {[1, 2, 3, 4].map((quarter) => <option key={quarter} value={quarter}>{quarter}º trimestre</option>)}
                  </select>
                </label>
              </div>
            )}
            {selection.mode === 'range' && (
              <div className="grid grid-cols-2 gap-3 md:col-span-2">
                <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Data inicial
                  <input type="date" className={`${inputClass} mt-1.5`} value={selection.fromDate ?? ''} onChange={(event) => setSelection({ ...selection, fromDate: event.target.value })} data-testid="input-occupancy-report-from" />
                </label>
                <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Data final
                  <input type="date" className={`${inputClass} mt-1.5`} value={selection.toDate ?? ''} onChange={(event) => setSelection({ ...selection, toDate: event.target.value })} data-testid="input-occupancy-report-to" />
                </label>
              </div>
            )}

            <fieldset className="min-w-0">
              <legend className="text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Horários iniciais</legend>
              <div className="mt-2 flex max-h-24 flex-wrap gap-2 overflow-y-auto">
                {timeOptions.length ? timeOptions.map((time) => (
                  <label key={time} className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs font-semibold ${selection.startTimes?.includes(time) ? 'border-[#7656b8] bg-[#f0eafb] text-[#6845a6]' : 'border-[#e7e1e9] bg-white text-[#6f6877]'}`}>
                    <input type="checkbox" checked={selection.startTimes?.includes(time) ?? false} onChange={() => toggleTime(time)} className="accent-[#7656b8]" />{time}
                  </label>
                )) : <span className="text-xs text-[#9992a0]">Sem horários cadastrados.</span>}
              </div>
            </fieldset>
            <fieldset className="min-w-0">
              <legend className="text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Dias da semana</legend>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {weekDays.map((day) => (
                  <label key={day.value} className={`inline-flex cursor-pointer items-center gap-1 rounded-full border px-2 py-1.5 text-xs font-semibold ${selection.weekdays?.includes(day.value) ? 'border-[#7656b8] bg-[#f0eafb] text-[#6845a6]' : 'border-[#e7e1e9] bg-white text-[#6f6877]'}`}>
                    <input type="checkbox" checked={selection.weekdays?.includes(day.value) ?? false} onChange={() => toggleWeekday(day.value)} className="accent-[#7656b8]" />{day.label}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>

          <p className="text-xs leading-relaxed text-[#77717f]">
            Datas inicial e final são inclusivas. Horário e dia da semana filtram aulas diárias; resumos mensais só entram em intervalos que cobrem o mês completo.
          </p>
          {queryProblem && <p role="alert" className="rounded-xl bg-[#fff3f1] px-3 py-2 text-xs font-semibold text-[#a24f45]">{queryProblem}</p>}
          {recordsQuery.isError && <p role="alert" className="rounded-xl bg-[#fff3f1] px-3 py-2 text-xs font-semibold text-[#a24f45]">{errorText(recordsQuery.error)}</p>}
          <div className="grid grid-cols-2 gap-2 rounded-2xl bg-[#f7f4fa] p-3 sm:grid-cols-4" aria-live="polite" data-testid="occupancy-report-preview">
            <div><span className="block text-[10px] uppercase text-[#817b89]">Registros</span><strong>{recordsQuery.isLoading ? '…' : formatInteger(records.length)}</strong></div>
            <div><span className="block text-[10px] uppercase text-[#817b89]">Aulas medidas</span><strong>{recordsQuery.isLoading ? '…' : formatInteger(measuredRecords.length)}</strong></div>
            <div><span className="block text-[10px] uppercase text-[#817b89]">Presenças / vagas</span><strong>{recordsQuery.isLoading ? '…' : `${formatInteger(presencesTotal)} / ${formatInteger(capacityTotal)}`}</strong></div>
            <div><span className="block text-[10px] uppercase text-[#817b89]">Taxa de ocupação ponderada</span><strong>{recordsQuery.isLoading ? '…' : pct(weightedPercentage)}</strong></div>
          </div>
          {!recordsQuery.isLoading && !recordsQuery.isError && records.length === 0 && !queryProblem && (
            <p className="rounded-xl border border-dashed border-[#d8cde5] px-3 py-2 text-xs text-[#6f6877]" data-testid="occupancy-report-empty">Sem registros para os filtros selecionados; não serão criadas aulas fictícias.</p>
          )}
          {legacyCount > 0 && <p className="text-xs text-[#77717f]">{legacyCount} registro(s) legado(s) sem presenças/vagas serão preservados separadamente, sem inventar contagens.</p>}

          <div className="flex flex-wrap gap-2">
            <button type="button" className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-[#d7f500] px-4 text-xs font-extrabold text-[#262b15] hover:bg-[#c9e600] disabled:opacity-50" onClick={() => void exportWorkbook()} disabled={recordsQuery.isLoading || recordsQuery.isFetching || !!queryProblem} data-testid="button-export-occupancy-xlsx"><FileSpreadsheet size={14} /> Excel (.xlsx)</button>
            <button type="button" className={buttonClass} onClick={exportCsv} disabled={recordsQuery.isLoading || recordsQuery.isFetching || !!queryProblem} data-testid="button-export-occupancy-csv"><FileText size={14} /> CSV</button>
            <button type="button" className={buttonClass} onClick={() => void exportBackup()} disabled={recordsQuery.isFetching || createBackup.isPending || !!queryProblem} data-testid="button-export-occupancy-backup"><Download size={14} /> {createBackup.isPending ? 'Gerando backup…' : 'Backup JSON'}</button>
            <button type="button" className={`${buttonClass} ml-auto`} onClick={() => void recordsQuery.refetch()} disabled={recordsQuery.isFetching || !!queryProblem} data-testid="button-refresh-occupancy-report"><RefreshCw size={14} className={recordsQuery.isFetching ? 'animate-spin' : ''} /> Atualizar prévia</button>
          </div>
          {backupError && <p role="alert" className="rounded-xl bg-[#fff3f1] px-3 py-2 text-xs font-semibold text-[#a24f45]" data-testid="occupancy-report-export-error">{backupError}</p>}
          {backupNotice && <p role="status" className="rounded-xl bg-[#edf8d7] px-3 py-2 text-xs font-semibold text-[#50652a]" data-testid="occupancy-report-backup-notice">{backupNotice}</p>}

          <section className="space-y-3 rounded-2xl border border-[#e7e1e9] bg-white p-4" aria-labelledby="occupancy-restore-heading">
            <div>
              <h3 id="occupancy-restore-heading" className="text-sm font-extrabold text-[#252033]">Restaurar backup de check-ins</h3>
              <p className="mt-1 text-xs text-[#77717f]">A prévia detecta IDs repetidos e aulas coincidentes. Nada muda antes da confirmação; dados financeiros não são alterados.</p>
            </div>
            <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={(event) => void readBackup(event)} data-testid="input-occupancy-backup-file" />
            <button type="button" className={buttonClass} onClick={() => fileInput.current?.click()} disabled={previewRestore.isPending || restoreBackup.isPending} data-testid="button-select-occupancy-backup"><Upload size={14} /> {previewRestore.isPending ? 'Validando backup…' : 'Selecionar arquivo JSON'}</button>
            {restoreError && <p role="alert" className="rounded-xl bg-[#fff3f1] px-3 py-2 text-xs font-semibold text-[#a24f45]" data-testid="occupancy-restore-error">{restoreError}</p>}
            {restoreNotice && <p role="status" className="rounded-xl bg-[#edf8d7] px-3 py-2 text-xs font-semibold text-[#50652a]" data-testid="occupancy-restore-notice">{restoreNotice}</p>}
            {uploadedBackup && restorePreview && (
              <div className="space-y-3 rounded-xl bg-[#f7f4fa] p-3" data-testid="occupancy-restore-preview">
                <p className="text-xs font-bold text-[#4c3c64]">{uploadedBackup.period}: {uploadedBackup.counts.records} check-in(s), {uploadedBackup.counts.modalities} modalidade(s).{uploadedBackup.partial ? ' Backup parcial.' : ' Todo o histórico ativo de check-ins.'}</p>
                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                  <span>Novos: <strong>{restorePreview.counts.recordsToInsert}</strong></span>
                  <span>Idênticos: <strong>{restorePreview.counts.recordsIdentical}</strong></span>
                  <span>Conflitos: <strong>{restorePreview.counts.conflicts}</strong></span>
                  <span>Modalidades: <strong>{restorePreview.counts.modalityDependencies}</strong></span>
                </div>
                {restorePreview.conflicts.map((conflict) => {
                  const key = `${conflict.entityType}:${conflict.backupId}`;
                  return (
                    <div key={key} className="grid gap-2 rounded-lg border border-[#e4ddeb] bg-white p-3 sm:grid-cols-[1fr_220px] sm:items-center">
                      <p className="text-xs text-[#5f5867]">{conflict.reason}<span className="mt-1 block text-[10px] text-[#8a8491]">Backup: {conflict.backupId} · existente: {conflict.existingId}</span></p>
                      <select className={inputClass} value={restoreActions[key] ?? 'ignore'} onChange={(event) => setRestoreActions({ ...restoreActions, [key]: event.target.value as OccupancyBackupRestoreAction['action'] })} aria-label={`Ação para conflito ${conflict.backupId}`}>
                        {conflict.options.map((action) => <option key={action} value={action}>{conflictActionLabel(action)}</option>)}
                      </select>
                    </div>
                  );
                })}
                <button type="button" className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-[#7656b8] px-4 text-xs font-bold text-white hover:bg-[#6845a6] disabled:opacity-50" onClick={() => setConfirmRestore(true)} disabled={restoreBackup.isPending} data-testid="button-confirm-occupancy-restore">Revisar e confirmar restauração</button>
              </div>
            )}
          </section>

          <AlertDialog open={confirmRestore} onOpenChange={setConfirmRestore}>
            <AlertDialogContent className="rounded-[22px] border-[#e7e1e9] bg-[#fffefc]">
              <AlertDialogHeader>
                <AlertDialogTitle>Confirmar restauração dos check-ins?</AlertDialogTitle>
                <AlertDialogDescription>
                  Serão aplicadas as decisões selecionadas para {restorePreview?.period}. Registros fora do backup e todos os dados financeiros serão mantidos.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={restoreBackup.isPending}>Voltar</AlertDialogCancel>
                <AlertDialogAction onClick={(event) => { event.preventDefault(); void confirmRestoreNow(); }} disabled={restoreBackup.isPending} data-testid="button-apply-occupancy-restore">
                  {restoreBackup.isPending ? 'Restaurando…' : 'Confirmar restauração'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </DialogContent>
      </Dialog>
    </>
  );
}
