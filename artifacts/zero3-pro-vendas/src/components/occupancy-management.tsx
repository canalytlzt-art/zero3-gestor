import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CircleHelp, Gauge, Layers, Pencil, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import {
  getGetOccupancyModalitiesQueryKey,
  getGetOccupancyRecordsQueryKey,
  useCreateOccupancyModality,
  useCreateOccupancyRecord,
  useDeleteOccupancyModality,
  useDeleteOccupancyRecord,
  useGetOccupancyModalities,
  useGetOccupancyRecords,
  useUpdateOccupancyModality,
  useUpdateOccupancyRecord,
} from '@workspace/api-client-react';
import type { GetOccupancyRecordsParams, OccupancyModality, OccupancyRecord, OccupancyRecordInput } from '@workspace/api-client-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { PurpleSelect } from '@/components/ui/purple-select';
import { SuggestionInput } from '@/components/ui/suggestion-input';
import { formatMonthKey, getSaoPauloMonthKey } from '@/lib/sales-utils';
import { buildOccupancyChartAnalytics } from '@/lib/occupancy-chart-data';
import {
  changeOccupancyPeriod,
  clearOccupancyFilters,
  currentOccupancyMonth,
  occupancyAnalyticsMonths,
  occupancyFilterProblem,
  occupancyFilterSummary,
  occupancyQueryParams,
  updateOccupancyFilters,
  updateOccupancyQuarter,
  updateOccupancyYear,
  useOccupancyFilterState,
  type OccupancyPeriodMode,
} from '@/lib/occupancy-filter-store';
import OccupancyImportDialog from '@/components/occupancy-import-dialog';

type Kind = 'daily' | 'monthly';

const fieldClass = 'mt-1.5 h-10 w-full rounded-lg border border-[#e7e2ea] bg-[#fffefc] px-3 text-xs font-medium normal-case tracking-normal text-[#443d50] outline-none focus:border-[#9477bf]';
const labelClass = 'block text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]';

export function normalizeModalityName(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
}

export function parsePercentage(raw: string): { value: number | null; error: string | null } {
  const text = raw.trim().replace(/%\s*$/, '').trim();
  if (!text) return { value: null, error: 'Informe o percentual. Campo vazio não é tratado como zero.' };
  if (!/^[+-]?\d+([.,]\d+)?$/.test(text)) return { value: null, error: 'Use apenas números, com vírgula para decimais (ex.: 72,5).' };
  const value = Number(text.replace(',', '.'));
  if (!Number.isFinite(value) || value < 0 || value > 100) return { value: null, error: `Revise o valor: ${text}% está fora do intervalo de 0 a 100. Nada foi ajustado automaticamente.` };
  return { value, error: null };
}

function parseCount(raw: string, label: string, minimum: number): { value: number | null; error: string | null } {
  const text = raw.trim();
  if (!text) return { value: null, error: `Informe ${label}.` };
  if (!/^\d+$/.test(text)) return { value: null, error: `Use um número inteiro para ${label}.` };
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < minimum || value > 2_147_483_647) {
    return { value: null, error: `${label} deve ser um inteiro entre ${minimum} e 2.147.483.647.` };
  }
  return { value, error: null };
}

function formatPct(value: number) {
  return `${value.toLocaleString('pt-BR', { maximumFractionDigits: 15 })}%`;
}

