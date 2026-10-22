import { useMemo, useRef, useState, type ChangeEvent, type InputHTMLAttributes } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, CalendarDays, CircleHelp, ClipboardList, Download, Edit3, FileSpreadsheet, Filter, Plus, RefreshCw, Save, Trash2, Upload, X } from 'lucide-react';
import {
  getGetSalesGoalsQueryKey,
  getGetSalesQueryKey,
  useCreateSale,
  useDeleteSale,
  useGetSales,
  useGetSalesGoals,
  useRestoreMonthlySalesBackup,
  useUpdateSale,
} from '@workspace/api-client-react';
import type { MonthlySalesBackupInput, Sale, SaleInput, SalesRestoreResult } from '@workspace/api-client-react';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { createMonthlySalesBackup, downloadMonthlyBackup, parseMonthlySalesBackup } from '@/lib/sales-export';
import { formatCents, formatMonthKey, getSaoPauloMonthKey, normalizeProductName, productNameKey } from '@/lib/sales-utils';

const MAX_BACKUP_FILE_BYTES = 10 * 1024 * 1024;

const saleFormSchema = z.object({
  saleDate: z.string().refine(isValidCalendarDate, 'Informe uma data válida.'),
  productName: z.string().max(120, 'Use até 120 caracteres.').refine((value) => normalizeProductName(value).length > 0, 'Informe o produto.'),
  quantity: z.string().regex(/^[1-9]\d*$/, 'Use uma quantidade inteira maior que zero.').refine((value) => Number(value) <= 2147483647, 'Quantidade muito alta.'),
  unitAmount: z.string().min(1, 'Informe o valor unitário.').refine((value) => parseBrlCents(value) !== null, 'Informe um valor em reais válido.').refine((value) => (parseBrlCents(value) ?? -1) >= 0, 'O valor não pode ser negativo.').refine((value) => (parseBrlCents(value) ?? Number.MAX_SAFE_INTEGER + 1) <= Number.MAX_SAFE_INTEGER, 'Valor muito alto.'),
  notes: z.string().max(1000, 'Use até 1.000 caracteres.'),
}).superRefine((values, context) => {
  const totalCents = Number(values.quantity) * (parseBrlCents(values.unitAmount) ?? 0);
  if (!Number.isSafeInteger(totalCents)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['unitAmount'], message: 'O total ultrapassa o limite de cálculo seguro.' });
  }
});

type SaleFormValues = z.infer<typeof saleFormSchema>;

function todayLocal() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function isValidCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function parseBrlCents(value: string): number | null {
  const cleaned = value.trim().replace(/^R\$\s*/i, '').replace(/\s+/g, '');
  if (!cleaned || !/^[\d.,]+$/.test(cleaned)) return null;
  let normalized = cleaned;
  if (cleaned.includes(',')) normalized = cleaned.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(\.\d{0,2})?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

function formatDate(value: string, options: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' }) {
  return new Date(`${value}T12:00:00`).toLocaleDateString('pt-BR', options);
}

function errorMessage(error: unknown) {
  if (error && typeof error === 'object') {
    const apiError = error as { message?: unknown; data?: { error?: unknown } };
    if (typeof apiError.data?.error === 'string') return apiError.data.error;
    if (typeof apiError.message === 'string') return apiError.message;
  }
  return 'Não foi possível concluir. Tente novamente.';
}

function filterSalesForExport(sales: Sale[], fromDate: string, toDate: string, filterProduct: string) {
  return sales
    .filter((sale) => !fromDate || sale.saleDate >= fromDate)
    .filter((sale) => !toDate || sale.saleDate <= toDate)
    .filter((sale) => !filterProduct || productNameKey(sale.productName) === productNameKey(filterProduct))
    .slice()
    .sort((a, b) => b.saleDate.localeCompare(a.saleDate) || b.createdAt.localeCompare(a.createdAt));
}

function formatGeneratedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Sao_Paulo',
  }).format(date);
}

type RestorePreview = {
  backup: MonthlySalesBackupInput;
  knownExistingSales: number | null;
};

function Field({ label, name, type = 'text', placeholder, testId, ...props }: {
  label: string;
  name: 'saleDate' | 'productName' | 'quantity' | 'unitAmount' | 'notes';
  type?: string;
  placeholder?: string;
  testId: string;
} & InputHTMLAttributes<HTMLInputElement>) {
  return <FormField name={name} render={({ field }) => (
    <FormItem className="min-w-0 space-y-1.5">
      <FormLabel className="text-[11px] font-bold text-[#665f70]">{label}</FormLabel>
      <FormControl>
        <input {...field} {...props} type={type} placeholder={placeholder} data-testid={testId}
          className="h-11 w-full rounded-xl border border-[#e7e2ea] bg-[#fcfbfd] px-3.5 text-sm text-[#342d43] outline-none transition placeholder:text-[#aaa4b0] focus:border-[#9477bf] focus:bg-white focus:ring-2 focus:ring-[#7656b8]/10" />
      </FormControl>
      <FormMessage className="text-[11px]" />
    </FormItem>
  )} />;
}

