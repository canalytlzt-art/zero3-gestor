import { useMemo, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CircleHelp, Gauge, Layers, Pencil, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import {
  getGetOccupancyModalitiesQueryKey,
  getGetOccupancyRecordsQueryKey,
  useCreateOccupancyModality,
  useCreateOccupancyRecord,
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
import OccupancyImportDialog from '@/components/occupancy-import-dialog';

type Kind = 'daily' | 'monthly';
type FilterMode = 'all' | 'day' | 'range' | 'months';

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

function formatPct(value: number) {
  return `${value.toLocaleString('pt-BR', { maximumFractionDigits: 15 })}%`;
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
      : 'Conflito: já existe registro para este período, modalidade, tipo e turma, ou o registro foi alterado. Atualize a base e reabra antes de salvar.';
  }
  if (typeof e?.data?.error === 'string') return e.data.error;
  if (typeof e?.message === 'string') return e.message;
  return 'Não foi possível concluir. Tente novamente.';
}

const emptyForm = (kind: Kind = 'daily') => ({
  kind,
  day: '',
  month: getSaoPauloMonthKey(),
  modalityName: '',
  percentage: '',
  className: '',
  notes: '',
});

export default function OccupancyManagement() {
  const queryClient = useQueryClient();
  const currentMonth = getSaoPauloMonthKey();

  // ---- form state (independent from filters)
  const [form, setForm] = useState(emptyForm());
  const [editing, setEditing] = useState<{ id: string; version: number; label: string; modalityId: string; modalityName: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [formConflict, setFormConflict] = useState(false);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const submitLock = useRef(false);

  // ---- filter state
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [filterDay, setFilterDay] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [filterMonths, setFilterMonths] = useState<string[]>([currentMonth]);
  const [monthToAdd, setMonthToAdd] = useState(currentMonth);
  const [filterModality, setFilterModality] = useState('');
  const [filterClass, setFilterClass] = useState('');
  const [filterKind, setFilterKind] = useState<'all' | Kind>('all');

  // ---- delete + modality dialogs
  const [toDelete, setToDelete] = useState<OccupancyRecord | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteLock = useRef(false);
  const [modalitiesOpen, setModalitiesOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const filterInvalid = (filterMode === 'day' && !filterDay)
    || (filterMode === 'range' && (!filterFrom || !filterTo || filterFrom > filterTo))
    || (filterMode === 'months' && filterMonths.length === 0);
  const filterProblem = filterMode === 'day' && !filterDay
    ? 'Escolha o dia que deseja consultar.'
    : filterMode === 'range' && (!filterFrom || !filterTo)
      ? 'Informe as datas inicial e final para consultar o intervalo.'
      : filterMode === 'range' && filterFrom > filterTo
        ? 'A data inicial deve ser anterior ou igual à data final.'
        : filterMode === 'months' && filterMonths.length === 0
          ? 'Selecione ao menos um mês.'
          : null;

  const params = useMemo<GetOccupancyRecordsParams>(() => {
    const p: GetOccupancyRecordsParams = { kind: filterKind };
    if (filterMode === 'day' && filterDay) { p.fromDate = filterDay; p.toDate = filterDay; }
    if (filterMode === 'range' && filterFrom && filterTo) { p.fromDate = filterFrom; p.toDate = filterTo; }
    if (filterMode === 'months' && filterMonths.length) p.months = [...filterMonths].sort().join(',');
    if (filterModality) p.modalityId = filterModality;
    if (filterClass.trim()) p.className = filterClass.trim();
    return p;
  }, [filterKind, filterMode, filterDay, filterFrom, filterTo, filterMonths, filterModality, filterClass]);

  const modalitiesQuery = useGetOccupancyModalities({
    query: { queryKey: getGetOccupancyModalitiesQueryKey(), refetchOnMount: 'always', refetchOnWindowFocus: true, staleTime: 15000 },
  });
  const recordsQuery = useGetOccupancyRecords(params, {
    query: { queryKey: getGetOccupancyRecordsQueryKey(params), enabled: !filterInvalid, refetchOnMount: 'always', refetchOnWindowFocus: true, staleTime: 15000 },
  });
  const createRecord = useCreateOccupancyRecord();
  const updateRecord = useUpdateOccupancyRecord();
  const deleteRecord = useDeleteOccupancyRecord();

  const modalities = useMemo(() => [...(modalitiesQuery.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' })), [modalitiesQuery.data]);
  const records = filterInvalid ? [] : recordsQuery.data ?? [];

  const invalidateAll = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: getGetOccupancyRecordsQueryKey() }),
    queryClient.invalidateQueries({ queryKey: getGetOccupancyModalitiesQueryKey() }),
  ]);
  const refreshBase = () => { void Promise.all([...(filterInvalid ? [] : [recordsQuery.refetch()]), modalitiesQuery.refetch()]); };
  const isRefreshing = recordsQuery.isFetching || modalitiesQuery.isFetching;

  const pct = parsePercentage(form.percentage);
  const periodValue = form.kind === 'daily' ? form.day : form.month;
  const validation = {
    period: !periodValue ? (form.kind === 'daily' ? 'Informe o dia.' : 'Informe o mês.') : null,
    modality: !form.modalityName.trim() ? 'Informe a modalidade.' : form.modalityName.trim().length > 120 ? 'Máximo de 120 caracteres.' : null,
    percentage: pct.error,
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
    setForm((f) => emptyForm(f.kind));
    setEditing(null);
    setFormError(null);
    setFormConflict(false);
    setTouched(false);
  };

  const startEdit = (record: OccupancyRecord) => {
    setEditing({ id: record.id, version: record.version, label: recordLabel(record), modalityId: record.modalityId, modalityName: record.modalityName });
    setForm({
      kind: record.kind,
      day: record.kind === 'daily' ? record.period : '',
      month: record.kind === 'monthly' ? record.period : record.month,
      modalityName: record.modalityName,
      percentage: String(record.percentage).replace('.', ','),
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
    if (submitLock.current || isSaving || hasErrors || pct.value === null) return;
    submitLock.current = true;
    setFormError(null);
    setFormConflict(false);
    const typed = form.modalityName.trim().replace(/\s+/g, ' ');
    const match = modalities.find((m) => normalizeModalityName(m.name) === normalizeModalityName(typed));
    const className = form.className.trim();
    const notes = form.notes.trim();
    const input: OccupancyRecordInput = {
      kind: form.kind,
      period: periodValue,
      modalityName: match ? match.name : typed,
      percentage: pct.value,
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
        setFormSuccess(form.kind === 'daily' ? 'Ocupação diária registrada.' : 'Consolidado mensal registrado.');
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

  const changeFilterMode = (mode: FilterMode) => {
    setFilterMode(mode);
    if (mode !== 'day') setFilterDay('');
    if (mode !== 'range') { setFilterFrom(''); setFilterTo(''); }
    if (mode === 'months' && filterMonths.length === 0) setFilterMonths([currentMonth]);
  };
  const clearFilters = () => {
    setFilterMode('all'); setFilterDay(''); setFilterFrom(''); setFilterTo('');
    setFilterMonths([currentMonth]); setMonthToAdd(currentMonth);
    setFilterModality(''); setFilterClass(''); setFilterKind('all');
  };

  const showErr = (msg: string | null) => touched && msg;

  return (
    <div className="space-y-5" data-testid="occupancy-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="eyebrow text-[9px] font-bold text-[#8a8491]">percentuais informados</p>
          <p className="mt-1 max-w-[560px] text-sm text-[#77717f]">Registre a ocupação das aulas como ela chega do sistema de presença. Cada percentual fica como foi informado, por dia ou como consolidado do mês.</p>
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
              <p className="eyebrow text-[9px] font-bold text-[#8a8491]">{editing ? 'editando registro' : 'novo registro'}</p>
              <h2 id="occupancy-form-heading" className="mt-1 text-xl font-extrabold tracking-[-.04em] text-[#171522]">{editing ? 'Corrigir ocupação' : 'Lançar ocupação'}</h2>
              {editing && <p className="mt-1 text-xs text-[#77717f]" data-testid="text-occupancy-editing">{editing.label}</p>}
            </div>
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#eee8f7] text-[#7656b8]"><Gauge size={18} /></span>
          </div>

          <fieldset className="mt-5">
            <legend className={labelClass}>Tipo de registro</legend>
            <div className="mt-1.5 grid grid-cols-2 gap-1 rounded-xl bg-[#f3f0f5] p-1" role="radiogroup" data-testid="input-occupancy-kind">
              {(['daily', 'monthly'] as const).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={form.kind === k} onClick={() => setField('kind', k)} className={`rounded-lg px-3 py-2 text-left transition ${form.kind === k ? 'bg-white text-[#3f3354] shadow-sm' : 'text-[#7a7383] hover:text-[#4c4358]'}`} data-testid={`option-occupancy-kind-${k}`}>
                  <span className="block text-xs font-extrabold">{k === 'daily' ? 'Diário' : 'Mensal consolidado'}</span>
                  <span className="block text-[10px] font-medium opacity-80">{k === 'daily' ? 'Percentual de um dia' : 'Resumo informado do mês'}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className={labelClass}>{form.kind === 'daily' ? 'Dia' : 'Mês'}
              {form.kind === 'daily'
                ? <input type="date" value={form.day} onChange={(e) => setField('day', e.target.value)} className={fieldClass} data-testid="input-occupancy-period" aria-invalid={!!showErr(validation.period)} />
                : <input type="month" value={form.month} onChange={(e) => setField('month', e.target.value)} className={fieldClass} data-testid="input-occupancy-period" aria-invalid={!!showErr(validation.period)} />}
              {showErr(validation.period) && <span className="mt-1 block text-[10px] normal-case tracking-normal text-[#a24f45]" data-testid="error-occupancy-period">{validation.period}</span>}
            </label>
            <label className={labelClass}>Percentual de ocupação
              <div className="relative">
                <input inputMode="decimal" value={form.percentage} onChange={(e) => setField('percentage', e.target.value)} placeholder="ex.: 72,5" className={`${fieldClass} pr-8 tabular-nums`} data-testid="input-occupancy-percentage" aria-invalid={!!showErr(validation.percentage)} />
                <span className="pointer-events-none absolute right-3 top-[calc(50%+3px)] -translate-y-1/2 text-xs font-bold text-[#9a93a3]">%</span>
              </div>
              {showErr(validation.percentage) && <span className="mt-1 block text-[10px] normal-case leading-4 tracking-normal text-[#a24f45]" role="alert" data-testid="error-occupancy-percentage">{validation.percentage}</span>}
            </label>
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

          <label className={`${labelClass} mt-3`}>Turma ou horário <span className="font-medium normal-case tracking-normal text-[#a39dab]">(opcional)</span>
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
              {isSaving ? 'Salvando…' : editing ? 'Salvar correção' : <><Plus size={16} /> Registrar ocupação</>}
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
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="filters-occupancy">
              <label className={labelClass}>Período
                <select value={filterMode} onChange={(e) => changeFilterMode(e.target.value as FilterMode)} className={fieldClass} data-testid="filter-occupancy-mode">
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
                  value={filterModality || '__all_modalities__'}
                  onValueChange={(value) => setFilterModality(value === '__all_modalities__' ? '' : value)}
                  className="mt-1.5 rounded-lg"
                  testId="filter-occupancy-modality"
                  options={[
                    { value: '__all_modalities__', label: 'Todas' },
                    ...modalities.map((modality) => ({ value: modality.id, label: modality.name })),
                  ]}
                />
              </label>
              <label className={labelClass}>Turma / horário
                <input value={filterClass} onChange={(e) => setFilterClass(e.target.value)} placeholder="Todas" className={fieldClass} data-testid="filter-occupancy-class" />
              </label>
            </div>
            {filterMode !== 'all' && (
              <div className="mt-3" data-testid="controls-occupancy-period">
                {filterMode === 'day' && (
                  <label className={`${labelClass} max-w-[220px]`}>Dia
                    <input type="date" value={filterDay} onChange={(e) => setFilterDay(e.target.value)} className={fieldClass} data-testid="filter-occupancy-day" />
                  </label>
                )}
                {filterMode === 'range' && (
                  <div className="grid max-w-[440px] grid-cols-2 gap-2">
                    <label className={labelClass}>Data inicial<input type="date" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} className={fieldClass} data-testid="filter-occupancy-date-from" /></label>
                    <label className={labelClass}>Data final<input type="date" value={filterTo} onChange={(e) => setFilterTo(e.target.value)} className={fieldClass} data-testid="filter-occupancy-date-to" /></label>
                  </div>
                )}
                {filterMode === 'months' && (
                  <div className="space-y-2">
                    <div className="flex max-w-[360px] items-end gap-2">
                      <label className={`${labelClass} min-w-0 flex-1`}>Adicionar mês<input type="month" value={monthToAdd} onChange={(e) => setMonthToAdd(e.target.value)} className={fieldClass} data-testid="filter-occupancy-month-to-add" /></label>
                      <button type="button" onClick={() => monthToAdd && setFilterMonths((ms) => [...new Set([...ms, monthToAdd])].sort())} disabled={!monthToAdd || filterMonths.includes(monthToAdd)} className="h-10 shrink-0 rounded-lg bg-[#7656b8] px-3 text-xs font-bold text-white hover:bg-[#6748a7] disabled:cursor-not-allowed disabled:opacity-50" data-testid="button-add-occupancy-month">Adicionar</button>
                    </div>
                    <div className="flex min-h-7 flex-wrap gap-1.5" data-testid="list-occupancy-selected-months">
                      {filterMonths.map((m) => (
                        <span key={m} className="inline-flex items-center gap-1 rounded-full bg-[#eee8f7] py-1 pl-2.5 pr-1 text-[10px] font-semibold capitalize text-[#5d4a78]" data-testid={`chip-occupancy-month-${m}`}>
                          {formatMonthKey(m)}
                          <button type="button" onClick={() => setFilterMonths((ms) => ms.filter((x) => x !== m))} aria-label={`Remover ${formatMonthKey(m)}`} className="grid h-5 w-5 place-items-center rounded-full text-[#7656b8] hover:bg-white" data-testid={`button-remove-occupancy-month-${m}`}><X size={11} /></button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {filterMode === 'range' && <p className="mt-2 text-[10px] leading-4 text-[#8a8491]">Consolidados mensais aparecem somente quando o mês inteiro está dentro do intervalo.</p>}
              </div>
            )}
            <div className="mt-3 flex items-center justify-between gap-2">
              {filterProblem ? <p className="text-xs font-semibold text-[#a24f45]" role="alert" data-testid="status-occupancy-filter">{filterProblem}</p> : <span />}
              <button type="button" onClick={clearFilters} className="h-8 rounded-lg px-3 text-xs font-semibold text-[#766d83] hover:bg-[#f6f3f8]" data-testid="button-clear-occupancy-filters">Limpar filtros</button>
            </div>
          </div>

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
                <p className="mt-1 text-xs leading-5 text-[#827b8b]">Ausência de registro não significa ocupação zero. Lance o percentual ao lado quando ele estiver disponível.</p>
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
  const createModality = useCreateOccupancyModality();
  const updateModality = useUpdateOccupancyModality();
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; version: number; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lock = useRef(false);
  const busy = createModality.isPending || updateModality.isPending;

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

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) { onOpenChange(o); if (!o) { setRenaming(null); setError(null); setNotice(null); } } }}>
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
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