function formatCalculatedPct(value: number) {
  return `${value.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
}

function formatDay(iso: string) {
  const [y, m, d] = iso.split('-');
  return d && m && y ? `${d}/${m}/${y}` : iso;
}

function recordLabel(record: OccupancyRecord) {
  const when = record.kind === 'daily' ? formatDay(record.period) : formatMonthKey(record.period);
  return `${record.modalityName}${record.className ? ` · ${record.className}` : ''} · ${when}`;
}

function apiErrorMessage(error: unknown, context: 'record' | 'modality' | 'delete') {
  const e = error && typeof error === 'object' ? error as { status?: unknown; message?: unknown; data?: { error?: unknown } } : null;
  if (e?.status === 409) {
    if (context === 'delete') return 'Este registro foi alterado por outra pessoa desde que você abriu a lista. Atualize a base e reabra o registro antes de excluir.';
    if (context === 'modality') return 'Já existe uma modalidade com esse nome ou ela foi alterada desde que você abriu. Atualize a lista e tente de novo.';
    return typeof e.data?.error === 'string'
      ? `${e.data.error} Atualize a base e reabra o registro se necessário.`
      : 'Conflito: já existe aula para esta modalidade, data, horário e turma, ou o registro foi alterado. Atualize a base e reabra antes de salvar.';
  }
  if (typeof e?.data?.error === 'string') return e.data.error;
  if (typeof e?.message === 'string') return e.message;
  return 'Não foi possível concluir. Tente novamente.';
}

const emptyForm = (kind: Kind = 'daily') => ({
  kind,
  day: '',
  month: getSaoPauloMonthKey(),
  modalityName: 'CrossFit',
  percentage: '',
  startTime: '',
  endTime: '',
  presences: '',
  capacity: '',
  className: '',
  notes: '',
});

export default function OccupancyManagement() {
  const queryClient = useQueryClient();
  const currentMonth = getSaoPauloMonthKey();

  // ---- form state (independent from filters)
  const [form, setForm] = useState(emptyForm());
  const [editing, setEditing] = useState<{ id: string; version: number; label: string; modalityId: string; modalityName: string; legacy: boolean; reportedPercentage: number | null } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [formConflict, setFormConflict] = useState(false);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const submitLock = useRef(false);

  // ---- filter state
  const [monthToAdd, setMonthToAdd] = useState(currentMonth);
  const filterState = useOccupancyFilterState();
  const [filterKind, setFilterKind] = useState<'all' | Kind>('all');

  // ---- delete + modality dialogs
  const [toDelete, setToDelete] = useState<OccupancyRecord | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteLock = useRef(false);
  const [modalitiesOpen, setModalitiesOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const filterProblem = occupancyFilterProblem(filterState);
  const filterInvalid = Boolean(filterProblem);

  const params = useMemo<GetOccupancyRecordsParams>(
    () => occupancyQueryParams(filterState, filterKind),
    [filterState, filterKind],
  );

  const modalitiesQuery = useGetOccupancyModalities({
    query: { queryKey: getGetOccupancyModalitiesQueryKey(), refetchOnMount: 'always', refetchOnWindowFocus: true, staleTime: 15000 },
  });
  const filterOptionsQuery = useGetOccupancyRecords({ kind: 'all' }, {
    query: { queryKey: getGetOccupancyRecordsQueryKey({ kind: 'all' }), refetchOnMount: 'always', refetchOnWindowFocus: true, staleTime: 15000 },
  });
  const recordsQuery = useGetOccupancyRecords(params, {
    query: { queryKey: getGetOccupancyRecordsQueryKey(params), enabled: !filterInvalid, refetchOnMount: 'always', refetchOnWindowFocus: true, staleTime: 15000 },
  });
  const createRecord = useCreateOccupancyRecord();
  const updateRecord = useUpdateOccupancyRecord();
  const deleteRecord = useDeleteOccupancyRecord();

  const modalities = useMemo(() => [...(modalitiesQuery.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' })), [modalitiesQuery.data]);
  const records = filterInvalid ? [] : recordsQuery.data ?? [];
  const filterOptions = filterOptionsQuery.data ?? [];
  const startTimeOptions = useMemo(() => [...new Set(filterOptions.map((record) => record.startTime).filter((value): value is string => Boolean(value)))].sort(), [filterOptions]);
  const yearOptions = useMemo(() => [...new Set([currentOccupancyMonth().slice(0, 4), ...filterOptions.map((record) => record.month.slice(0, 4))])].sort().reverse(), [filterOptions]);

  const invalidateAll = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: getGetOccupancyRecordsQueryKey() }),
    queryClient.invalidateQueries({ queryKey: getGetOccupancyModalitiesQueryKey() }),
  ]);
  const refreshBase = () => { void Promise.all([...(filterInvalid ? [] : [recordsQuery.refetch()]), modalitiesQuery.refetch(), filterOptionsQuery.refetch()]); };
  const isRefreshing = recordsQuery.isFetching || modalitiesQuery.isFetching || filterOptionsQuery.isFetching;

  const summaryViewMode = filterKind === 'all' ? filterState.viewMode : filterKind;
  const summaryAnalytics = useMemo(() => {
    const selectedMonths = occupancyAnalyticsMonths(filterState);
    return buildOccupancyChartAnalytics(records, {
      viewMode: summaryViewMode,
      ...(selectedMonths ? { selectedMonths } : {}),
      ...(filterState.periodMode === 'day' && filterState.day ? { fromDate: filterState.day, toDate: filterState.day } : {}),
      ...(filterState.periodMode === 'range' && filterState.fromDate && filterState.toDate ? { fromDate: filterState.fromDate, toDate: filterState.toDate } : {}),
      modalityId: filterState.modalityId || undefined,
      startTimes: filterState.startTimes,
      weekdays: filterState.weekdays,
    });
  }, [records, summaryViewMode, filterState]);
  const measuredRecords = summaryAnalytics.totals.measuredClassCount;
  const legacyRecords = summaryAnalytics.totals.legacyRecordCount;
  const totalPresences = summaryAnalytics.totals.presences;
  const totalCapacity = summaryAnalytics.totals.capacity;
  const weightedOccupancy = summaryAnalytics.totals.percentage;

  const legacyEdit = editing?.legacy ?? false;
  const pct = parsePercentage(form.percentage);
  const presenceCount = parseCount(form.presences, 'as presenças', 0);
  const capacityCount = parseCount(form.capacity, 'a capacidade total', 1);
  const calculatedPercentage = presenceCount.value !== null && capacityCount.value !== null
    ? Number(((presenceCount.value / capacityCount.value) * 100).toFixed(6))
    : null;
  const periodValue = form.kind === 'daily' ? form.day : form.month;
  const validation = {
    period: !periodValue ? (form.kind === 'daily' ? 'Informe o dia.' : 'Informe o mês.') : null,
    modality: !form.modalityName.trim() ? 'Informe a modalidade.' : form.modalityName.trim().length > 120 ? 'Máximo de 120 caracteres.' : null,
    percentage: legacyEdit ? pct.error : null,
    startTime: !legacyEdit && !/^([01]\d|2[0-3]):[0-5]\d$/.test(form.startTime) ? 'Informe um horário inicial válido.' : null,
    endTime: !legacyEdit && form.endTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(form.endTime) ? 'Informe um horário final válido.' : null,
    presences: legacyEdit ? null : presenceCount.error,
    capacity: legacyEdit ? null : capacityCount.error,
    className: form.className.trim().length > 120 ? 'Máximo de 120 caracteres.' : null,
    notes: form.notes.length > 1000 ? 'Máximo de 1000 caracteres.' : null,
  };
  const hasErrors = Object.values(validation).some(Boolean);
  const isSaving = createRecord.isPending || updateRecord.isPending;

  const setField = <K extends keyof ReturnType<typeof emptyForm>>(key: K, value: ReturnType<typeof emptyForm>[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setFormSuccess(null);
  };

  const resetForm = () => {
    setForm(emptyForm());
    setEditing(null);
    setFormError(null);
    setFormConflict(false);
    setTouched(false);
  };

  const startEdit = (record: OccupancyRecord) => {
    const legacy = record.presences === null || record.capacity === null;
    setEditing({
      id: record.id, version: record.version, label: recordLabel(record), modalityId: record.modalityId,
      modalityName: record.modalityName, legacy, reportedPercentage: record.reportedPercentage,
    });
    setForm({
      kind: record.kind,
      day: record.kind === 'daily' ? record.period : '',
      month: record.kind === 'monthly' ? record.period : record.month,
      modalityName: record.modalityName,
      percentage: String(record.percentage).replace('.', ','),
      startTime: record.startTime ?? '',
      endTime: record.endTime ?? '',
      presences: record.presences === null ? '' : String(record.presences),
      capacity: record.capacity === null ? '' : String(record.capacity),
      className: record.className ?? '',
      notes: record.notes ?? '',
    });
    setFormError(null);
    setFormConflict(false);
    setFormSuccess(null);
    setTouched(false);
    document.getElementById('occupancy-entry-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (submitLock.current || isSaving || hasErrors) return;
    submitLock.current = true;
    setFormError(null);
    setFormConflict(false);
    const typed = form.modalityName.trim().replace(/\s+/g, ' ');
    const match = modalities.find((m) => normalizeModalityName(m.name) === normalizeModalityName(typed));
    const className = form.className.trim();
    const notes = form.notes.trim();
    const input: OccupancyRecordInput = legacyEdit
      ? {
          kind: form.kind,
          period: periodValue,
          modalityName: match ? match.name : typed,
          percentage: pct.value!,
          className: className ? className : null,
          notes: notes ? notes : null,
        }
      : {
          kind: 'daily',
          period: form.day,
          modalityName: match ? match.name : typed,
          presences: presenceCount.value!,
          capacity: capacityCount.value!,
          startTime: form.startTime,
          endTime: form.endTime || null,
          ...(editing?.reportedPercentage !== null && editing?.reportedPercentage !== undefined
            ? { reportedPercentage: editing.reportedPercentage }
            : {}),
          className: className ? className : null,
          notes: notes ? notes : null,
        };
    if (match) input.modalityId = match.id;
    else if (editing && normalizeModalityName(typed) === normalizeModalityName(editing.modalityName)) input.modalityId = editing.modalityId;
    try {
      if (editing) {
        await updateRecord.mutateAsync({ id: editing.id, data: { ...input, version: editing.version } });
        setFormSuccess('Registro atualizado.');
      } else {
        await createRecord.mutateAsync({ data: input });
        setFormSuccess('Aula registrada.');
      }
      resetForm();
      await invalidateAll();
    } catch (error) {
      const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : undefined;
      setFormConflict(status === 409);
      setFormError(apiErrorMessage(error, 'record'));
    } finally {
      submitLock.current = false;
    }
  };

  const confirmDelete = async () => {
    if (!toDelete || deleteLock.current || deleteRecord.isPending) return;
    deleteLock.current = true;
    setDeleteError(null);
    try {
      await deleteRecord.mutateAsync({ id: toDelete.id, data: { version: toDelete.version } });
      if (editing?.id === toDelete.id) resetForm();
      setToDelete(null);
      await invalidateAll();
    } catch (error) {
      setDeleteError(apiErrorMessage(error, 'delete'));
    } finally {
      deleteLock.current = false;
    }
  };

  const changeFilterMode = (mode: OccupancyPeriodMode) => changeOccupancyPeriod(mode);
  const clearFilters = () => {
    clearOccupancyFilters();
    setMonthToAdd(currentMonth);
    setFilterKind('all');
  };
  const toggleFilterTime = (time: string) => {
    const selected = filterState.startTimes.includes(time);
    updateOccupancyFilters({ startTimes: selected ? filterState.startTimes.filter((item) => item !== time) : [...filterState.startTimes, time].sort() });
    if (!selected) setFilterKind('daily');
  };
  const toggleFilterWeekday = (weekday: number) => {
    const selected = filterState.weekdays.includes(weekday);
    updateOccupancyFilters({ weekdays: selected ? filterState.weekdays.filter((item) => item !== weekday) : [...filterState.weekdays, weekday].sort() });
    if (!selected) setFilterKind('daily');
  };

  const showErr = (msg: string | null) => touched && msg;

  return (
    <div className="space-y-5" data-testid="occupancy-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="eyebrow text-[9px] font-bold text-[#8a8491]">aulas concluídas</p>
          <p className="mt-1 max-w-[560px] text-sm text-[#77717f]">Registre presenças e capacidade total. A ocupação é calculada automaticamente, inclusive quando as presenças ultrapassam as vagas.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setImportOpen(true)} className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#d7f500] px-4 text-sm font-extrabold text-[#262b15] transition hover:bg-[#c9e600]" data-testid="button-import-occupancy"><Upload size={15} /> Importar ocupação</button>
          <button type="button" onClick={() => setModalitiesOpen(true)} className="inline-flex h-11 items-center gap-2 rounded-xl border border-[#ded7e7] bg-white px-4 text-sm font-bold text-[#5d4a78] transition hover:bg-[#f7f4fa]" data-testid="button-manage-modalities"><Layers size={15} /> Modalidades</button>
          <button type="button" onClick={refreshBase} disabled={isRefreshing} aria-busy={isRefreshing} className="inline-flex h-11 items-center gap-2 rounded-xl border border-[#ded7e7] bg-white px-4 text-sm font-bold text-[#5d4a78] transition hover:bg-[#f7f4fa] disabled:cursor-wait disabled:opacity-65" data-testid="button-refresh-occupancy"><RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} /> {isRefreshing ? 'Atualizando…' : 'Atualizar base'}</button>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(340px,.8fr)_1.2fr] xl:items-start">
        {/* FORM */}
        <form id="occupancy-entry-form" onSubmit={(e) => void submit(e)} noValidate className="rounded-[24px] border border-[#e7e1e9] bg-[#fffefc] p-4 shadow-[0_8px_28px_rgba(47,39,62,.035)] sm:p-6 xl:sticky xl:top-[96px]" data-testid="form-occupancy" aria-labelledby="occupancy-form-heading">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="eyebrow text-[9px] font-bold text-[#8a8491]">{editing ? 'editando registro' : 'nova aula'}</p>
              <h2 id="occupancy-form-heading" className="mt-1 text-xl font-extrabold tracking-[-.04em] text-[#171522]">{editing ? (editing.legacy ? 'Corrigir registro legado' : 'Corrigir dados da aula') : 'Registrar aula'}</h2>
              {editing && <p className="mt-1 text-xs text-[#77717f]" data-testid="text-occupancy-editing">{editing.label}</p>}
            </div>
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#eee8f7] text-[#7656b8]"><Gauge size={18} /></span>
          </div>

          {legacyEdit && <div className="mt-4 rounded-xl border border-[#eadfbf] bg-[#fffaf0] px-3.5 py-2.5 text-[11px] leading-5 text-[#746039]" role="status">
            Registro legado sem presenças e capacidade. A edição mantém o formato antigo; nenhum dado será estimado.
          </div>}

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className={labelClass}>{legacyEdit && form.kind === 'monthly' ? 'Mês do registro legado' : 'Data da aula'}
              {legacyEdit && form.kind === 'monthly'
                ? <input type="month" value={form.month} onChange={(e) => setField('month', e.target.value)} className={fieldClass} data-testid="input-occupancy-period" aria-invalid={!!showErr(validation.period)} />
                : <input type="date" value={form.day} onChange={(e) => setField('day', e.target.value)} className={fieldClass} data-testid="input-occupancy-period" aria-invalid={!!showErr(validation.period)} />}
              {showErr(validation.period) && <span className="mt-1 block text-[10px] normal-case tracking-normal text-[#a24f45]" data-testid="error-occupancy-period">{validation.period}</span>}
            </label>
            {legacyEdit ? <label className={labelClass}>Percentual legado
              <div className="relative">
                <input inputMode="decimal" value={form.percentage} onChange={(e) => setField('percentage', e.target.value)} placeholder="ex.: 72,5" className={`${fieldClass} pr-8 tabular-nums`} data-testid="input-occupancy-percentage" aria-invalid={!!showErr(validation.percentage)} />
                <span className="pointer-events-none absolute right-3 top-[calc(50%+3px)] -translate-y-1/2 text-xs font-bold text-[#9a93a3]">%</span>
              </div>
              {showErr(validation.percentage) && <span className="mt-1 block text-[10px] normal-case leading-4 tracking-normal text-[#a24f45]" role="alert" data-testid="error-occupancy-percentage">{validation.percentage}</span>}
            </label> : <div className="grid gap-3 sm:col-span-2 sm:grid-cols-2">
              <label className={labelClass}>Horário inicial
                <input type="time" value={form.startTime} onChange={(e) => setField('startTime', e.target.value)} className={fieldClass} data-testid="input-occupancy-start-time" aria-invalid={!!showErr(validation.startTime)} />
                {showErr(validation.startTime) && <span className="mt-1 block text-[10px] normal-case tracking-normal text-[#a24f45]">{validation.startTime}</span>}
              </label>
              <label className={labelClass}>Horário final <span className="font-medium normal-case tracking-normal text-[#a39dab]">(opcional)</span>
                <input type="time" value={form.endTime} onChange={(e) => setField('endTime', e.target.value)} className={fieldClass} data-testid="input-occupancy-end-time" aria-invalid={!!showErr(validation.endTime)} />
                {showErr(validation.endTime) && <span className="mt-1 block text-[10px] normal-case tracking-normal text-[#a24f45]">{validation.endTime}</span>}
              </label>
              <label className={labelClass}>Presenças
                <input type="number" inputMode="numeric" min="0" max="2147483647" step="1" value={form.presences} onChange={(e) => setField('presences', e.target.value)} placeholder="0" className={`${fieldClass} tabular-nums`} data-testid="input-occupancy-presences" aria-invalid={!!showErr(validation.presences)} />
                {showErr(validation.presences) && <span className="mt-1 block text-[10px] normal-case tracking-normal text-[#a24f45]">{validation.presences}</span>}
              </label>
              <label className={labelClass}>Vagas <span className="font-medium normal-case tracking-normal text-[#a39dab]">(capacidade total)</span>
                <input type="number" inputMode="numeric" min="1" max="2147483647" step="1" value={form.capacity} onChange={(e) => setField('capacity', e.target.value)} placeholder="ex.: 18" className={`${fieldClass} tabular-nums`} data-testid="input-occupancy-capacity" aria-invalid={!!showErr(validation.capacity)} />
                {showErr(validation.capacity) && <span className="mt-1 block text-[10px] normal-case tracking-normal text-[#a24f45]">{validation.capacity}</span>}
              </label>
              <div className="rounded-xl bg-[#f3eff8] px-3.5 py-3 sm:col-span-2" aria-live="polite" data-testid="text-occupancy-calculated">
                <span className="text-[10px] font-bold uppercase tracking-[.08em] text-[#817b89]">Ocupação calculada</span>
                <span className="ml-2 text-sm font-extrabold tabular-nums text-[#5d4a78]">{calculatedPercentage === null ? 'Informe presenças e vagas' : formatCalculatedPct(calculatedPercentage)}</span>
              </div>
            </div>}
          </div>

          <label className={`${labelClass} mt-3`}>Modalidade
            <SuggestionInput
              value={form.modalityName}
              onValueChange={(value) => setField('modalityName', value)}
              suggestions={modalities.map((modality) => modality.name)}
              suggestionTitle="Modalidades cadastradas"
              placeholder="Escolha ou digite"
              className={fieldClass}
              testId="input-occupancy-modality"
              aria-invalid={!!showErr(validation.modality)}
              autoComplete="off"
            />
            {showErr(validation.modality) && <span className="mt-1 block text-[10px] normal-case tracking-normal text-[#a24f45]" data-testid="error-occupancy-modality">{validation.modality}</span>}
            {form.modalityName.trim() && !(editing && normalizeModalityName(form.modalityName) === normalizeModalityName(editing.modalityName)) && !modalities.some((m) => normalizeModalityName(m.name) === normalizeModalityName(form.modalityName)) && (
              <span className="mt-1 block text-[10px] font-medium normal-case tracking-normal text-[#6e9d31]" data-testid="text-occupancy-new-modality">Nova modalidade, será cadastrada ao salvar.</span>
            )}
          </label>

          <label className={`${labelClass} mt-3`}>Turma / identificação <span className="font-medium normal-case tracking-normal text-[#a39dab]">(opcional)</span>
            <input value={form.className} onChange={(e) => setField('className', e.target.value)} placeholder="ex.: 07h ou Turma A" className={fieldClass} data-testid="input-occupancy-class" />
            {showErr(validation.className) && <span className="mt-1 block text-[10px] normal-case tracking-normal text-[#a24f45]">{validation.className}</span>}
          </label>

          <label className={`${labelClass} mt-3`}>Observações <span className="font-medium normal-case tracking-normal text-[#a39dab]">(opcional)</span>
            <textarea value={form.notes} onChange={(e) => setField('notes', e.target.value)} rows={2} className={`${fieldClass} h-auto py-2.5`} data-testid="input-occupancy-notes" />
            {showErr(validation.notes) && <span className="mt-1 block text-[10px] normal-case tracking-normal text-[#a24f45]">{validation.notes}</span>}
          </label>

          {formError && (
            <div role="alert" className="mt-4 rounded-xl border border-[#f1d0ca] bg-[#fff3f1] px-3.5 py-2.5 text-xs font-semibold leading-5 text-[#8e3d33]" data-testid="status-occupancy-form-error">
              {formError}
              {formConflict && <button type="button" onClick={refreshBase} className="ml-2 underline" data-testid="button-occupancy-conflict-refresh">Atualizar base</button>}
            </div>
          )}
          {formSuccess && <div role="status" className="mt-4 rounded-xl bg-[#eff6e5] px-3.5 py-2.5 text-xs font-semibold text-[#55772c]" data-testid="status-occupancy-form-success">{formSuccess}</div>}

          <div className="mt-5 flex flex-wrap gap-2">
            <button type="submit" disabled={isSaving} aria-busy={isSaving} className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[#d7f500] px-4 text-sm font-extrabold text-[#262b15] transition hover:bg-[#c9e600] disabled:cursor-wait disabled:opacity-60" data-testid="button-submit-occupancy">
              {isSaving ? 'Salvando…' : editing ? 'Salvar correção' : <><Plus size={16} /> Registrar aula</>}
            </button>
            {(editing || touched) && <button type="button" onClick={resetForm} disabled={isSaving} className="h-11 rounded-xl border border-[#ded7e7] bg-white px-4 text-sm font-bold text-[#5d4a78] hover:bg-[#f7f4fa]" data-testid="button-cancel-occupancy-edit">{editing ? 'Cancelar edição' : 'Limpar'}</button>}
          </div>
        </form>

        {/* HISTORY */}
        <section className="overflow-hidden rounded-[24px] border border-[#e7e1e9] bg-[#fffefc]" aria-labelledby="occupancy-history-heading" data-testid="section-occupancy-history">
          <div className="border-b border-[#ece7ee] px-4 py-4 sm:px-5">
            <div className="flex items-end justify-between gap-3">
              <div><p className="eyebrow text-[9px] font-bold text-[#8a8491]">histórico</p><h2 id="occupancy-history-heading" className="mt-1 text-base font-extrabold tracking-[-.035em] text-[#332d40]">Registros de ocupação</h2></div>
              <span className="text-[10px] font-semibold text-[#8a8491]" data-testid="text-occupancy-count">{records.length} {records.length === 1 ? 'registro' : 'registros'}</span>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-6" data-testid="filters-occupancy">
              <label className={labelClass}>Período
                <select value={filterState.periodMode} onChange={(e) => changeFilterMode(e.target.value as OccupancyPeriodMode)} className={fieldClass} data-testid="filter-occupancy-mode">
                  <option value="all">Todo o histórico</option>
                  <option value="day">Um dia</option>
                  <option value="range">Intervalo de datas</option>
                  <option value="months">Um ou vários meses</option>
                </select>
              </label>
              <label className={labelClass}>Tipo
                <select value={filterKind} onChange={(e) => setFilterKind(e.target.value as 'all' | Kind)} className={fieldClass} data-testid="filter-occupancy-kind">
                  <option value="all">Diários e mensais</option>
                  <option value="daily">Somente diários</option>
                  <option value="monthly">Somente mensais</option>
                </select>
              </label>
              <label className={labelClass}>Modalidade
                <PurpleSelect
                  value={filterState.modalityId || '__all_modalities__'}
                  onValueChange={(value) => updateOccupancyFilters({ modalityId: value === '__all_modalities__' ? '' : value })}
                  className="mt-1.5 rounded-lg"
                  testId="filter-occupancy-modality"
                  options={[
                    { value: '__all_modalities__', label: 'Todas' },
                    ...modalities.map((modality) => ({ value: modality.id, label: modality.name })),
                  ]}
                />
              </label>
              <label className={labelClass}>Turma / horário
                <input value={filterState.className} onChange={(e) => updateOccupancyFilters({ className: e.target.value })} placeholder="Todas" className={fieldClass} data-testid="filter-occupancy-class" />
              </label>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className={labelClass}>Ano
                <select value={filterState.year} onChange={(event) => updateOccupancyYear(event.target.value)} className={fieldClass} data-testid="filter-occupancy-year" disabled={filterState.periodMode === 'day' || filterState.periodMode === 'range'}>
                  <option value="">Todos os anos</option>
                  {yearOptions.map((year) => <option key={year} value={year}>{year}</option>)}
                </select>
              </label>
              <label className={labelClass}>Trimestre
                <select value={filterState.quarter} onChange={(event) => updateOccupancyQuarter(event.target.value)} className={fieldClass} data-testid="filter-occupancy-quarter" disabled={filterState.periodMode === 'day' || filterState.periodMode === 'range'}>
                  <option value="">Todos os trimestres</option>
                  <option value="1">1º trimestre · jan–mar</option>
                  <option value="2">2º trimestre · abr–jun</option>
                  <option value="3">3º trimestre · jul–set</option>
                  <option value="4">4º trimestre · out–dez</option>
                </select>
              </label>
            </div>
            {filterState.periodMode !== 'all' && (
              <div className="mt-3" data-testid="controls-occupancy-period">
                {filterState.periodMode === 'day' && (
                  <label className={`${labelClass} max-w-[220px]`}>Dia
                    <input type="date" value={filterState.day} onChange={(e) => updateOccupancyFilters({ day: e.target.value })} className={fieldClass} data-testid="filter-occupancy-day" />
                  </label>
                )}
                {filterState.periodMode === 'range' && (
                  <div className="grid max-w-[440px] grid-cols-2 gap-2">
                    <label className={labelClass}>Data inicial<input type="date" value={filterState.fromDate} onChange={(e) => updateOccupancyFilters({ fromDate: e.target.value })} className={fieldClass} data-testid="filter-occupancy-date-from" /></label>
                    <label className={labelClass}>Data final<input type="date" value={filterState.toDate} onChange={(e) => updateOccupancyFilters({ toDate: e.target.value })} className={fieldClass} data-testid="filter-occupancy-date-to" /></label>
                  </div>
                )}
                {filterState.periodMode === 'months' && (
                  <div className="space-y-2">
                    <div className="flex max-w-[360px] items-end gap-2">
                      <label className={`${labelClass} min-w-0 flex-1`}>Adicionar mês<input type="month" value={monthToAdd} onChange={(e) => setMonthToAdd(e.target.value)} className={fieldClass} data-testid="filter-occupancy-month-to-add" /></label>
                      <button type="button" onClick={() => monthToAdd && updateOccupancyFilters({ months: [...new Set([...filterState.months, monthToAdd])].sort() })} disabled={!monthToAdd || filterState.months.includes(monthToAdd)} className="h-10 shrink-0 rounded-lg bg-[#7656b8] px-3 text-xs font-bold text-white hover:bg-[#6748a7] disabled:cursor-not-allowed disabled:opacity-50" data-testid="button-add-occupancy-month">Adicionar</button>
                    </div>
                    <div className="flex min-h-7 flex-wrap gap-1.5" data-testid="list-occupancy-selected-months">
                      {filterState.months.map((m) => (
                        <span key={m} className="inline-flex items-center gap-1 rounded-full bg-[#eee8f7] py-1 pl-2.5 pr-1 text-[10px] font-semibold capitalize text-[#5d4a78]" data-testid={`chip-occupancy-month-${m}`}>
                          {formatMonthKey(m)}
                          <button type="button" onClick={() => updateOccupancyFilters({ months: filterState.months.filter((x) => x !== m) })} aria-label={`Remover ${formatMonthKey(m)}`} className="grid h-5 w-5 place-items-center rounded-full text-[#7656b8] hover:bg-white" data-testid={`button-remove-occupancy-month-${m}`}><X size={11} /></button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {filterState.periodMode === 'range' && <p className="mt-2 text-[10px] leading-4 text-[#8a8491]">Consolidados mensais aparecem somente quando o mês inteiro está dentro do intervalo.</p>}
              </div>
            )}
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <fieldset className="min-w-0">
                <legend className={labelClass}>Horário inicial</legend>
                <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="filter-occupancy-times">
                  {startTimeOptions.map((time) => {
                    const selected = filterState.startTimes.includes(time);
                    return <label key={time} className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[11px] font-bold tabular-nums ${selected ? 'border-[#7656b8] bg-[#eee8f7] text-[#5d4a78]' : 'border-[#e7e2ea] bg-white text-[#746c7e]'}`}>
                      <input type="checkbox" checked={selected} onChange={() => toggleFilterTime(time)} className="accent-[#7656b8]" data-testid={`filter-occupancy-time-${time.replace(':', '')}`} />
                      {time}
                    </label>;
                  })}
                  {!startTimeOptions.length && <span className="text-xs font-medium text-[#908897]">Os horários aparecem após cadastrar aulas.</span>}
                </div>
              </fieldset>
              <fieldset className="min-w-0">
                <legend className={labelClass}>Dia da semana</legend>
                <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="filter-occupancy-weekdays">
                  {['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].map((day, index) => {
                    const weekday = index + 1;
                    const selected = filterState.weekdays.includes(weekday);
                    return <label key={day} className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[11px] font-bold ${selected ? 'border-[#7656b8] bg-[#eee8f7] text-[#5d4a78]' : 'border-[#e7e2ea] bg-white text-[#746c7e]'}`}>
                      <input type="checkbox" checked={selected} onChange={() => toggleFilterWeekday(weekday)} className="accent-[#7656b8]" data-testid={`filter-occupancy-weekday-${weekday}`} />
                      {day}
                    </label>;
                  })}
                </div>
              </fieldset>
            </div>
            {(filterState.startTimes.length > 0 || filterState.weekdays.length > 0) && <p className="mt-2 text-[10px] leading-4 text-[#8a8491]" role="status" data-testid="status-occupancy-daily-only-filter">Filtros de horário e dia da semana mostram apenas aulas diárias; registros mensais antigos não têm esses dados.</p>}
            <p className="mt-2 text-[10px] font-semibold text-[#766d83]" data-testid="text-occupancy-applied-filters">Recorte aplicado: {occupancyFilterSummary(filterState)}{filterState.modalityId ? ` · ${modalities.find((modality) => modality.id === filterState.modalityId)?.name ?? 'Modalidade'}` : ''}{filterState.className.trim() ? ` · Turma ${filterState.className.trim()}` : ''}</p>
            {filterOptionsQuery.isError && <p className="mt-2 text-xs font-semibold text-[#a24f45]" role="alert" data-testid="error-occupancy-filter-options">Não foi possível carregar as opções de ano e horário. Use Atualizar base para tentar novamente.</p>}
            <div className="mt-3 flex items-center justify-between gap-2">
              {filterProblem ? <p className="text-xs font-semibold text-[#a24f45]" role="alert" data-testid="status-occupancy-filter">{filterProblem}</p> : <span />}
              <button type="button" onClick={clearFilters} className="h-8 rounded-lg px-3 text-xs font-semibold text-[#766d83] hover:bg-[#f6f3f8]" data-testid="button-clear-occupancy-filters">Limpar filtros</button>
            </div>
          </div>

          {records.length > 0 && <div className="grid gap-2 border-b border-[#f0edf1] bg-[#fbfafb] p-3 sm:grid-cols-3" data-testid="summary-occupancy-selection">
            <div className="rounded-xl bg-white px-3 py-2.5"><p className="text-[9px] font-bold uppercase tracking-[.1em] text-[#817b89]">Aulas com presenças e vagas</p><p className="mt-1 text-sm font-extrabold tabular-nums text-[#443d50]" data-testid="text-occupancy-measured-count">{measuredRecords.toLocaleString('pt-BR')}</p></div>
            <div className="rounded-xl bg-white px-3 py-2.5"><p className="text-[9px] font-bold uppercase tracking-[.1em] text-[#817b89]">Presenças / vagas</p><p className="mt-1 text-sm font-extrabold tabular-nums text-[#443d50]" data-testid="text-occupancy-presence-capacity">{totalPresences?.toLocaleString('pt-BR') ?? '—'} / {totalCapacity?.toLocaleString('pt-BR') ?? '—'}</p></div>
            <div className="rounded-xl bg-white px-3 py-2.5"><p className="text-[9px] font-bold uppercase tracking-[.1em] text-[#817b89]">Ocupação ponderada</p><p className="mt-1 text-sm font-extrabold tabular-nums text-[#5d4a78]" data-testid="text-occupancy-weighted-rate">{weightedOccupancy === null ? 'Sem capacidade registrada' : formatCalculatedPct(weightedOccupancy)}</p></div>
            {legacyRecords > 0 && <p className="text-[10px] font-medium text-[#817b89] sm:col-span-3" data-testid="text-occupancy-legacy-count">{legacyRecords} registro(s) legado(s) sem presenças/vagas ficam fora do cálculo ponderado.</p>}
            {filterKind === 'all' && filterState.viewMode !== 'daily' && <p className="text-[10px] font-medium text-[#817b89] sm:col-span-3" data-testid="text-occupancy-summary-precedence">No modo mensal ou trimestral, o resumo mensal substitui os detalhes diários da mesma turma e mês para evitar duplicidade.</p>}
          </div>}

          {recordsQuery.isLoading && !filterInvalid ? (
            <div className="space-y-2 p-4" data-testid="status-occupancy-loading">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-14 rounded-xl" />)}</div>
          ) : recordsQuery.isError && !filterInvalid ? (
            <div className="grid place-items-center p-8 text-center" data-testid="status-occupancy-error">
              <CircleHelp className="text-[#ad6254]" size={24} />
              <p className="mt-3 text-sm font-bold">O histórico não carregou</p>
              <p className="mt-1 text-xs text-[#827b8b]">{apiErrorMessage(recordsQuery.error, 'record')}</p>
              <button type="button" onClick={refreshBase} className="mt-4 inline-flex items-center gap-2 rounded-full bg-[#7656b8] px-4 py-2.5 text-xs font-bold text-white" data-testid="button-retry-occupancy"><RefreshCw size={13} /> Tentar novamente</button>
            </div>
          ) : records.length === 0 ? (
            <div className="flex items-start gap-3 p-5" data-testid="status-occupancy-empty">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#eee8f7] text-[#7656b8]"><CalendarDays size={17} /></span>
              <div>
                <p className="text-sm font-bold text-[#40374e]">{filterInvalid ? 'Complete o filtro para consultar' : 'Sem dados neste recorte'}</p>
                  <p className="mt-1 text-xs leading-5 text-[#827b8b]">Ausência de registro não significa ocupação zero. Registre presenças e capacidade da aula para calcular o percentual.</p>
              </div>
            </div>
          ) : (
            <ul className="divide-y divide-[#f0edf1]" data-testid="list-occupancy-records">
              {records.map((r) => (
                <li key={r.id} className={`grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 px-4 py-3.5 sm:grid-cols-[110px_1fr_auto_auto] sm:px-5 ${editing?.id === r.id ? 'bg-[#f8f5fc]' : ''}`} data-testid={`row-occupancy-${r.id}`}>
                  <div className="flex items-center gap-2 sm:block">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-[.08em] ${r.kind === 'daily' ? 'bg-[#eee8f7] text-[#65479c]' : 'bg-[#e9f4d6] text-[#4f7224]'}`} data-testid={`badge-occupancy-kind-${r.id}`}>{r.kind === 'daily' ? 'Diário' : 'Mensal'}</span>
                    <span className="text-xs font-bold capitalize tabular-nums text-[#4b4357] sm:mt-1 sm:block" data-testid={`text-occupancy-period-${r.id}`}>{r.kind === 'daily' ? formatDay(r.period) : formatMonthKey(r.period)}</span>
                  </div>
                  <p className="row-span-2 text-right font-[family-name:var(--app-font-serif)] text-xl font-extrabold tracking-[-.04em] tabular-nums text-[#2f2a3d] sm:order-3 sm:row-span-1" data-testid={`text-occupancy-percentage-${r.id}`}>{formatPct(r.percentage)}</p>
                  <div className="min-w-0 sm:order-2">
                    <p className="truncate text-sm font-semibold text-[#3f384b]" data-testid={`text-occupancy-modality-${r.id}`}>{r.modalityName}{r.className && <span className="font-medium text-[#857e8e]"> · {r.className}</span>}</p>
                    {r.presences !== null && r.capacity !== null && <p className="mt-0.5 text-[10px] font-medium tabular-nums text-[#817b89]" data-testid={`text-occupancy-measurements-${r.id}`}>
                      {r.startTime}{r.endTime ? `–${r.endTime}` : ''} · {r.presences}/{r.capacity} presenças/vagas
                    </p>}
                    {r.notes && <p className="truncate text-[11px] text-[#8a8491]" title={r.notes}>{r.notes}</p>}
                  </div>
                  <div className="col-span-2 flex justify-end gap-1 sm:order-4 sm:col-span-1">
                    <button type="button" onClick={() => startEdit(r)} aria-label={`Editar ${recordLabel(r)}`} className="grid h-9 w-9 place-items-center rounded-lg text-[#6d5a8a] hover:bg-[#f3eff8]" data-testid={`button-edit-occupancy-${r.id}`}><Pencil size={15} /></button>
                    <button type="button" onClick={() => { setDeleteError(null); setToDelete(r); }} aria-label={`Excluir ${recordLabel(r)}`} className="grid h-9 w-9 place-items-center rounded-lg text-[#a0584f] hover:bg-[#fff0ed]" data-testid={`button-delete-occupancy-${r.id}`}><Trash2 size={15} /></button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <AlertDialog open={!!toDelete} onOpenChange={(open) => { if (!open && !deleteRecord.isPending) setToDelete(null); }}>
        <AlertDialogContent className="rounded-[22px] border-[#e7e1e9] bg-[#fffefc]" data-testid="dialog-delete-occupancy">
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir registro de ocupação?</AlertDialogTitle>
            <AlertDialogDescription data-testid="text-delete-occupancy-target">
              {toDelete && <>Você vai excluir o registro {toDelete.kind === 'daily' ? 'diário' : 'mensal'} de <strong>{recordLabel(toDelete)}</strong> com {formatPct(toDelete.percentage)}. Esta ação não pode ser desfeita.</>}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && <div role="alert" className="rounded-xl border border-[#f1d0ca] bg-[#fff3f1] px-3.5 py-2.5 text-xs font-semibold text-[#8e3d33]" data-testid="status-delete-occupancy-error">{deleteError} <button type="button" onClick={() => { setToDelete(null); refreshBase(); }} className="underline" data-testid="button-delete-occupancy-refresh">Atualizar base</button></div>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteRecord.isPending} data-testid="button-cancel-delete-occupancy">Cancelar</AlertDialogCancel>
            <button type="button" onClick={() => void confirmDelete()} disabled={deleteRecord.isPending} className="inline-flex h-10 items-center justify-center rounded-md bg-[#bc4141] px-4 text-sm font-bold text-white hover:bg-[#a63636] disabled:opacity-60" data-testid="button-confirm-delete-occupancy">{deleteRecord.isPending ? 'Excluindo…' : 'Excluir registro'}</button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ModalitiesDialog open={modalitiesOpen} onOpenChange={setModalitiesOpen} modalities={modalities} isLoading={modalitiesQuery.isLoading} isError={modalitiesQuery.isError} onRetry={refreshBase} onChanged={invalidateAll} />
      <OccupancyImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={() => { void invalidateAll(); }} />
    </div>
  );
}