export default function SalesManagement() {
  const queryClient = useQueryClient();
  const { data: sales, isLoading, isFetching, isError, refetch: refetchSales } = useGetSales({
    query: { queryKey: getGetSalesQueryKey(), refetchOnMount: 'always' },
  });
  const {
    data: salesGoals,
    isLoading: isGoalsLoading,
    isFetching: isGoalsFetching,
    isError: isGoalsError,
    refetch: refetchGoals,
  } = useGetSalesGoals({
    query: { queryKey: getGetSalesGoalsQueryKey(), refetchOnMount: 'always' },
  });
  const createSale = useCreateSale();
  const updateSale = useUpdateSale();
  const deleteSale = useDeleteSale();
  const restoreBackup = useRestoreMonthlySalesBackup();
  const [editing, setEditing] = useState<Sale | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<Sale | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [filterProduct, setFilterProduct] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [backupMonth, setBackupMonth] = useState(getSaoPauloMonthKey());
  const [backupDialogOpen, setBackupDialogOpen] = useState(false);
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isGeneratingBackup, setIsGeneratingBackup] = useState(false);
  const [exportFeedback, setExportFeedback] = useState('');
  const [exportError, setExportError] = useState('');
  const [backupError, setBackupError] = useState('');
  const [restoreError, setRestoreError] = useState('');
  const [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null);
  const [restoreResult, setRestoreResult] = useState<SalesRestoreResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const exportMenuRef = useRef<HTMLDetailsElement>(null);
  const busy = createSale.isPending || updateSale.isPending || deleteSale.isPending;
  const operationLock = useRef(false);

  const products = useMemo(() => {
    const byName = new Map<string, string>();
    for (const sale of sales ?? []) {
      const name = normalizeProductName(sale.productName);
      const key = productNameKey(name);
      if (name && !byName.has(key)) byName.set(key, name);
    }
    return [...byName.values()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }, [sales]);

  const filteredSales = useMemo(
    () => filterSalesForExport(sales ?? [], fromDate, toDate, filterProduct),
    [sales, fromDate, toDate, filterProduct],
  );
  const backupMonthSales = useMemo(
    () => (sales ?? []).filter((sale) => sale.saleDate.slice(0, 7) === backupMonth),
    [sales, backupMonth],
  );
  const backupMonthGoals = useMemo(
    () => (salesGoals ?? []).filter((goal) => goal.month === backupMonth),
    [salesGoals, backupMonth],
  );

  function closeExportMenu() {
    if (exportMenuRef.current) exportMenuRef.current.open = false;
  }

  async function exportSpreadsheet() {
    if (isExporting) return;
    closeExportMenu();
    setIsExporting(true);
    setExportError('');
    setExportFeedback('');
    try {
      const result = await refetchSales();
      if (result.isError || !result.data) throw new Error('Não foi possível atualizar os lançamentos antes da exportação.');
      const rows = filterSalesForExport(result.data, fromDate, toDate, filterProduct);
      const generatedDay = new Date().toISOString().slice(0, 10);
      const { downloadSalesWorkbook } = await import('@/lib/sales-workbook');
      downloadSalesWorkbook(rows, `zero3-pro-relatorio-vendas-${generatedDay}.xlsx`);
      setExportFeedback(`Planilha exportada com ${rows.length} ${rows.length === 1 ? 'lançamento' : 'lançamentos'} dos filtros selecionados.`);
    } catch (error) {
      setExportError(errorMessage(error));
    } finally {
      setIsExporting(false);
    }
  }

  function openMonthlyBackupDialog() {
    closeExportMenu();
    setBackupMonth(getSaoPauloMonthKey());
    setBackupError('');
    setExportError('');
    setExportFeedback('');
    setBackupDialogOpen(true);
    void Promise.all([refetchSales(), refetchGoals()]);
  }

  async function generateMonthlyBackup() {
    if (isGeneratingBackup) return;
    setIsGeneratingBackup(true);
    setBackupError('');
    try {
      const [salesResult, goalsResult] = await Promise.all([refetchSales(), refetchGoals()]);
      if (salesResult.isError || !salesResult.data) throw new Error('Não foi possível carregar os lançamentos para o backup.');
      if (goalsResult.isError || !goalsResult.data) throw new Error('Não foi possível carregar as metas. O backup não foi gerado para evitar uma cópia incompleta.');
      const backup = createMonthlySalesBackup(backupMonth, salesResult.data, goalsResult.data);
      downloadMonthlyBackup(backup);
      setBackupError('');
      setExportError('');
      setExportFeedback(`Backup de ${formatMonthKey(backupMonth)} gerado com ${backup.recordCount} ${backup.recordCount === 1 ? 'lançamento' : 'lançamentos'} e ${backup.goalCount} ${backup.goalCount === 1 ? 'meta' : 'metas'}.`);
    } catch (error) {
      setBackupError(errorMessage(error));
    } finally {
      setIsGeneratingBackup(false);
    }
  }

  async function handleBackupFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;

    closeExportMenu();
    setRestorePreview(null);
    setRestoreResult(null);
    setRestoreError('');
    setRestoreDialogOpen(true);
    if (file.size > MAX_BACKUP_FILE_BYTES) {
      setRestoreError('O arquivo ultrapassa o limite de 10 MB.');
      return;
    }

    try {
      const parsed = parseMonthlySalesBackup(JSON.parse(await file.text()));
      const salesResult = await refetchSales();
      const existingIds = salesResult.data ? new Set(salesResult.data.map((sale) => sale.id)) : null;
      const knownExistingSales = salesResult.isError || !salesResult.data
        ? null
        : parsed.sales.reduce((count, sale) => count + Number(existingIds?.has(sale.id) ?? false), 0);
      setRestorePreview({ backup: parsed, knownExistingSales });
    } catch (error) {
      setRestoreError(error instanceof SyntaxError
        ? 'O arquivo não contém um JSON válido.'
        : errorMessage(error));
    }
  }

  async function confirmBackupRestore() {
    if (!restorePreview || restoreBackup.isPending) return;
    setRestoreError('');
    try {
      const result = await restoreBackup.mutateAsync({ data: restorePreview.backup });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetSalesQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetSalesGoalsQueryKey() }),
      ]);
      setRestoreResult(result);
    } catch (error) {
      setRestoreError(errorMessage(error));
    }
  }

  const form = useForm<SaleFormValues>({
    resolver: zodResolver(saleFormSchema),
    defaultValues: { saleDate: todayLocal(), productName: '', quantity: '1', unitAmount: '', notes: '' },
  });
  const quantityInput = form.watch('quantity') || '';
  const quantity = /^\d+$/.test(quantityInput) ? BigInt(quantityInput) : 0n;
  const unitCents = parseBrlCents(form.watch('unitAmount') || '') ?? 0;
  const total = quantity * BigInt(unitCents);

  function resetForm() {
    setEditing(null);
    form.reset({ saleDate: todayLocal(), productName: '', quantity: '1', unitAmount: '', notes: '' });
  }

  function startEditing(sale: Sale) {
    setFeedback(null);
    setEditing(sale);
    form.reset({
      saleDate: sale.saleDate,
      productName: sale.productName,
      quantity: String(sale.quantity),
      unitAmount: `${Math.floor(sale.unitAmountCents / 100)},${String(sale.unitAmountCents % 100).padStart(2, '0')}`,
      notes: sale.notes ?? '',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function submit(values: SaleFormValues) {
    if (busy || operationLock.current) return;
    operationLock.current = true;
    setFeedback(null);
    const cleanedName = normalizeProductName(values.productName);
    const canonical = products.find((product) => productNameKey(product) === productNameKey(cleanedName));
    const input: SaleInput = {
      saleDate: values.saleDate,
      productName: canonical ?? cleanedName,
      quantity: Number(values.quantity),
      unitAmountCents: parseBrlCents(values.unitAmount) ?? 0,
      notes: values.notes.trim().replace(/\s+/g, ' ') || null,
    };
    try {
      if (editing) {
        await updateSale.mutateAsync({ id: editing.id, data: input });
        setFeedback({ type: 'success', message: 'Lançamento atualizado.' });
      } else {
        await createSale.mutateAsync({ data: input });
        setFeedback({ type: 'success', message: 'Venda registrada com sucesso.' });
      }
      await queryClient.invalidateQueries({ queryKey: getGetSalesQueryKey() });
      resetForm();
    } catch (error) {
      setFeedback({ type: 'error', message: errorMessage(error) });
    } finally {
      operationLock.current = false;
    }
  }

  async function confirmDelete() {
    if (!confirmingDelete || busy || operationLock.current) return;
    operationLock.current = true;
    const target = confirmingDelete;
    setFeedback(null);
    try {
      await deleteSale.mutateAsync({ id: target.id });
      await queryClient.invalidateQueries({ queryKey: getGetSalesQueryKey() });
      setConfirmingDelete(null);
      if (editing?.id === target.id) resetForm();
      setFeedback({ type: 'success', message: 'Lançamento excluído.' });
    } catch (error) {
      setConfirmingDelete(null);
      setFeedback({ type: 'error', message: errorMessage(error) });
    } finally {
      operationLock.current = false;
    }
  }

  return (
    <>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between" data-testid="sales-export-controls">
        <div className="text-[10px] leading-4 text-[#8a8491]">Exporte os filtros atuais ou gere uma cópia mensal para recuperação.</div>
        <details ref={exportMenuRef} className="relative self-start sm:self-auto">
          <summary
            className="flex h-10 cursor-pointer list-none items-center gap-2 rounded-xl border border-[#ded7e7] bg-white px-3.5 text-xs font-bold text-[#5d4a78] transition hover:bg-[#f7f4fa] [&::-webkit-details-marker]:hidden"
            data-testid="button-export-menu"
          >
            <Download size={15} /> Exportar
          </summary>
          <div className="absolute right-0 z-20 mt-2 min-w-[230px] rounded-2xl border border-[#e7e1e9] bg-white p-1.5 shadow-[0_12px_35px_rgba(40,32,56,.15)]">
            <button type="button" onClick={() => void exportSpreadsheet()} disabled={isExporting} className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs font-semibold text-[#4d4559] transition hover:bg-[#f8f6fa] disabled:opacity-50" data-testid="button-export-spreadsheet">
              <FileSpreadsheet size={15} className="text-[#6d9b45]" />
              <span>Planilha do período (.xlsx)</span>
            </button>
            <button type="button" onClick={openMonthlyBackupDialog} className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs font-semibold text-[#4d4559] transition hover:bg-[#f8f6fa]" data-testid="button-open-monthly-backup">
              <Download size={15} className="text-[#7656b8]" />
              <span>Backup mensal (.json)</span>
            </button>
            <button type="button" onClick={() => { closeExportMenu(); fileInputRef.current?.click(); }} className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs font-semibold text-[#4d4559] transition hover:bg-[#f8f6fa]" data-testid="button-open-backup-restore">
              <ArchiveRestore size={15} className="text-[#7656b8]" />
              <span>Restaurar backup</span>
            </button>
          </div>
        </details>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          onChange={(event) => void handleBackupFileChange(event)}
          className="sr-only"
          aria-label="Selecionar arquivo de backup JSON"
          data-testid="input-restore-backup-file"
        />
      </div>
      {(exportFeedback || exportError) && <div role={exportError ? 'alert' : 'status'} className={`rounded-xl px-3.5 py-2.5 text-xs font-semibold ${exportError ? 'bg-[#fff0ed] text-[#9c483f]' : 'bg-[#eff6e5] text-[#55772c]'}`} data-testid={exportError ? 'status-export-error' : 'status-export-success'}>{exportError || exportFeedback}</div>}

      <section className="grid items-start gap-5 xl:grid-cols-[minmax(350px,.83fr)_minmax(0,1.17fr)]">
        <div className="rounded-[24px] border border-[#e9e4ec] bg-white p-5 shadow-[0_7px_28px_rgba(47,38,63,.035)] md:p-6">
          <div className="mb-5 flex items-start justify-between gap-3">
            <div><p className="eyebrow text-[9px] font-bold text-[#8b8494]">{editing ? 'ajustar registro' : 'novo registro'}</p><h2 className="mt-1 text-lg font-bold tracking-[-.035em]">{editing ? 'Editar lançamento' : 'Lançar uma venda'}</h2></div>
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[14px] bg-[#eff6e5] text-[#769f3e]"><Plus size={18} /></span>
          </div>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(submit)} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Field name="saleDate" label="Data da venda" type="date" testId="input-sale-date" />
                <div className="col-span-2">
                  <Field name="productName" label="Plano ou produto" placeholder="Ex.: Plano Essencial" testId="input-sale-product" list="sale-product-suggestions" autoComplete="off" />
                  <datalist id="sale-product-suggestions">{products.map((product) => <option key={product} value={product} />)}</datalist>
                </div>
                <Field name="quantity" label="Quantidade" type="number" min="1" step="1" inputMode="numeric" placeholder="1" testId="input-sale-quantity" />
                <Field name="unitAmount" label="Valor unitário" type="text" inputMode="decimal" placeholder="0,00" testId="input-sale-unit-amount" />
              </div>
              <div className="rounded-[16px] border border-[#e9e3ef] bg-[#f8f6fa] px-4 py-3.5">
                <div className="flex items-center justify-between gap-3"><span className="text-[11px] font-bold uppercase tracking-[.1em] text-[#81798b]">Total da venda</span><span className="font-[family-name:var(--app-font-serif)] text-[25px] font-extrabold tracking-[-.05em] text-[#423354]" data-testid="text-sale-total">{formatCents(total)}</span></div>
                <p className="mt-1 text-[10px] text-[#938c9b]">Quantidade × valor unitário</p>
              </div>
              <FormField name="notes" render={({ field }) => (
                <FormItem className="space-y-1.5">
                  <FormLabel className="text-[11px] font-bold text-[#665f70]">Observações <span className="font-medium text-[#9e98a5]">· opcional</span></FormLabel>
                  <FormControl><textarea {...field} rows={3} maxLength={1000} placeholder="Detalhes que ajudam a equipe..." data-testid="input-sale-notes" className="w-full resize-y rounded-xl border border-[#e7e2ea] bg-[#fcfbfd] px-3.5 py-3 text-sm text-[#342d43] outline-none transition placeholder:text-[#aaa4b0] focus:border-[#9477bf] focus:bg-white focus:ring-2 focus:ring-[#7656b8]/10" /></FormControl>
                  <FormMessage className="text-[11px]" />
                </FormItem>
              )} />
              {feedback && <div role="status" data-testid={`status-sale-${feedback.type}`} className={`rounded-xl px-3.5 py-2.5 text-xs font-semibold ${feedback.type === 'success' ? 'bg-[#eff6e5] text-[#55772c]' : 'bg-[#fff0ed] text-[#9c483f]'}`}>{feedback.message}</div>}
              <div className="flex gap-2">
                {editing && <button type="button" onClick={resetForm} disabled={busy} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[#e3dfe7] px-4 text-sm font-bold text-[#716a79] transition hover:bg-[#f8f6fa] disabled:opacity-50" data-testid="button-cancel-edit"><X size={15} /> Cancelar</button>}
                <button type="submit" disabled={busy} className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[#7656b8] px-4 text-sm font-bold text-white shadow-[0_7px_16px_rgba(91,62,145,.14)] transition hover:bg-[#6848a9] disabled:cursor-wait disabled:opacity-65" data-testid="button-sale-submit">
                  {busy ? <span className="h-4 w-4 animate-pulse rounded-full border-2 border-white/40 border-t-white" /> : editing ? <Save size={16} /> : <Plus size={16} />}
                  {busy ? 'Salvando…' : editing ? 'Salvar alterações' : 'Registrar venda'}
                </button>
              </div>
            </form>
          </Form>
        </div>

        <div className="min-w-0 rounded-[24px] border border-[#e9e4ec] bg-white p-5 shadow-[0_7px_28px_rgba(47,38,63,.035)] md:p-6">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div><p className="eyebrow text-[9px] font-bold text-[#8b8494]">histórico</p><h2 className="mt-1 text-lg font-bold tracking-[-.035em]">Vendas recentes</h2></div>
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#f1edf7] text-[#7656b8]"><ClipboardList size={17} /></span>
          </div>
          <div className="mb-4 rounded-[17px] bg-[#f8f7f9] p-3.5">
            <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[.1em] text-[#81798b]"><Filter size={12} /> Filtrar lançamentos</div>
            <div className="grid grid-cols-2 gap-2.5">
              <label className="min-w-0 text-[10px] font-semibold text-[#817b89]">De
                <input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} data-testid="filter-sale-from" className="mt-1 h-10 w-full min-w-0 rounded-lg border border-[#e7e2ea] bg-white px-2.5 text-xs text-[#443d50] outline-none focus:border-[#9477bf]" />
              </label>
              <label className="min-w-0 text-[10px] font-semibold text-[#817b89]">Até
                <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} data-testid="filter-sale-to" className="mt-1 h-10 w-full min-w-0 rounded-lg border border-[#e7e2ea] bg-white px-2.5 text-xs text-[#443d50] outline-none focus:border-[#9477bf]" />
              </label>
              <label className="col-span-2 min-w-0 text-[10px] font-semibold text-[#817b89]">Plano ou produto
                <select value={filterProduct} onChange={(event) => setFilterProduct(event.target.value)} data-testid="filter-sale-product" className="mt-1 h-10 w-full rounded-lg border border-[#e7e2ea] bg-white px-2.5 text-xs text-[#443d50] outline-none focus:border-[#9477bf]">
                  <option value="">Todos os produtos</option>
                  {products.map((product) => <option key={product} value={product}>{product}</option>)}
                </select>
              </label>
            </div>
          </div>
          {isLoading ? <div className="space-y-3" aria-label="Carregando vendas" data-testid="status-sales-loading"><div className="skeleton h-16 rounded-2xl" /><div className="skeleton h-16 rounded-2xl" /><div className="skeleton h-16 rounded-2xl" /></div>
            : isError ? <div className="grid min-h-[220px] place-items-center rounded-2xl border border-dashed border-[#e6e1ea] bg-[#fbfafc] p-6 text-center" data-testid="status-sales-error"><div><CircleHelp className="mx-auto text-[#a6584b]" size={23} /><p className="mt-3 font-bold">Não foi possível carregar</p><p className="mt-1 text-sm text-[#827b8b]">Confira sua conexão e tente novamente.</p><button onClick={() => void refetchSales()} className="mt-4 inline-flex items-center gap-2 rounded-full border border-[#ded8e5] bg-white px-4 py-2 text-xs font-bold text-[#5c506f] hover:bg-[#f8f6fa]" data-testid="button-retry-sales"><RefreshCw size={13} /> Tentar novamente</button></div></div>
            : filteredSales.length ? <div className="space-y-2" data-testid="list-sales">
              {filteredSales.map((sale) => <SaleRow key={sale.id} sale={sale} onEdit={() => startEditing(sale)} onDelete={() => setConfirmingDelete(sale)} busy={busy} />)}
              <p className="px-1 pt-2 text-[10px] font-medium text-[#938c99]" data-testid="text-sales-count">{filteredSales.length} {filteredSales.length === 1 ? 'lançamento' : 'lançamentos'} exibidos</p>
            </div> : <div className="grid min-h-[220px] place-items-center rounded-2xl border border-dashed border-[#e6e1ea] bg-[#fbfafc] p-6 text-center" data-testid="status-sales-empty"><div><div className="mx-auto grid h-12 w-12 place-items-center rounded-[17px] bg-[#f0ebf7] text-[#7656b8]"><ClipboardList size={21} /></div><h3 className="mt-4 font-bold tracking-[-.02em]">{(sales?.length ?? 0) ? 'Nenhuma venda neste filtro' : 'Seu histórico começa aqui'}</h3><p className="mx-auto mt-1.5 max-w-[270px] text-xs leading-5 text-[#85808e]">{(sales?.length ?? 0) ? 'Ajuste as datas ou escolha outro produto para ver resultados.' : 'Registre a primeira venda para acompanhar tudo por aqui.'}</p></div></div>}
        </div>
      </section>
      <div className="mt-5 flex items-center gap-3 rounded-2xl border border-[#e7e3e8] bg-[#f1eef3] px-4 py-3.5 text-xs text-[#746d7b]">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-white text-[#7656b8]"><CalendarDays size={15} /></span>
        <span>Registros compartilhados com a equipe autorizada.</span><span className="ml-auto hidden text-[10px] font-semibold text-[#9993a0] md:block">DADOS ATUALIZADOS</span>
      </div>
      <Dialog open={backupDialogOpen} onOpenChange={(open) => { if (!isGeneratingBackup) setBackupDialogOpen(open); }}>
        <DialogContent className="max-w-lg border-[#e7e1e9] bg-[#fffefc] p-6 sm:rounded-[24px]">
          <DialogHeader className="text-left">
            <DialogTitle className="text-lg font-extrabold tracking-[-.035em] text-[#332d40]">Backup mensal</DialogTitle>
            <DialogDescription className="text-xs leading-5 text-[#827b8b]">
              Inclui todos os lançamentos do mês selecionado, sem aplicar o filtro de plano, e as metas cadastradas para esse mês.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Mês do backup
              <input type="month" value={backupMonth} onChange={(event) => setBackupMonth(event.target.value)} data-testid="input-monthly-backup-month" className="mt-1.5 h-11 w-full rounded-xl border border-[#e7e2ea] bg-[#fcfbfd] px-3.5 text-sm font-medium normal-case tracking-normal text-[#342d43] outline-none focus:border-[#9477bf]" />
            </label>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-xl bg-[#f8f6f9] px-3.5 py-3">
                <p className="text-[9px] font-bold uppercase tracking-[.1em] text-[#817b89]">Lançamentos</p>
                <p className="mt-1 text-sm font-extrabold tabular-nums text-[#40374e]" data-testid="text-monthly-backup-sales-count">{backupMonthSales.length}</p>
                <p className="mt-1 text-[10px] text-[#8a8491]">Independente do filtro de plano.</p>
              </div>
              <div className="rounded-xl bg-[#f8f6f9] px-3.5 py-3">
                <p className="text-[9px] font-bold uppercase tracking-[.1em] text-[#817b89]">Metas mensais</p>
                <p className="mt-1 text-sm font-extrabold tabular-nums text-[#40374e]" data-testid="text-monthly-backup-goals-count">{backupMonthGoals.length}</p>
              </div>
            </div>
            {(isLoading || isFetching || isGoalsLoading || isGoalsFetching) && <p className="text-[11px] text-[#827b8b]" role="status">Atualizando a base para gerar uma cópia recente…</p>}
            {!isLoading && !isFetching && !isError && backupMonthSales.length === 0 && <p className="rounded-xl border border-dashed border-[#ded7e7] px-3.5 py-3 text-xs leading-5 text-[#716a79]" data-testid="status-monthly-backup-empty">Nenhum lançamento neste mês. O arquivo terá zero vendas; nenhuma linha fictícia será criada.</p>}
            {(isError || isGoalsError) && <div className="rounded-xl bg-[#fff5f2] px-3.5 py-3 text-xs text-[#85554e]" role="alert" data-testid="status-monthly-backup-load-error"><p>Não foi possível ler todos os dados para gerar o backup.</p><button type="button" onClick={() => void Promise.all([refetchSales(), refetchGoals()])} className="mt-2 inline-flex items-center gap-1.5 font-bold underline underline-offset-2"><RefreshCw size={12} /> Tentar novamente</button></div>}
            {backupError && <p className="rounded-xl bg-[#fff0ed] px-3.5 py-2.5 text-xs font-semibold text-[#9c483f]" role="alert" data-testid="status-monthly-backup-error">{backupError}</p>}
          </div>
          <DialogFooter className="gap-2">
            <button type="button" onClick={() => setBackupDialogOpen(false)} disabled={isGeneratingBackup} className="h-10 rounded-xl border border-[#e3dfe7] px-4 text-sm font-bold text-[#716a79] transition hover:bg-[#f8f6fa] disabled:opacity-50" data-testid="button-cancel-monthly-backup">Fechar</button>
            <button type="button" onClick={() => void generateMonthlyBackup()} disabled={isGeneratingBackup || isLoading || isFetching || isGoalsLoading || isGoalsFetching || isError || isGoalsError} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#7656b8] px-4 text-sm font-bold text-white transition hover:bg-[#6848a9] disabled:cursor-wait disabled:opacity-60" data-testid="button-generate-monthly-backup">
              {isGeneratingBackup ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Download size={14} />}
              {isGeneratingBackup ? 'Gerando…' : 'Baixar backup JSON'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={restoreDialogOpen}
        onOpenChange={(open) => {
          if (!restoreBackup.isPending) setRestoreDialogOpen(open);
        }}
      >
        <DialogContent className="max-w-lg border-[#e7e1e9] bg-[#fffefc] p-6 sm:rounded-[24px]">
          <DialogHeader className="text-left">
            <DialogTitle className="text-lg font-extrabold tracking-[-.035em] text-[#332d40]">Restaurar backup mensal</DialogTitle>
            <DialogDescription className="text-xs leading-5 text-[#827b8b]">
              Confira o conteúdo antes de confirmar. Lançamentos com o mesmo ID serão ignorados; registros atuais não serão removidos.
            </DialogDescription>
          </DialogHeader>
          {restoreError && <p className="rounded-xl bg-[#fff0ed] px-3.5 py-2.5 text-xs font-semibold text-[#9c483f]" role="alert" data-testid="status-backup-restore-error">{restoreError}</p>}
          {restorePreview && !restoreResult && (
            <div className="space-y-3">
              <div className="rounded-xl bg-[#f8f6f9] px-3.5 py-3.5" data-testid="panel-backup-restore-preview">
                <p className="text-sm font-extrabold capitalize text-[#40374e]">{formatMonthKey(restorePreview.backup.month)}</p>
                <p className="mt-1 text-[10px] text-[#827b8b]">Gerado em {formatGeneratedAt(restorePreview.backup.generatedAt)}</p>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold text-[#625a6d]">
                  <span data-testid="text-restore-preview-sales">{restorePreview.backup.recordCount} lançamentos</span>
                  <span data-testid="text-restore-preview-goals">{restorePreview.backup.goalCount} metas</span>
                </div>
                <p className="mt-2 text-[10px] leading-4 text-[#827b8b]">
                  {restorePreview.knownExistingSales === null
                    ? 'Não foi possível estimar quantos IDs já existem; o servidor ainda evitará duplicações ao restaurar.'
                    : `${restorePreview.knownExistingSales} lançamento(s) já presente(s) serão ignorados.`}
                </p>
              </div>
              {restorePreview.backup.sales.length === 0
                ? <p className="rounded-xl border border-dashed border-[#ded7e7] px-3.5 py-3 text-xs text-[#716a79]" data-testid="status-restore-preview-empty">Este backup não contém lançamentos.</p>
                : <ul className="max-h-36 space-y-1.5 overflow-y-auto rounded-xl border border-[#eeeaf0] p-3 text-[11px] text-[#625a6d]" aria-label="Prévia dos lançamentos">
                  {restorePreview.backup.sales.slice(0, 5).map((sale) => <li key={sale.id} className="flex justify-between gap-3"><span className="min-w-0 truncate">{formatDate(sale.saleDate)} · {sale.productName}</span><span className="shrink-0 font-semibold tabular-nums">{formatCents(sale.totalCents)}</span></li>)}
                  {restorePreview.backup.sales.length > 5 && <li className="pt-1 text-[#8a8491]">e mais {restorePreview.backup.sales.length - 5} lançamentos…</li>}
                </ul>}
              <p className="rounded-xl border border-[#e9e0c8] bg-[#fcf8ed] px-3.5 py-3 text-[10px] leading-5 text-[#725d2d]">
                Ao confirmar, os lançamentos ausentes serão adicionados pelos IDs internos e as metas deste mês serão restauradas ou atualizadas. Nenhum registro fora do mês será alterado.
              </p>
            </div>
          )}
          {restoreResult && <div className="rounded-xl bg-[#eff6e5] px-3.5 py-3 text-xs leading-5 text-[#55772c]" role="status" data-testid="status-backup-restore-success">
            Backup de {formatMonthKey(restoreResult.month)} processado: {restoreResult.insertedSales} novos lançamentos, {restoreResult.skippedSales} já existentes ignorados e {restoreResult.restoredGoals} metas restauradas/atualizadas.
          </div>}
          <DialogFooter className="gap-2">
            <button type="button" onClick={() => setRestoreDialogOpen(false)} disabled={restoreBackup.isPending} className="h-10 rounded-xl border border-[#e3dfe7] px-4 text-sm font-bold text-[#716a79] transition hover:bg-[#f8f6fa] disabled:opacity-50" data-testid="button-cancel-backup-restore">{restoreResult ? 'Concluir' : 'Cancelar'}</button>
            {!restoreResult && <button type="button" onClick={() => void confirmBackupRestore()} disabled={!restorePreview || restoreBackup.isPending} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#7656b8] px-4 text-sm font-bold text-white transition hover:bg-[#6848a9] disabled:cursor-wait disabled:opacity-60" data-testid="button-confirm-backup-restore">
              {restoreBackup.isPending && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
              {restoreBackup.isPending ? 'Restaurando…' : 'Confirmar restauração'}
            </button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {confirmingDelete && <div className="fixed inset-0 z-50 grid place-items-center bg-[#282238]/45 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setConfirmingDelete(null); }}>
        <section role="alertdialog" aria-modal="true" aria-labelledby="delete-title" className="w-full max-w-md rounded-[24px] border border-[#e9e4ec] bg-[#fffefc] p-6 shadow-[0_24px_80px_rgba(40,32,56,.24)]" data-testid="dialog-confirm-delete">
          <div className="grid h-11 w-11 place-items-center rounded-2xl bg-[#fff0ed] text-[#a94e43]"><Trash2 size={18} /></div>
          <h2 id="delete-title" className="mt-4 text-lg font-bold tracking-[-.03em] text-[#302842]">Excluir este lançamento?</h2>
          <p className="mt-2 text-sm leading-6 text-[#797281]">A venda de <strong className="text-[#4b4356]">{confirmingDelete.productName}</strong>, registrada em {formatDate(confirmingDelete.saleDate)}, será removida do histórico.</p>
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" onClick={() => setConfirmingDelete(null)} disabled={busy} className="h-10 rounded-xl border border-[#e3dfe7] px-4 text-sm font-bold text-[#716a79] hover:bg-[#f8f6fa] disabled:opacity-50" data-testid="button-cancel-delete">Manter venda</button>
            <button type="button" onClick={() => void confirmDelete()} disabled={busy} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#a84940] px-4 text-sm font-bold text-white hover:bg-[#963c35] disabled:opacity-60" data-testid="button-confirm-delete">{busy ? 'Excluindo…' : <><Trash2 size={14} /> Excluir lançamento</>}</button>
          </div>
        </section>
      </div>}
    </>
  );
}

function SaleRow({ sale, onEdit, onDelete, busy }: { sale: Sale; onEdit: () => void; onDelete: () => void; busy: boolean }) {
  return <article className="group flex min-w-0 items-center gap-3 rounded-2xl border border-[#f0edf2] px-3 py-3 transition hover:border-[#e5dfeb] hover:bg-[#fdfcfe]" data-testid={`row-sale-${sale.id}`}>
    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#f0ebf7] text-[#7656b8]"><CalendarDays size={16} /></div>
    <div className="min-w-0 flex-1">
      <p className="truncate text-sm font-bold text-[#353044]" data-testid={`text-sale-product-${sale.id}`}>{sale.productName}</p>
      <p className="mt-1 truncate text-[11px] text-[#8d8794]">{formatDate(sale.saleDate, { day: '2-digit', month: 'short' })}<span className="mx-1">·</span>{sale.quantity} un.<span className="mx-1">·</span>{formatCents(sale.unitAmountCents)} / un.</p>
      {sale.notes && <p className="mt-1 truncate text-[10px] text-[#81798b]" title={sale.notes}>{sale.notes}</p>}
    </div>
    <div className="shrink-0 text-right"><span className="whitespace-nowrap text-sm font-bold tracking-[-.02em] text-[#403650]" data-testid={`text-sale-total-${sale.id}`}>{formatCents(sale.totalCents)}</span></div>
    <div className="flex shrink-0 items-center gap-1 sm:pl-1">
      <button type="button" onClick={onEdit} disabled={busy} aria-label={`Editar venda de ${sale.productName}`} className="grid h-9 w-9 place-items-center rounded-lg text-[#81798b] transition hover:bg-[#f0ebf7] hover:text-[#6848a9] disabled:opacity-40" data-testid={`button-edit-sale-${sale.id}`}><Edit3 size={15} /></button>
      <button type="button" onClick={onDelete} disabled={busy} aria-label={`Excluir venda de ${sale.productName}`} className="grid h-9 w-9 place-items-center rounded-lg text-[#9a8585] transition hover:bg-[#fff0ed] hover:text-[#a84940] disabled:opacity-40" data-testid={`button-delete-sale-${sale.id}`}><Trash2 size={15} /></button>
    </div>
  </article>;
}