function ModalitiesDialog({ open, onOpenChange, modalities, isLoading, isError, onRetry, onChanged }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  modalities: OccupancyModality[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onChanged: () => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const createModality = useCreateOccupancyModality();
  const updateModality = useUpdateOccupancyModality();
  const deleteModality = useDeleteOccupancyModality();
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; version: number; name: string } | null>(null);
  const [toDelete, setToDelete] = useState<{ id: string; version: number; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lock = useRef(false);
  const deleteLock = useRef(false);
  const busy = createModality.isPending || updateModality.isPending || deleteModality.isPending;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const name = newName.trim().replace(/\s+/g, ' ');
    setNotice(null);
    if (!name) { setError('Informe o nome da modalidade.'); return; }
    if (name.length > 120) { setError('Máximo de 120 caracteres.'); return; }
    if (modalities.some((m) => normalizeModalityName(m.name) === normalizeModalityName(name))) { setError('Esta modalidade já está cadastrada.'); return; }
    if (lock.current || busy) return;
    lock.current = true;
    setError(null);
    try {
      await createModality.mutateAsync({ data: { name } });
      setNewName('');
      setNotice(`${name} cadastrada.`);
      await onChanged();
    } catch (err) {
      setError(apiErrorMessage(err, 'modality'));
    } finally { lock.current = false; }
  };

  const rename = async () => {
    if (!renaming) return;
    const name = renaming.name.trim().replace(/\s+/g, ' ');
    setNotice(null);
    if (!name) { setError('O nome não pode ficar vazio.'); return; }
    if (name.length > 120) { setError('Máximo de 120 caracteres.'); return; }
    if (modalities.some((m) => m.id !== renaming.id && normalizeModalityName(m.name) === normalizeModalityName(name))) { setError('Já existe outra modalidade com esse nome.'); return; }
    if (lock.current || busy) return;
    lock.current = true;
    setError(null);
    try {
      await updateModality.mutateAsync({ id: renaming.id, data: { name, version: renaming.version } });
      setRenaming(null);
      setNotice('Nome atualizado. Os registros existentes continuam vinculados.');
      await onChanged();
    } catch (err) {
      setError(apiErrorMessage(err, 'modality'));
    } finally { lock.current = false; }
  };

  const confirmDelete = async () => {
    if (!toDelete || deleteLock.current || busy) return;
    deleteLock.current = true;
    setDeleteError(null);
    setError(null);
    setNotice(null);
    try {
      const result = await deleteModality.mutateAsync({
        id: toDelete.id,
        data: { version: toDelete.version },
      });
      setToDelete(null);
      setNotice(`${toDelete.name} excluída. ${result.deletedRecords} aula(s) removida(s) e ${result.unlinkedProducts} produto(s) desvinculado(s).`);
      await onChanged();
      await queryClient.invalidateQueries();
    } catch (err) {
      setDeleteError(apiErrorMessage(err, 'modality'));
    } finally {
      deleteLock.current = false;
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy && !toDelete) { onOpenChange(o); if (!o) { setRenaming(null); setError(null); setDeleteError(null); setNotice(null); } } }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto rounded-[22px] border-[#e7e1e9] bg-[#fffefc] sm:max-w-[480px]" data-testid="dialog-modalities">
        <DialogHeader>
          <DialogTitle className="text-xl font-extrabold tracking-[-.04em]">Modalidades</DialogTitle>
          <DialogDescription>Renomear não altera os vínculos: os registros acompanham o novo nome.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void create(e)} className="flex items-end gap-2" noValidate>
          <label className={`${labelClass} min-w-0 flex-1`}>Nova modalidade
            <input value={newName} onChange={(e) => { setNewName(e.target.value); setError(null); }} placeholder="ex.: Pilates" className={fieldClass} data-testid="input-new-modality" />
          </label>
          <button type="submit" disabled={busy} className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg bg-[#7656b8] px-3 text-xs font-bold text-white hover:bg-[#6748a7] disabled:opacity-60" data-testid="button-create-modality"><Plus size={14} /> Cadastrar</button>
        </form>
        {error && <p role="alert" className="rounded-xl border border-[#f1d0ca] bg-[#fff3f1] px-3 py-2 text-xs font-semibold text-[#8e3d33]" data-testid="status-modality-error">{error}</p>}
        {notice && <p role="status" className="rounded-xl bg-[#eff6e5] px-3 py-2 text-xs font-semibold text-[#55772c]" data-testid="status-modality-success">{notice}</p>}
        {isLoading ? (
          <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-11 rounded-xl" />)}</div>
        ) : isError ? (
          <div className="rounded-xl border border-dashed border-[#ded8e5] p-4 text-center text-xs text-[#827b8b]" data-testid="status-modalities-error">Não foi possível carregar as modalidades. <button type="button" onClick={onRetry} className="font-bold text-[#6846a9] underline" data-testid="button-retry-modalities">Tentar novamente</button></div>
        ) : modalities.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[#ded8e5] p-4 text-center text-xs text-[#827b8b]" data-testid="status-modalities-empty">Nenhuma modalidade ainda. Cadastre aqui ou digite uma nova ao lançar a ocupação.</p>
        ) : (
          <ul className="divide-y divide-[#f0edf1] rounded-xl border border-[#ece7ee]" data-testid="list-modalities">
            {modalities.map((m) => (
              <li key={m.id} className="flex items-center gap-2 px-3 py-2" data-testid={`row-modality-${m.id}`}>
                {renaming?.id === m.id ? (
                  <>
                    <input autoFocus value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void rename(); } if (e.key === 'Escape') setRenaming(null); }} className="h-9 min-w-0 flex-1 rounded-lg border border-[#e7e2ea] px-2.5 text-xs outline-none focus:border-[#9477bf]" data-testid={`input-rename-modality-${m.id}`} />
                    <button type="button" onClick={() => void rename()} disabled={busy} className="h-9 rounded-lg bg-[#7656b8] px-3 text-xs font-bold text-white disabled:opacity-60" data-testid={`button-save-modality-${m.id}`}>Salvar</button>
                    <button type="button" onClick={() => { setRenaming(null); setError(null); }} disabled={busy} className="h-9 rounded-lg px-2 text-xs font-semibold text-[#766d83] hover:bg-[#f6f3f8]" data-testid={`button-cancel-rename-modality-${m.id}`}>Cancelar</button>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[#3f384b]" data-testid={`text-modality-name-${m.id}`}>{m.name}</span>
                    <button type="button" onClick={() => { setRenaming({ id: m.id, version: m.version, name: m.name }); setError(null); setNotice(null); }} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-[#6d5a8a] hover:bg-[#f3eff8]" data-testid={`button-rename-modality-${m.id}`}><Pencil size={13} /> Renomear</button>
                    <button type="button" onClick={() => { setToDelete({ id: m.id, version: m.version, name: m.name }); setDeleteError(null); setError(null); setNotice(null); }} aria-label={`Excluir modalidade ${m.name}`} disabled={busy} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[#a0584f] hover:bg-[#fff0ed] disabled:opacity-50" data-testid={`button-delete-modality-${m.id}`}><Trash2 size={15} /></button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
      <AlertDialog open={!!toDelete} onOpenChange={(isOpen) => { if (!isOpen && !deleteModality.isPending) { setToDelete(null); setDeleteError(null); } }}>
        <AlertDialogContent className="rounded-[22px] border-[#e7e1e9] bg-[#fffefc]" data-testid="dialog-delete-modality">
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir modalidade e vínculos?</AlertDialogTitle>
            <AlertDialogDescription data-testid="text-delete-modality-warning">
              {toDelete && <>A modalidade <strong>{toDelete.name}</strong> e todas as aulas vinculadas serão removidas. Os produtos associados perderão o vínculo, e as vendas deixarão de ser classificadas por essa modalidade. Esta ação não pode ser desfeita.</>}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && <p role="alert" className="rounded-xl border border-[#f1d0ca] bg-[#fff3f1] px-3 py-2 text-xs font-semibold text-[#8e3d33]" data-testid="status-delete-modality-error">{deleteError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteModality.isPending} data-testid="button-cancel-delete-modality">Cancelar</AlertDialogCancel>
            <button type="button" onClick={() => void confirmDelete()} disabled={deleteModality.isPending} className="inline-flex h-10 items-center justify-center rounded-md bg-[#bc4141] px-4 text-sm font-bold text-white hover:bg-[#a63636] disabled:opacity-60" data-testid="button-confirm-delete-modality">{deleteModality.isPending ? 'Excluindo…' : 'Excluir modalidade e vínculos'}</button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
