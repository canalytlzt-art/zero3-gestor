import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type InputHTMLAttributes } from 'react';
import { useUser } from '@clerk/react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, CalendarDays, Check, ChevronDown, CircleHelp, ClipboardList, Download, Edit3, FileSpreadsheet, Filter, History, PackagePlus, Plus, Power, RefreshCw, RotateCcw, Save, Search, Upload, UsersRound, X } from 'lucide-react';
import {
  getGetProductsQueryKey,
  getGetOccupancyModalitiesQueryKey,
  getGetSaleHistoryQueryKey,
  getGetSalesHistoryQueryKey,
  getGetSalesGoalsQueryKey,
  getGetSalesPendingDraftsQueryKey,
  getGetSalesQueryKey,
  getGetSalesRefundCandidatesQueryKey,
  getGetSalesRefundsQueryKey,
  getGetSalesScoreboardQueryKey,
  createSalesPeriodBackup,
  getSalesImportOrigins,
  previewMonthlySalesBackupRestore,
  useCancelSale,
  useCreateProduct,
  useCreateSalesRefund,
  useCreateSale,
  useGetProducts,
  useGetOccupancyModalities,
  useGetSaleHistory,
  useGetSales,
  useGetSalesHistory,
  useGetSalesGoals,
  useGetSalesPendingDrafts,
  useGetSalesRefundCandidates,
  useGetSalesRefunds,
  useImportSales,
  useRestoreMonthlySalesBackup,
  useUpdateProduct,
  useUpdateSalesPendingDraft,
  useUpdateSale,
} from '@workspace/api-client-react';
import type { CreateProductInput, MonthlySalesBackupInput, Product, Sale, SaleInput, SalesPendingDraft, SalesPeriodBackup, SalesPeriodBackupSelection, SalesRefundRecord, SalesRestorePreview, SalesRestoreResult, UpdateProductInput, UpdateSalesPendingDraftInput, UpdateSalesPendingDraftResult } from '@workspace/api-client-react';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { PurpleSelect } from '@/components/ui/purple-select';
import { SuggestionInput } from '@/components/ui/suggestion-input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { downloadSalesPeriodBackup, parseMonthlySalesBackup } from '@/lib/sales-export';
import { countSalesPendingDrafts, countSalesWithVerificationIssues, downloadSalesCsv, downloadSalesWorkbook, getSaleVerificationIssues, summarizeSalesReport, type ExportFilters, type SalesExportSelection } from '@/lib/sales-workbook';
import { formatCents, formatMonthKey, getSaoPauloMonthKey, monthsForYearQuarter, normalizeProductName, productNameKey, type ScoreboardPeriodMode } from '@/lib/sales-utils';
import { getIsoWeekday, getWeekdayName, getWeekdayNameForIsoDay } from '@/lib/occupancy-calendar';
import { mapSalesImportRow, parseImportDate, parseSalesSpreadsheet, type SalesImportField, type SalesImportSheet } from '@/lib/sales-import';
import { findPossibleSaleDuplicates, findSalesImportDuplicateNotices, saleDuplicateFieldLabels } from '@/lib/sales-duplicates';
import type { SaleDuplicateField } from '@/lib/sales-duplicates';
import { ImportSourceDetails } from './import-source-details';
import ActiveContractsDialog from './active-contracts-dialog';

const MAX_BACKUP_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMPORT_ROWS = 500;

const saleFormSchema = z.object({
  saleDate: z.string().refine(isValidCalendarDate, 'Informe uma data válida.'),
  productName: z.string().max(120, 'Use até 120 caracteres.').refine((value) => normalizeProductName(value).length > 0, 'Informe o produto.'),
  modalityId: z.string(),
  quantity: z.string().regex(/^[1-9]\d*$/, 'Use uma quantidade inteira maior que zero.').refine((value) => Number(value) <= 2147483647, 'Quantidade muito alta.'),
  unitAmount: z.string().min(1, 'Informe o valor unitário.').refine((value) => parseBrlCents(value) !== null, 'Informe um valor em reais válido.').refine((value) => (parseBrlCents(value) ?? -1) >= 0, 'O valor não pode ser negativo.').refine((value) => (parseBrlCents(value) ?? Number.MAX_SAFE_INTEGER + 1) <= Number.MAX_SAFE_INTEGER, 'Valor muito alto.'),
  customerName: z.string().max(120, 'Use até 120 caracteres.'),
  notes: z.string().max(1000, 'Use até 1.000 caracteres.'),
}).superRefine((values, context) => {
  const totalCents = Number(values.quantity) * (parseBrlCents(values.unitAmount) ?? 0);
  if (!Number.isSafeInteger(totalCents)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['unitAmount'], message: 'O total ultrapassa o limite de cálculo seguro.' });
  }
});

type SaleFormValues = z.infer<typeof saleFormSchema>;

const productFormSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome do produto.').max(120, 'Use até 120 caracteres.'),
  suggestedPrice: z.string().min(1, 'Informe o preço sugerido.').refine((value) => parseBrlCents(value) !== null, 'Informe um valor em reais válido.'),
  modalityId: z.string(),
  isActive: z.boolean(),
});
type ProductFormValues = z.infer<typeof productFormSchema>;

type ImportWorkspace = {
  filename: string;
  fileHash: string;
  sheets: SalesImportSheet[];
  importedKeys: string[];
};

function todayLocal() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const part = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${part.year}-${part.month}-${part.day}`;
}

function isValidCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function parseBrlCents(value: string): number | null {
  const cleaned = value.trim().replace(/^R\$\s*/i, '').replace(/\s+/g, '');
  if (!cleaned || !/^\d[\d.,]*$/.test(cleaned)) return null;
  let normalized = cleaned;
  if (cleaned.includes(',') && cleaned.includes('.')) {
    if (!/^\d{1,3}(\.\d{3})*,\d{1,2}$/.test(cleaned)) return null;
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (cleaned.includes(',')) {
    if (!/^\d+,\d{1,2}$/.test(cleaned)) return null;
    normalized = cleaned.replace(',', '.');
  } else if (cleaned.includes('.')) {
    if (!/^\d+\.\d{1,2}$/.test(cleaned)) return null;
  }
  if (!/^\d+(\.\d{0,2})?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

function formatDate(value: string, options: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' }) {
  const calendarDate = value.slice(0, 10);
  return new Date(`${calendarDate}T12:00:00`).toLocaleDateString('pt-BR', options);
}

function formatCentsInput(value: number) {
  return `${Math.floor(value / 100)},${String(value % 100).padStart(2, '0')}`;
}

function errorMessage(error: unknown) {
  if (error && typeof error === 'object') {
    const apiError = error as { message?: unknown; data?: { error?: unknown } };
    if (typeof apiError.data?.error === 'string') return apiError.data.error;
    if (typeof apiError.message === 'string') return apiError.message;
  }
  return 'Não foi possível concluir. Tente novamente.';
}

function conflictAwareMessage(error: unknown, context: 'venda' | 'produto') {
  const apiError = error && typeof error === 'object' ? error as { status?: unknown } : null;
  if (apiError?.status === 409) {
    return context === 'venda'
      ? 'Esta venda foi alterada desde que você a abriu. Atualize o histórico e tente novamente.'
      : 'O catálogo mudou ou já existe um produto com esse nome. Atualize a lista e confira o cadastro antes de tentar novamente.';
  }
  return errorMessage(error);
}

function filterSalesForExport(sales: Sale[], fromDate: string, toDate: string, filterProduct: string, products: Product[] = []) {
  const productIds = new Set([
    ...products.filter(({ name }) => productNameKey(name) === productNameKey(filterProduct)).map(({ id }) => id),
    ...sales.filter(({ productName }) => productNameKey(productName) === productNameKey(filterProduct)).map(({ productId }) => productId),
  ]);
  return sales
    .filter((sale) => !fromDate || sale.saleDate >= fromDate)
    .filter((sale) => !toDate || sale.saleDate <= toDate)
    .filter((sale) => !filterProduct || productIds.has(sale.productId))
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

function toWorkbookSelection(selection: SalesPeriodBackupSelection): SalesExportSelection {
  if (selection.mode === 'all') return { mode: 'all' };
  if (selection.mode === 'range') {
    return { mode: 'range', fromDate: selection.fromDate ?? '', toDate: selection.toDate ?? '' };
  }
  return { mode: 'months', months: selection.months ?? [] };
}

function formatBackupPeriod(value: string) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? formatMonthKey(value) : value;
}

type RestorePreview = {
  backup: MonthlySalesBackupInput;
  report: SalesRestorePreview;
  sales: Array<{ id: string; saleDate: string; productName: string; totalCents: number; scope: string }>;
  salesCents: bigint;
  refundsCents: bigint;
};

function Field({ label, name, type = 'text', placeholder, testId, onValueChange, suggestions, suggestionTitle, ...props }: {
  label: string;
  name: 'saleDate' | 'productName' | 'quantity' | 'unitAmount' | 'customerName' | 'notes';
  type?: string;
  placeholder?: string;
  testId: string;
  onValueChange?: (value: string) => void;
  suggestions?: string[];
  suggestionTitle?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'>) {
  return <FormField name={name} render={({ field }) => (
    <FormItem className="min-w-0 space-y-1.5">
      <FormLabel className="text-[11px] font-bold text-[#665f70]">{label}</FormLabel>
      <FormControl>
        {suggestions ? (
          <SuggestionInput
            {...props}
            value={field.value}
            onValueChange={(value) => { field.onChange(value); onValueChange?.(value); }}
            suggestions={suggestions}
            suggestionTitle={suggestionTitle ?? 'Opções cadastradas'}
            type={type}
            placeholder={placeholder}
            testId={testId}
          />
        ) : (
          <input {...field} {...props} onChange={field.onChange} type={type} placeholder={placeholder} data-testid={testId}
            className="h-11 w-full rounded-xl border border-[#e7e2ea] bg-[#fcfbfd] px-3.5 text-sm text-[#342d43] outline-none transition placeholder:text-[#aaa4b0] focus:border-[#9477bf] focus:bg-white focus:ring-2 focus:ring-[#7656b8]/10" />
        )}
      </FormControl>
      <FormMessage className="text-[11px]" />
    </FormItem>
  )} />;
}

export default function SalesManagement() {
  const [activeContractsOpen, setActiveContractsOpen] = useState(false);
  const { user } = useUser();
  const queryClient = useQueryClient();
  const { data: sales, isLoading, isFetching, isError, refetch: refetchSales } = useGetSales({
    query: { queryKey: getGetSalesQueryKey(), refetchOnMount: 'always' },
  });
  const { data: historySales, isLoading: isHistoryLoading, isError: isHistoryError, refetch: refetchHistory } = useGetSalesHistory({
    query: { queryKey: getGetSalesHistoryQueryKey(), refetchOnMount: 'always' },
  });
  const {
    data: pendingDrafts,
    isLoading: isPendingDraftsLoading,
    isError: isPendingDraftsError,
    refetch: refetchPendingDrafts,
  } = useGetSalesPendingDrafts({
    query: { queryKey: getGetSalesPendingDraftsQueryKey(), refetchOnMount: 'always' },
  });
  const { data: productRecords, isLoading: isProductsLoading, isError: isProductsError, refetch: refetchProducts } = useGetProducts({
    query: { queryKey: getGetProductsQueryKey(), refetchOnMount: 'always' },
  });
  const { data: occupancyModalities, isLoading: areModalitiesLoading, isError: areModalitiesError, refetch: refetchModalities } = useGetOccupancyModalities({
    query: { queryKey: getGetOccupancyModalitiesQueryKey(), refetchOnMount: 'always' },
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
  const cancelSale = useCancelSale();
  const createSalesRefund = useCreateSalesRefund();
  const createProduct = useCreateProduct();
  const updateProduct = useUpdateProduct();
  const importSales = useImportSales();
  const updatePendingDraft = useUpdateSalesPendingDraft();
  const restoreBackup = useRestoreMonthlySalesBackup();
  const {
    data: refunds,
    isLoading: isRefundsLoading,
    isError: isRefundsError,
    refetch: refetchRefunds,
  } = useGetSalesRefunds({
    query: { queryKey: getGetSalesRefundsQueryKey(), refetchOnMount: 'always' },
  });
  const {
    data: refundCandidates,
    isLoading: isRefundCandidatesLoading,
    isError: isRefundCandidatesError,
    refetch: refetchRefundCandidates,
  } = useGetSalesRefundCandidates({
    query: { queryKey: getGetSalesRefundCandidatesQueryKey(), refetchOnMount: 'always' },
  });
  const [editing, setEditing] = useState<Sale | null>(null);
  const [cancelling, setCancelling] = useState<Sale | null>(null);
  const [refundDialogOpen, setRefundDialogOpen] = useState(false);
  const [refundSaleId, setRefundSaleId] = useState('');
  const [refundDate, setRefundDate] = useState(todayLocal());
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [refundError, setRefundError] = useState('');
  const [historySale, setHistorySale] = useState<Sale | null>(null);
  const [editingPendingDraft, setEditingPendingDraft] = useState<SalesPendingDraft | null>(null);
  const [cancellationReason, setCancellationReason] = useState('');
  const [cancellationError, setCancellationError] = useState('');
  const [cancellationConflict, setCancellationConflict] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [filterProduct, setFilterProduct] = useState('');
  const [historyPeriodMode, setHistoryPeriodMode] = useState<ScoreboardPeriodMode>('all');
  const [historyMonth, setHistoryMonth] = useState(getSaoPauloMonthKey());
  const [historyMonths, setHistoryMonths] = useState<string[]>([getSaoPauloMonthKey()]);
  const [historyMonthToAdd, setHistoryMonthToAdd] = useState(getSaoPauloMonthKey());
  const [historyYear, setHistoryYear] = useState(getSaoPauloMonthKey().slice(0, 4));
  const [historyQuarter, setHistoryQuarter] = useState(String(Math.ceil(Number(getSaoPauloMonthKey().slice(5, 7)) / 3)));
  const [historyWeekdays, setHistoryWeekdays] = useState<number[]>([]);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'cancelled'>('all');
  const [filterCadastroStatus, setFilterCadastroStatus] = useState<'all' | 'needs-review' | 'complete'>('all');
  const [productsOpen, setProductsOpen] = useState(false);
  const [productSearch, setProductSearch] = useState('');
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [deactivatingProduct, setDeactivatingProduct] = useState<Product | null>(null);
  const [deactivationError, setDeactivationError] = useState('');
  const [productFeedback, setProductFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importWorkspace, setImportWorkspace] = useState<ImportWorkspace | null>(null);
  const [importError, setImportError] = useState('');
  const [importFeedback, setImportFeedback] = useState('');
  const [skippedImportRows, setSkippedImportRows] = useState<Set<string>>(new Set());
  const importFileRef = useRef<HTMLInputElement>(null);
  const [periodSelection, setPeriodSelection] = useState<SalesPeriodBackupSelection>({
    mode: 'months',
    months: [getSaoPauloMonthKey()],
    productName: null,
    cadastralStatus: 'all',
  });
  const [periodMonthDraft, setPeriodMonthDraft] = useState(getSaoPauloMonthKey());
  const [periodQuarterYear, setPeriodQuarterYear] = useState(getSaoPauloMonthKey().slice(0, 4));
  const [periodQuarter, setPeriodQuarter] = useState(() => String(Math.ceil(Number(getSaoPauloMonthKey().slice(5, 7)) / 3)));
  const [periodDialogMode, setPeriodDialogMode] = useState<'report' | 'backup'>('report');
  const [periodBackupPreview, setPeriodBackupPreview] = useState<SalesPeriodBackup | null>(null);
  const [periodReportSnapshot, setPeriodReportSnapshot] = useState<{
    sales: Sale[];
    refunds: SalesRefundRecord[];
    products: Product[];
    pendingDrafts: SalesPendingDraft[];
    refreshedAt: string;
  } | null>(null);
  const [selectionStorageUser, setSelectionStorageUser] = useState('');
  const [backupDialogOpen, setBackupDialogOpen] = useState(false);
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isGeneratingBackup, setIsGeneratingBackup] = useState(false);
  const [isPreviewingRestore, setIsPreviewingRestore] = useState(false);
  const [exportFeedback, setExportFeedback] = useState('');
  const [exportError, setExportError] = useState('');
  const [backupError, setBackupError] = useState('');
  const [restoreError, setRestoreError] = useState('');
  const [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null);
  const [restoreResult, setRestoreResult] = useState<SalesRestoreResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const exportMenuRef = useRef<HTMLDetailsElement>(null);
  const busy = createSale.isPending || updateSale.isPending || cancelSale.isPending
    || createProduct.isPending || updateProduct.isPending || importSales.isPending
    || createSalesRefund.isPending || updatePendingDraft.isPending;
  const operationLock = useRef(false);
  const pendingSaleKey = useRef<{ fingerprint: string; key: string } | null>(null);
  const pendingProductKey = useRef<{ fingerprint: string; key: string } | null>(null);
  const pendingCancellationKey = useRef<{ fingerprint: string; key: string } | null>(null);
  const pendingRefundKey = useRef<{ fingerprint: string; key: string } | null>(null);
  const [importPendingOnly, setImportPendingOnly] = useState(false);

  useEffect(() => {
    const userId = user?.id;
    if (!userId) return;
    const key = `zero3-pro-sales-report-selection:${userId}`;
    try {
      const saved = localStorage.getItem(key);
      if (saved) {
        const value = JSON.parse(saved) as SalesPeriodBackupSelection;
        const validMonths = Array.isArray(value.months)
          && value.months.every((month) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month));
        if ((value.mode === 'months' && validMonths)
          || (value.mode === 'range' && typeof value.fromDate === 'string' && typeof value.toDate === 'string')
          || value.mode === 'all') {
          setPeriodSelection(value);
        }
      }
    } catch {
      // An unreadable local preference must not block sales or reports.
    }
    setSelectionStorageUser(userId);
  }, [user?.id]);

  useEffect(() => {
    const userId = user?.id;
    if (!userId || selectionStorageUser !== userId) return;
    try {
      localStorage.setItem(`zero3-pro-sales-report-selection:${userId}`, JSON.stringify(periodSelection));
    } catch {
      // Local storage is only a convenience for restoring report filters.
    }
  }, [periodSelection, selectionStorageUser, user?.id]);

  const products = useMemo(() => (productRecords ?? [])
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' })), [productRecords]);
  const activeProducts = useMemo(() => products.filter((product) => product.isActive), [products]);
  const productNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const product of products) names.set(productNameKey(product.name), product.name);
    for (const sale of historySales ?? []) {
      const name = normalizeProductName(sale.productName);
      if (name && !names.has(productNameKey(name))) names.set(productNameKey(name), name);
    }
    return [...names.values()].sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
  }, [products, historySales]);
  const reportSales = periodReportSnapshot?.sales ?? historySales ?? [];
  const reportRefunds = periodReportSnapshot?.refunds ?? refunds ?? [];
  const reportProducts = periodReportSnapshot?.products ?? products;
  const reportPendingDrafts = periodReportSnapshot?.pendingDrafts ?? pendingDrafts ?? [];
  const periodExportFilters: ExportFilters = {
    selection: toWorkbookSelection(periodSelection),
    productName: periodSelection.productName ?? '',
    generatedAt: periodReportSnapshot?.refreshedAt ?? '',
    cadastralStatus: periodSelection.cadastralStatus ?? 'all',
    pendingDrafts: reportPendingDrafts,
  };
  const periodReportSummary = useMemo(() => summarizeSalesReport(
    reportSales,
    reportRefunds,
    reportProducts,
    periodExportFilters,
  ), [reportSales, reportRefunds, reportProducts, periodSelection, periodReportSnapshot?.refreshedAt, reportPendingDrafts]);
  const periodReportVerificationCount = useMemo(() => countSalesWithVerificationIssues(
    reportSales,
    reportProducts,
    periodExportFilters,
  ), [reportSales, reportProducts, periodSelection, periodReportSnapshot?.refreshedAt]);
  const periodReportPendingCount = countSalesPendingDrafts(periodExportFilters);
  const validPeriodSelection = periodSelection.mode === 'all'
    || (periodSelection.mode === 'months' && Boolean(periodSelection.months?.length)
      && periodSelection.months?.every((month) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month)))
    || (periodSelection.mode === 'range' && isValidCalendarDate(periodSelection.fromDate ?? '')
      && isValidCalendarDate(periodSelection.toDate ?? '')
      && (periodSelection.fromDate ?? '') <= (periodSelection.toDate ?? ''));

  const historyMonthFilter = useMemo(() => {
    switch (historyPeriodMode) {
      case 'current': return [getSaoPauloMonthKey()];
      case 'single': return historyMonth ? [historyMonth] : [];
      case 'multiple': return [...new Set(historyMonths)].sort();
      case 'quarter': return monthsForYearQuarter(historyYear, historyQuarter);
      case 'year': return monthsForYearQuarter(historyYear);
      default: return null;
    }
  }, [historyPeriodMode, historyMonth, historyMonths, historyYear, historyQuarter]);
  const invalidHistoryRange = historyPeriodMode === 'range' && (!fromDate || !toDate || fromDate > toDate);
  const invalidHistoryYear = (historyPeriodMode === 'year' || historyPeriodMode === 'quarter')
    && monthsForYearQuarter(historyYear, historyPeriodMode === 'quarter' ? historyQuarter : undefined).length === 0;
  const filteredSales = useMemo(
    () => invalidHistoryRange || invalidHistoryYear ? [] : filterSalesForExport(historySales ?? [], historyPeriodMode === 'range' ? fromDate : '', historyPeriodMode === 'range' ? toDate : '', filterProduct, products)
      .filter((sale) => !historyMonthFilter || historyMonthFilter.includes(sale.saleDate.slice(0, 7)))
      .filter((sale) => !historyWeekdays.length || historyWeekdays.includes(getIsoWeekday(sale.saleDate) ?? 0))
      .filter((sale) => filterStatus === 'all' || sale.status === filterStatus)
      .filter((sale) => filterCadastroStatus === 'all'
        || (filterCadastroStatus === 'needs-review'
          ? getSaleVerificationIssues(sale).length > 0
          : getSaleVerificationIssues(sale).length === 0)),
    [historySales, invalidHistoryRange, invalidHistoryYear, historyPeriodMode, historyMonthFilter, historyWeekdays, fromDate, toDate, filterProduct, filterStatus, filterCadastroStatus, products],
  );
  const visiblePendingDrafts = useMemo(() => (pendingDrafts ?? [])
    .filter((draft) => filterCadastroStatus !== 'complete')
    .filter((draft) => {
      const date = draft.saleDate?.slice(0, 10);
      if (!date) return true;
      if (historyPeriodMode === 'range') {
        return !invalidHistoryRange && date >= fromDate && date <= toDate;
      }
      return !historyMonthFilter || historyMonthFilter.includes(date.slice(0, 7));
    })
    .filter((draft) => !filterProduct || !draft.productName
      || productNameKey(draft.productName) === productNameKey(filterProduct)),
  [pendingDrafts, filterCadastroStatus, historyPeriodMode, invalidHistoryRange, fromDate, toDate, historyMonthFilter, filterProduct]);
  const visibleProducts = useMemo(() => products.filter((product) => product.name.toLocaleLowerCase('pt-BR').includes(productSearch.trim().toLocaleLowerCase('pt-BR'))), [products, productSearch]);
  const activeRefundTotalsBySale = useMemo(() => {
    const totals = new Map<string, bigint>();
    for (const refund of refunds ?? []) {
      if (refund.status === 'active') {
        totals.set(refund.saleId, (totals.get(refund.saleId) ?? 0n) + BigInt(refund.amountCents));
      }
    }
    return totals;
  }, [refunds]);
  const selectedRefundCandidate = refundCandidates?.find(({ saleId }) => saleId === refundSaleId);
  const refundAmountCents = parseBrlCents(refundAmount);

  const productForm = useForm<ProductFormValues>({
    resolver: zodResolver(productFormSchema),
    defaultValues: { name: '', suggestedPrice: '', modalityId: '', isActive: true },
  });
  const importedLines = useMemo(() => (importWorkspace?.sheets ?? []).flatMap((sheet) =>
    sheet.rows.map((source) => ({
      ...mapSalesImportRow(sheet, source),
      key: source.key,
      sourceSheet: sheet.name,
      sourceRow: source.sourceRow,
      source,
      alreadyImported: importWorkspace?.importedKeys.includes(source.key) ?? false,
      sheetSelected: sheet.selected,
    })),
  ), [importWorkspace]);
  const importDuplicateNotices = useMemo(() => {
    const candidates = importedLines.filter((line) =>
      line.kind !== 'auxiliary' && !line.alreadyImported && line.sheetSelected);
    return findSalesImportDuplicateNotices(candidates.map((line) => ({
      key: line.key,
      label: `Planilha: ${line.sourceSheet}, linha ${line.sourceRow}`,
      included: !skippedImportRows.has(line.key),
      customerName: line.preview.customerName || null,
      saleDate: isValidCalendarDate(line.preview.saleDate) ? line.preview.saleDate : null,
      productName: line.preview.productName,
      totalCents: line.preview.totalCents,
    })), historySales ?? []);
  }, [importedLines, historySales, skippedImportRows]);
  const selectedImportLines = useMemo(() => {
    const selectedSheets = new Set((importWorkspace?.sheets ?? []).filter((sheet) => sheet.selected).map((sheet) => sheet.name));
    return importedLines.filter((line) => line.kind !== 'auxiliary' && !line.alreadyImported
      && selectedSheets.has(line.sourceSheet) && !skippedImportRows.has(line.key));
  }, [importWorkspace, importedLines, skippedImportRows]);
  const validImportRows = useMemo(() => selectedImportLines.flatMap((line) => {
    const value = line.value;
    if (!value) return [];
    const normalizedName = value.productName ? normalizeProductName(value.productName) : null;
    const canonical = normalizedName
      ? products.find((product) => productNameKey(product.name) === productNameKey(normalizedName))
      : null;
    return [{
      customerName: value.customerName,
      saleDate: value.saleDate,
      totalCents: value.totalCents,
      productName: canonical?.name ?? normalizedName ?? null,
      sourceSheet: value.sourceSheet,
      sourceRow: value.sourceRow,
    }];
  }), [selectedImportLines, products]);
  const pendingImportRows = useMemo(() => selectedImportLines.flatMap((line) => {
    if (!line.draftValue) return [];
    return [{
      customerName: line.draftValue.customerName,
      saleDate: line.draftValue.saleDate,
      saleDateText: line.draftValue.saleDateText,
      productName: line.draftValue.productName,
      totalCents: line.draftValue.totalCents,
      amountText: line.draftValue.amountText,
      notes: null,
      sourceSheet: line.draftValue.sourceSheet,
      sourceRow: line.draftValue.sourceRow,
    }];
  }), [selectedImportLines]);
  const pendingImportCount = importedLines.filter((line) => line.kind === 'pending' && !line.alreadyImported).length;
  const alreadyImportedCount = importedLines.filter((line) => line.alreadyImported).length;
  const readyImportCount = importedLines.filter((line) => line.kind === 'ready' && !line.alreadyImported).length;
  const candidateImportCount = readyImportCount + pendingImportCount + alreadyImportedCount;
  const auxiliaryImportCount = importedLines.filter((line) => line.kind === 'auxiliary' && !line.alreadyImported).length;
  const importOverLimit = selectedImportLines.length > MAX_IMPORT_ROWS;
  const selectedImportSheets = (importWorkspace?.sheets ?? []).filter((sheet) => sheet.selected);
  const importMappingIncomplete = !importWorkspace || !selectedImportSheets.length
    ;
  const importTotalBigInt = selectedImportLines.reduce((sum, line) => sum + BigInt(line.value?.totalCents ?? 0), 0n);
  const importTotalTooLarge = importTotalBigInt > BigInt(Number.MAX_SAFE_INTEGER);
  const importTotalCents = importTotalTooLarge ? 0 : Number(importTotalBigInt);
  const importTotalLabel = importTotalTooLarge ? 'Total acima do limite seguro' : formatCents(importTotalCents);

  async function invalidateSalesRelated() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetSalesQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetSalesHistoryQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetSalesRefundCandidatesQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetSalesRefundsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetProductsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetSalesGoalsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetSalesScoreboardQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetSalesPendingDraftsQueryKey() }),
    ]);
  }

  async function savePendingDraft(id: string, data: UpdateSalesPendingDraftInput): Promise<UpdateSalesPendingDraftResult> {
    if (operationLock.current) throw new Error('Aguarde a operação atual terminar.');
    operationLock.current = true;
    try {
      const result = await updatePendingDraft.mutateAsync({ id, data });
      await invalidateSalesRelated();
      setFeedback({
        type: 'success',
        message: result.status === 'completed'
          ? 'Pendência completada e venda registrada no faturamento.'
          : 'Pendência atualizada. Ela continua fora do faturamento até ser completada.',
      });
      setEditingPendingDraft(null);
      return result;
    } finally {
      operationLock.current = false;
    }
  }

  async function openRefundDialog() {
    setRefundError('');
    setRefundDate(todayLocal());
    setRefundAmount('');
    setRefundReason('');
    const result = await refetchRefundCandidates();
    const candidates = result.data ?? refundCandidates ?? [];
    setRefundSaleId(candidates[0]?.saleId ?? '');
    setRefundDialogOpen(true);
  }

  async function submitRefund(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createSalesRefund.isPending) return;
    const candidate = refundCandidates?.find(({ saleId }) => saleId === refundSaleId);
    const amountCents = parseBrlCents(refundAmount);
    const reason = refundReason.trim().replace(/\s+/g, ' ');
    if (!candidate) {
      setRefundError('Selecione uma venda ativa com saldo disponível.');
      return;
    }
    if (!isValidCalendarDate(refundDate) || refundDate < candidate.saleDate.slice(0, 10)) {
      setRefundError('Informe uma data válida, igual ou posterior à data da venda.');
      return;
    }
    if (amountCents === null || amountCents <= 0 || amountCents > candidate.remainingCents) {
      setRefundError(`Informe um valor positivo de até ${formatCents(candidate.remainingCents)}.`);
      return;
    }
    if (!reason || reason.length > 500) {
      setRefundError('Informe um motivo com até 500 caracteres.');
      return;
    }
    const fingerprint = `${candidate.saleId}:${refundDate}:${amountCents}:${reason}`;
    if (pendingRefundKey.current?.fingerprint !== fingerprint) {
      pendingRefundKey.current = { fingerprint, key: crypto.randomUUID() };
    }
    setRefundError('');
    try {
      await createSalesRefund.mutateAsync({
        id: candidate.saleId,
        data: {
          refundDate,
          amountCents,
          reason,
          idempotencyKey: pendingRefundKey.current.key,
        },
      });
      await invalidateSalesRelated();
      pendingRefundKey.current = null;
      setRefundDialogOpen(false);
      setFeedback({ type: 'success', message: 'Estorno registrado e vinculado à venda original.' });
    } catch (error) {
      setRefundError(errorMessage(error));
      if (error && typeof error === 'object' && 'status' in error && error.status === 409) {
        void invalidateSalesRelated();
      }
    }
  }

  function openProductManager() {
    setProductFeedback(null);
    setEditingProduct(null);
    setProductSearch('');
    productForm.reset({ name: '', suggestedPrice: '', modalityId: '', isActive: true });
    setProductsOpen(true);
  }

  function editProduct(product: Product) {
    setProductFeedback(null);
    setEditingProduct(product);
    productForm.reset({
      name: product.name,
      suggestedPrice: `${Math.floor(product.suggestedPriceCents / 100)},${String(product.suggestedPriceCents % 100).padStart(2, '0')}`,
      modalityId: product.modalityId ?? '',
      isActive: product.isActive,
    });
  }

  async function saveProduct(values: ProductFormValues) {
    if (busy || operationLock.current) return;
    const name = normalizeProductName(values.name);
    const suggestedPriceCents = parseBrlCents(values.suggestedPrice);
    if (suggestedPriceCents === null) {
      setProductFeedback({ type: 'error', message: 'Confira o preço sugerido antes de salvar.' });
      return;
    }
    const fingerprint = `${editingProduct?.id ?? 'novo'}:${editingProduct?.version ?? ''}:${name}:${suggestedPriceCents}:${values.modalityId}:${values.isActive}`;
    if (pendingProductKey.current?.fingerprint !== fingerprint) {
      pendingProductKey.current = { fingerprint, key: crypto.randomUUID() };
    }
    operationLock.current = true;
    setProductFeedback(null);
    try {
      if (editingProduct) {
        const data: UpdateProductInput = {
          name,
          suggestedPriceCents,
          modalityId: values.modalityId || null,
          isActive: values.isActive,
          expectedVersion: editingProduct.version,
          idempotencyKey: pendingProductKey.current.key,
        };
        await updateProduct.mutateAsync({ id: editingProduct.id, data });
        setProductFeedback({ type: 'success', message: 'Produto atualizado. O vínculo de modalidade também classifica as vendas anteriores; valores e datas permanecem iguais.' });
      } else {
        const data: CreateProductInput = {
          name,
          suggestedPriceCents,
          modalityId: values.modalityId || null,
          isActive: values.isActive,
          idempotencyKey: pendingProductKey.current.key,
        };
        await createProduct.mutateAsync({ data });
        setProductFeedback({ type: 'success', message: 'Produto cadastrado.' });
      }
      await invalidateSalesRelated();
      setEditingProduct(null);
      pendingProductKey.current = null;
      productForm.reset({ name: '', suggestedPrice: '', modalityId: '', isActive: true });
    } catch (error) {
      setProductFeedback({ type: 'error', message: conflictAwareMessage(error, 'produto') });
      if (error && typeof error === 'object' && 'status' in error && error.status === 409) void invalidateSalesRelated();
    } finally {
      operationLock.current = false;
    }
  }

  async function confirmDeactivateProduct() {
    const product = deactivatingProduct;
    if (!product || busy || operationLock.current) return;
    operationLock.current = true;
    setDeactivationError('');
    setProductFeedback(null);
    try {
      await updateProduct.mutateAsync({
        id: product.id,
        data: {
          name: product.name,
          suggestedPriceCents: product.suggestedPriceCents,
          modalityId: product.modalityId,
          isActive: false,
          expectedVersion: product.version,
          idempotencyKey: crypto.randomUUID(),
        },
      });
      await invalidateSalesRelated();
      if (editingProduct?.id === product.id) {
        setEditingProduct(null);
        pendingProductKey.current = null;
        productForm.reset({ name: '', suggestedPrice: '', modalityId: '', isActive: true });
      }
      setProductFeedback({
        type: 'success',
        message: `${product.name} foi inativado. Vendas, estornos e metas foram mantidos; o produto pode ser reativado na edição.`,
      });
      setDeactivatingProduct(null);
    } catch (error) {
      setDeactivationError(conflictAwareMessage(error, 'produto'));
      if (error && typeof error === 'object' && 'status' in error && error.status === 409) {
        await invalidateSalesRelated();
      }
    } finally {
      operationLock.current = false;
    }
  }

  async function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    setImportError('');
    setImportFeedback('');
    setImportWorkspace(null);
    setSkippedImportRows(new Set());
    setImportPendingOnly(false);
    if (!file) return;
    if (!/\.(csv|xlsx)$/i.test(file.name)) {
      setImportError('Formato não suportado. Aceitamos apenas arquivos .xlsx e .csv; arquivos .xls não são compatíveis.');
      setImportOpen(true);
      return;
    }
    if (file.size > MAX_BACKUP_FILE_BYTES) {
      setImportError('O arquivo ultrapassa o limite de 10 MB.');
      setImportOpen(true);
      return;
    }
    try {
      const bytes = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const fileHash = Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, '0')).join('');
      const parsed = await parseSalesSpreadsheet(bytes, file.name);
      const { origins } = await getSalesImportOrigins({ fileHash });
      setImportWorkspace({
        filename: file.name,
        fileHash,
        sheets: parsed.sheets,
        importedKeys: origins.map((origin) => `${origin.sourceSheet}:${origin.sourceRow}`),
      });
      setImportOpen(true);
    } catch (error) {
      setImportError(errorMessage(error));
      setImportOpen(true);
    }
  }

  function setImportRowIncluded(key: string, included: boolean) {
    setSkippedImportRows((current) => {
      const next = new Set(current);
      if (included) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function commitImport() {
    if (!importWorkspace || importMappingIncomplete
      || (!validImportRows.length && !pendingImportRows.length) || importTotalTooLarge
      || importOverLimit || importSales.isPending || operationLock.current) return;
    const workspace = importWorkspace;
    operationLock.current = true;
    setImportError('');
    setImportFeedback('');
    try {
      const result = await importSales.mutateAsync({
        data: {
          fileHash: workspace.fileHash,
          filename: workspace.filename,
          rows: validImportRows,
          pendingRows: pendingImportRows,
        },
      });
      const committedKeys = selectedImportLines.map((line) => line.key);
      setImportWorkspace((current) => current?.fileHash === workspace.fileHash ? {
        ...current, importedKeys: [...new Set([...current.importedKeys, ...committedKeys])],
      } : current);
      await invalidateSalesRelated();
      setImportFeedback(result.replayed
        ? 'As linhas selecionadas já estavam salvas. Nenhuma venda ou pendência duplicada foi criada.'
        : `${result.importedCount} venda(s) confirmada(s) e ${result.pendingCount} pendência(s) salva(s). ${result.skippedCount + result.skippedPendingCount} linha(s) já existentes.`);
    } catch (error) {
      setImportError(errorMessage(error));
    } finally {
      operationLock.current = false;
    }
  }

  function closeExportMenu() {
    if (exportMenuRef.current) exportMenuRef.current.open = false;
  }

  function updatePeriodSelection(next: SalesPeriodBackupSelection) {
    setPeriodSelection({
      ...next,
      cadastralStatus: next.cadastralStatus ?? periodSelection.cadastralStatus ?? 'all',
    });
    setPeriodBackupPreview(null);
    setBackupError('');
  }

  async function refreshPeriodReportData() {
    const [salesResult, refundResult, productResult, pendingResult] = await Promise.all([
      refetchHistory(),
      refetchRefunds(),
      refetchProducts(),
      refetchPendingDrafts(),
    ]);
    if (salesResult.isError || !salesResult.data || refundResult.isError || !refundResult.data || productResult.isError || !productResult.data || pendingResult.isError || !pendingResult.data) {
      throw new Error('Não foi possível atualizar vendas, estornos, produtos e pendências para a prévia.');
    }
    const snapshot = {
      sales: salesResult.data,
      refunds: refundResult.data,
      products: productResult.data,
      pendingDrafts: pendingResult.data,
      refreshedAt: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    };
    setPeriodReportSnapshot(snapshot);
    return snapshot;
  }

  function openPeriodDialog(mode: 'report' | 'backup' = 'report') {
    closeExportMenu();
    setPeriodDialogMode(mode);
    setPeriodBackupPreview(null);
    setBackupError('');
    setExportError('');
    setExportFeedback('');
    setBackupDialogOpen(true);
    setIsExporting(true);
    void refreshPeriodReportData()
      .catch((error) => setExportError(errorMessage(error)))
      .finally(() => setIsExporting(false));
  }

  async function exportPeriodReport(format: 'xlsx' | 'csv') {
    if (isExporting || !validPeriodSelection) return;
    setIsExporting(true);
    setExportError('');
    setExportFeedback('');
    try {
      const snapshot = await refreshPeriodReportData();
      const filters = {
        selection: toWorkbookSelection(periodSelection),
        productName: periodSelection.productName ?? '',
        generatedAt: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
        cadastralStatus: periodSelection.cadastralStatus ?? 'all',
        pendingDrafts: snapshot.pendingDrafts,
      };
      const dateSuffix = new Date().toISOString().slice(0, 10);
      if (format === 'xlsx') {
        downloadSalesWorkbook(snapshot.sales, snapshot.refunds, snapshot.products, filters, `zero3-pro-relatorio-financeiro-${dateSuffix}.xlsx`);
        setExportFeedback('Relatório Excel exportado. Pendências ficam identificadas à parte e não entram nos totais financeiros.');
      } else {
        downloadSalesCsv(snapshot.sales, snapshot.refunds, snapshot.products, filters, `zero3-pro-relatorio-financeiro-${dateSuffix}.csv`);
        setExportFeedback('CSV exportado. Rascunhos ficam identificados e não entram nos totais financeiros.');
      }
    } catch (error) {
      setExportError(errorMessage(error));
    } finally {
      setIsExporting(false);
    }
  }

  async function generatePeriodBackupPreview() {
    if (isGeneratingBackup) return;
    setIsGeneratingBackup(true);
    setBackupError('');
    try {
      const request: SalesPeriodBackupSelection = {
        ...periodSelection,
        productName: periodSelection.productName || null,
      };
      const backup = await createSalesPeriodBackup(request);
      setPeriodBackupPreview(backup);
    } catch (error) {
      setBackupError(errorMessage(error));
    } finally {
      setIsGeneratingBackup(false);
    }
  }

  function downloadPeriodBackupPreview() {
    if (!periodBackupPreview) return;
    downloadSalesPeriodBackup(periodBackupPreview);
    setBackupError('');
    setExportFeedback(`Cópia do período criada: ${periodBackupPreview.counts.periodSales} vendas, ${periodBackupPreview.counts.periodRefunds} estornos e ${periodBackupPreview.counts.periodGoals} metas; ${periodBackupPreview.counts.dependencySales + periodBackupPreview.counts.dependencyRefunds} dependências incluídas.`);
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

    setIsPreviewingRestore(true);
    try {
      const parsed = parseMonthlySalesBackup(JSON.parse(await file.text()));
      const report = await previewMonthlySalesBackupRestore(parsed);
      const previewSales = 'schemaVersion' in parsed
        ? parsed.sales.map(({ scope, record }) => ({
          id: String(record.id), saleDate: String(record.saleDate), productName: String(record.productName),
          totalCents: Number(record.totalCents), scope,
        }))
        : parsed.sales.map((sale) => ({ ...sale, scope: 'period' }));
      const salesCents = 'schemaVersion' in parsed
        ? parsed.sales.filter(({ scope, record }) => scope === 'period' && record.status === 'active').reduce((sum, { record }) => sum + BigInt(Number(record.totalCents)), 0n)
        : parsed.sales.reduce((sum, sale) => sum + BigInt(sale.totalCents), 0n);
      const refundsCents = 'schemaVersion' in parsed
        ? parsed.refunds.filter(({ scope, record }) => scope === 'period' && record.status === 'active').reduce((sum, { record }) => sum + BigInt(Number(record.amountCents)), 0n)
        : 0n;
      setRestorePreview({ backup: parsed, report, sales: previewSales, salesCents, refundsCents });
    } catch (error) {
      setRestoreError(error instanceof SyntaxError
        ? 'O arquivo não contém um JSON válido.'
        : errorMessage(error));
    } finally {
      setIsPreviewingRestore(false);
    }
  }

  async function confirmBackupRestore() {
    if (!restorePreview || restorePreview.report.blocked || restoreBackup.isPending) return;
    setRestoreError('');
    try {
      const result = await restoreBackup.mutateAsync({ data: restorePreview.backup });
      await invalidateSalesRelated();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetSalesRefundsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetSalesScoreboardQueryKey() }),
      ]);
      setRestoreResult(result);
    } catch (error) {
      setRestoreError(errorMessage(error));
    }
  }

  const form = useForm<SaleFormValues>({
    resolver: zodResolver(saleFormSchema),
    defaultValues: { saleDate: todayLocal(), productName: '', modalityId: '', quantity: '1', unitAmount: '', customerName: '', notes: '' },
  });
  const quantityInput = form.watch('quantity') || '';
  const customerInput = form.watch('customerName') || '';
  const saleDateInput = form.watch('saleDate') || '';
  const productInput = form.watch('productName') || '';
  const unitAmountInput = form.watch('unitAmount') || '';
  const quantity = /^\d+$/.test(quantityInput) ? BigInt(quantityInput) : 0n;
  const parsedUnitCents = parseBrlCents(unitAmountInput);
  const unitCents = parsedUnitCents ?? 0;
  const total = quantity * BigInt(unitCents);
  const duplicateTotalCents = parsedUnitCents !== null && total <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(total)
    : null;
  const manualDuplicateMatches = useMemo(() => findPossibleSaleDuplicates({
    customerName: customerInput,
    saleDate: saleDateInput,
    productName: productInput,
    totalCents: duplicateTotalCents,
  }, historySales ?? [], { excludeId: editing?.id }), [
    customerInput, saleDateInput, productInput, duplicateTotalCents, historySales, editing?.id,
  ]);

  function resetForm() {
    pendingSaleKey.current = null;
    setEditing(null);
    form.reset({ saleDate: todayLocal(), productName: '', modalityId: '', quantity: '1', unitAmount: '', customerName: '', notes: '' });
  }

  function startEditing(sale: Sale) {
    pendingSaleKey.current = null;
    setFeedback(null);
    setEditing(sale);
    form.reset({
      saleDate: sale.saleDate,
      productName: sale.productName,
      modalityId: sale.modalityOverride
        ? sale.modalityId ?? ''
        : products?.find((product) =>
            product.id === sale.productId ||
            productNameKey(product.name) === productNameKey(sale.productName),
          )?.modalityId ?? '',
      quantity: String(sale.quantity),
      unitAmount: `${Math.floor(sale.unitAmountCents / 100)},${String(sale.unitAmountCents % 100).padStart(2, '0')}`,
      customerName: sale.customerName ?? '',
      notes: sale.notes ?? '',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function submit(values: SaleFormValues) {
    if (busy || operationLock.current) return;
    operationLock.current = true;
    setFeedback(null);
    const cleanedName = normalizeProductName(values.productName);
    const canonical = activeProducts.find((product) => productNameKey(product.name) === productNameKey(cleanedName));
    const input: SaleInput = {
      saleDate: values.saleDate,
      productName: canonical?.name ?? cleanedName,
      modalityId: values.modalityId || null,
      quantity: Number(values.quantity),
      unitAmountCents: parseBrlCents(values.unitAmount) ?? 0,
      customerName: values.customerName.trim().replace(/\s+/g, ' ') || null,
      notes: values.notes.trim().replace(/\s+/g, ' ') || null,
    };
    const fingerprint = `${editing ? `${editing.id}:${editing.version}` : 'new'}:${JSON.stringify(input)}`;
    if (pendingSaleKey.current?.fingerprint !== fingerprint) {
      pendingSaleKey.current = { fingerprint, key: crypto.randomUUID() };
    }
    const idempotencyKey = pendingSaleKey.current.key;
    try {
      if (editing) {
        await updateSale.mutateAsync({
          id: editing.id,
          data: { ...input, idempotencyKey, expectedVersion: editing.version },
        });
        setFeedback({ type: 'success', message: 'Lançamento atualizado.' });
      } else {
        await createSale.mutateAsync({ data: { ...input, idempotencyKey } });
        setFeedback({ type: 'success', message: 'Venda registrada com sucesso.' });
      }
      await invalidateSalesRelated();
      resetForm();
    } catch (error) {
      setFeedback({ type: 'error', message: conflictAwareMessage(error, 'venda') });
      if (error && typeof error === 'object' && 'status' in error && error.status === 409) void invalidateSalesRelated();
    } finally {
      operationLock.current = false;
    }
  }

  async function confirmCancellation() {
    if (!cancelling || !cancellationReason.trim() || busy || operationLock.current) return;
    operationLock.current = true;
    const target = cancelling;
    setFeedback(null);
    setCancellationError('');
    const reason = cancellationReason.trim().replace(/\s+/g, ' ');
    const fingerprint = `${target.id}:${target.version}:${reason}`;
    if (pendingCancellationKey.current?.fingerprint !== fingerprint) {
      pendingCancellationKey.current = { fingerprint, key: crypto.randomUUID() };
    }
    try {
      await cancelSale.mutateAsync({
        id: target.id,
        data: {
          reason,
          expectedVersion: target.version,
          idempotencyKey: pendingCancellationKey.current.key,
        },
      });
      await invalidateSalesRelated();
      setCancelling(null);
      setCancellationReason('');
      pendingCancellationKey.current = null;
      if (editing?.id === target.id) resetForm();
      setFeedback({ type: 'success', message: 'Venda cancelada. O registro continua disponível no histórico.' });
    } catch (error) {
      setCancellationError(conflictAwareMessage(error, 'venda'));
      const isConflict = !!error && typeof error === 'object' && 'status' in error && error.status === 409;
      setCancellationConflict(isConflict);
      if (isConflict) void invalidateSalesRelated();
    } finally {
      operationLock.current = false;
    }
  }

  return (
    <>
      <ActiveContractsDialog open={activeContractsOpen} onOpenChange={setActiveContractsOpen} />
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between" data-testid="sales-actions">
        <div>
          <p className="eyebrow text-[9px] font-bold text-[#8b8494]">rotina comercial</p>
          <p className="mt-1 text-sm text-[#77717f]">Registre, revise e acompanhe cada venda da equipe.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setActiveContractsOpen(true)} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[#ded7e7] bg-white px-4 text-sm font-bold text-[#5d4a78] transition hover:bg-[#f7f4fa]" data-testid="button-active-contracts"><UsersRound size={15} /> Contratos ativos</button>
          <button type="button" onClick={openProductManager} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[#ded7e7] bg-white px-4 text-sm font-bold text-[#5d4a78] transition hover:bg-[#f7f4fa]" data-testid="button-manage-products"><Search size={15} /> Produtos</button>
          <button type="button" onClick={() => { resetForm(); document.getElementById('sale-entry-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); document.querySelector<HTMLInputElement>('[data-testid="input-sale-date"]')?.focus(); }} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[#d7f500] px-4 text-sm font-extrabold text-[#262b15] transition hover:bg-[#c9e600] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6d28d9] focus-visible:ring-offset-2" data-testid="button-new-sale"><Plus size={16} /> Nova venda</button>
          <button type="button" onClick={() => void openRefundDialog()} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[#e9d9d5] bg-[#fffaf8] px-4 text-sm font-bold text-[#8e554e] transition hover:bg-[#fff0ed]" data-testid="button-new-cancellation"><RotateCcw size={15} /> Novo estorno</button>
          <button type="button" onClick={() => importFileRef.current?.click()} disabled={isHistoryLoading || isHistoryError} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[#ded7e7] bg-white px-4 text-sm font-bold text-[#5d4a78] transition hover:bg-[#f7f4fa] disabled:cursor-not-allowed disabled:opacity-50" data-testid="button-import-sales"><Upload size={15} /> Importar planilha</button>
        </div>
      </div>
      {importFeedback && <div role="status" className="mb-3 rounded-xl bg-[#eff6e5] px-3.5 py-2.5 text-xs font-semibold text-[#55772c]" data-testid="status-import-success">{importFeedback}</div>}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between" data-testid="sales-export-controls">
        <div className="text-[10px] leading-4 text-[#8a8491]">Exporte os filtros atuais ou gere uma cópia mensal para recuperação.</div>
        <details ref={exportMenuRef} className="relative self-start sm:self-auto">
          <summary
            className="flex h-10 cursor-pointer list-none items-center gap-2 rounded-xl border border-[#ded7e7] bg-white px-3.5 text-xs font-bold text-[#5d4a78] transition hover:bg-[#f7f4fa] [&::-webkit-details-marker]:hidden"
            data-testid="button-export-menu"
          >
            <Download size={15} /> Exportar
          </summary>
          <div className="absolute left-0 z-20 mt-2 w-[230px] max-w-[calc(100vw-2rem)] rounded-2xl border border-[#e7e1e9] bg-white p-1.5 shadow-[0_12px_35px_rgba(40,32,56,.15)] sm:left-auto sm:right-0">
            <button type="button" onClick={() => openPeriodDialog('report')} disabled={isExporting} className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs font-semibold text-[#4d4559] transition hover:bg-[#f8f6fa] disabled:opacity-50" data-testid="button-export-spreadsheet">
              <FileSpreadsheet size={15} className="text-[#6d9b45]" />
              <span>Relatório Excel / CSV</span>
            </button>
            <button type="button" onClick={() => openPeriodDialog('backup')} className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs font-semibold text-[#4d4559] transition hover:bg-[#f8f6fa]" data-testid="button-open-monthly-backup">
              <Download size={15} className="text-[#7656b8]" />
              <span>Backup do período (.json)</span>
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
        <input ref={importFileRef} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => void handleImportFile(event)} className="sr-only" aria-label="Selecionar arquivo para importar vendas" data-testid="input-import-sales-file" />
      </div>
      {(exportFeedback || exportError) && <div role={exportError ? 'alert' : 'status'} className={`rounded-xl px-3.5 py-2.5 text-xs font-semibold ${exportError ? 'bg-[#fff0ed] text-[#9c483f]' : 'bg-[#eff6e5] text-[#55772c]'}`} data-testid={exportError ? 'status-export-error' : 'status-export-success'}>{exportError || exportFeedback}</div>}

      <section className="grid items-start gap-5 xl:grid-cols-[minmax(350px,.83fr)_minmax(0,1.17fr)]">
        <div className="rounded-[24px] border border-[#e9e4ec] bg-white p-5 shadow-[0_7px_28px_rgba(47,38,63,.035)] md:p-6">
          <div className="mb-5 flex items-start justify-between gap-3">
            <div><p className="eyebrow text-[9px] font-bold text-[#8b8494]">{editing ? 'ajustar registro' : 'novo registro'}</p><h2 className="mt-1 text-lg font-bold tracking-[-.035em]">{editing ? 'Editar lançamento' : 'Lançar uma venda'}</h2></div>
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[14px] bg-[#eff6e5] text-[#769f3e]"><Plus size={18} /></span>
          </div>
          <Form {...form}>
            <form id="sale-entry-form" onSubmit={form.handleSubmit(submit)} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Field name="saleDate" label="Data da venda" type="date" testId="input-sale-date" />
                <div className="col-span-2">
                  <Field name="productName" label="Plano ou produto" placeholder="Ex.: Plano Essencial" testId="input-sale-product" autoComplete="off" suggestions={activeProducts.map((product) => product.name)} suggestionTitle="Produtos cadastrados" onValueChange={(value) => {
                    const matched = activeProducts.find((product) => productNameKey(product.name) === productNameKey(value));
                    form.setValue('modalityId', matched?.modalityId ?? '', { shouldValidate: true });
                    if (matched && !form.getValues('unitAmount')) {
                      form.setValue('unitAmount', formatCentsInput(matched.suggestedPriceCents), { shouldValidate: true });
                    }
                  }} />
                  <p className="mt-1 px-1 text-[10px] leading-4 text-[#817b89]">Um nome novo será cadastrado em Produtos ao confirmar a venda.</p>
                </div>
                <div className="col-span-2">
                  <FormField name="modalityId" render={({ field }) => (
                    <FormItem className="space-y-1.5">
                      <FormLabel className="text-[11px] font-bold text-[#665f70]">Modalidade do Check-in <span className="font-medium text-[#9e98a5]">· opcional</span></FormLabel>
                      <FormControl>
                        <select {...field} value={field.value ?? ''} data-testid="select-sale-modality" className="h-11 w-full rounded-xl border border-[#e7e2ea] bg-white px-3.5 text-sm text-[#342d43] outline-none focus:border-[#9477bf]">
                          <option value="">Sem modalidade</option>
                          {(occupancyModalities ?? []).map((modality) => <option key={modality.id} value={modality.id}>{modality.name}</option>)}
                        </select>
                      </FormControl>
                      <p className="text-[10px] leading-4 text-[#8a8491]">Ao escolher um produto vinculado, a modalidade é sugerida. Você pode alterar ou remover o vínculo.</p>
                      {areModalitiesError && <p role="status" className="text-[10px] text-[#9c483f]">As modalidades não carregaram; a venda ainda pode ser salva sem vínculo. <button type="button" onClick={() => void refetchModalities()} className="font-bold underline" data-testid="button-retry-sale-modalities">Tentar novamente</button></p>}
                    </FormItem>
                  )} />
                </div>
                <Field name="quantity" label="Quantidade" type="number" min="1" step="1" inputMode="numeric" placeholder="1" testId="input-sale-quantity" />
                <Field name="unitAmount" label="Valor unitário" type="text" inputMode="decimal" placeholder="0,00" testId="input-sale-unit-amount" />
                <div className="col-span-2">
                  <Field name="customerName" label="Nome" placeholder="Nome do cliente ou identificação (opcional)" testId="input-sale-customer-name" autoComplete="off" />
                </div>
              </div>
              <div className="rounded-[16px] border border-[#e9e3ef] bg-[#f8f6fa] px-4 py-3.5">
                <div className="flex items-center justify-between gap-3"><span className="text-[11px] font-bold uppercase tracking-[.1em] text-[#81798b]">Total da venda</span><span className="font-[family-name:var(--app-font-serif)] text-[25px] font-extrabold tracking-[-.05em] text-[#423354]" data-testid="text-sale-total">{formatCents(total)}</span></div>
                <p className="mt-1 text-[10px] text-[#938c9b]">Quantidade × valor unitário</p>
              </div>
              {manualDuplicateMatches.length > 0 && <div role="status" aria-live="polite" className="rounded-xl border border-[#f1dfb8] bg-[#fff9eb] px-3.5 py-3 text-[11px] leading-4 text-[#775624]" data-testid="status-manual-possible-duplicate">
                <p className="font-bold">⚠ Possível venda duplicada</p>
                <ul className="mt-1 space-y-1">
                  {manualDuplicateMatches.slice(0, 3).map(({ record, fields }, index) => (
                    <li key={record.id ?? `${record.duplicateLabel ?? 'sale'}-${index}`}>
                      Coincidem: {fields.map((field) => saleDuplicateFieldLabels[field]).join(', ')}{record.saleDate ? ` · ${formatDate(record.saleDate)}` : ''}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 font-medium">Aviso informativo: você pode registrar a venda normalmente.</p>
              </div>}
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

        <details id="sales-history-panel" className="group min-w-0 rounded-[24px] border border-[#e9e4ec] bg-white p-5 shadow-[0_7px_28px_rgba(47,38,63,.035)] md:p-6" data-testid="panel-sales-history">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[#7656b8]/40 [&::-webkit-details-marker]:hidden">
            <div><p className="eyebrow text-[9px] font-bold text-[#8b8494]">histórico</p><h2 className="mt-1 text-lg font-bold tracking-[-.035em]">Histórico de vendas</h2></div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#f1edf7] text-[#7656b8]"><ClipboardList size={17} /></span>
              <span className="inline-flex items-center gap-1.5 rounded-xl border border-[#e9e4ec] px-3 py-2 text-xs font-bold text-[#6848a9]">
                <span className="group-open:hidden">Ver detalhes</span><span className="hidden group-open:inline">Ocultar detalhes</span>
                <ChevronDown size={14} className="transition-transform group-open:rotate-180" />
              </span>
            </div>
          </summary>
          <div className="mt-5">
          <div className="mb-4 rounded-[17px] bg-[#f8f7f9] p-3.5">
            <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[.1em] text-[#81798b]"><Filter size={12} /> Filtrar lançamentos</div>
            <div className="grid grid-cols-2 gap-2.5">
              <label className="col-span-2 min-w-0 text-[10px] font-semibold text-[#817b89]">Período
                <select value={historyPeriodMode} onChange={(event) => setHistoryPeriodMode(event.target.value as ScoreboardPeriodMode)} data-testid="select-history-period-mode" className="mt-1 h-10 w-full rounded-lg border border-[#e7e2ea] bg-white px-2.5 text-xs text-[#443d50] outline-none focus:border-[#9477bf]">
                  <option value="current">Mês atual</option><option value="single">Mês específico</option><option value="multiple">Vários meses</option><option value="quarter">Trimestre</option><option value="year">Ano</option><option value="range">Intervalo personalizado</option><option value="all">Todo o histórico</option>
                </select>
              </label>
              {historyPeriodMode === 'current' && <p className="col-span-2 self-center text-xs font-semibold capitalize text-[#5f5967]" data-testid="text-history-current-month">{formatMonthKey(getSaoPauloMonthKey())}</p>}
              {historyPeriodMode === 'single' && <label className="col-span-2 min-w-0 text-[10px] font-semibold text-[#817b89]">Mês
                <input type="month" value={historyMonth} onChange={(event) => setHistoryMonth(event.target.value)} data-testid="input-history-month" className="mt-1 h-10 w-full rounded-lg border border-[#e7e2ea] bg-white px-2.5 text-xs text-[#443d50] outline-none focus:border-[#9477bf]" />
              </label>}
              {historyPeriodMode === 'multiple' && <div className="col-span-2 min-w-0">
                <label className="text-[10px] font-semibold text-[#817b89]">Adicionar mês</label>
                <div className="flex gap-2"><input type="month" value={historyMonthToAdd} onChange={(event) => setHistoryMonthToAdd(event.target.value)} data-testid="input-history-month-add" className="mt-1 h-10 min-w-0 flex-1 rounded-lg border border-[#e7e2ea] bg-white px-2.5 text-xs text-[#443d50] outline-none focus:border-[#9477bf]" /><button type="button" onClick={() => setHistoryMonths((items) => [...new Set([...items, historyMonthToAdd])].sort())} disabled={!historyMonthToAdd || historyMonths.includes(historyMonthToAdd)} className="mt-1 h-10 shrink-0 rounded-lg bg-[#7656b8] px-3 text-[10px] font-bold text-white disabled:opacity-50" data-testid="button-history-month-add">Adicionar</button></div>
                <div className="mt-2 flex flex-wrap gap-1.5" data-testid="list-history-months">{historyMonths.map((month) => <span key={month} className="inline-flex items-center gap-1 rounded-full bg-[#eee8f7] py-1 pl-2.5 pr-1 text-[10px] font-semibold text-[#5d4a78]">{formatMonthKey(month)}<button type="button" onClick={() => setHistoryMonths((items) => items.filter((item) => item !== month))} aria-label={`Remover ${formatMonthKey(month)}`} className="grid h-5 w-5 place-items-center rounded-full hover:bg-white">×</button></span>)}</div>
              </div>}
              {(historyPeriodMode === 'quarter' || historyPeriodMode === 'year') && <div className={`col-span-2 grid gap-2 ${historyPeriodMode === 'quarter' ? 'grid-cols-2' : 'grid-cols-1'}`}>
                <label className="text-[10px] font-semibold text-[#817b89]">Ano<input type="number" min="1000" max="9999" value={historyYear} onChange={(event) => setHistoryYear(event.target.value)} data-testid="input-history-year" className="mt-1 h-10 w-full rounded-lg border border-[#e7e2ea] bg-white px-2.5 text-xs text-[#443d50] outline-none focus:border-[#9477bf]" /></label>
                {historyPeriodMode === 'quarter' && <label className="text-[10px] font-semibold text-[#817b89]">Trimestre<select value={historyQuarter} onChange={(event) => setHistoryQuarter(event.target.value)} data-testid="select-history-quarter" className="mt-1 h-10 w-full rounded-lg border border-[#e7e2ea] bg-white px-2.5 text-xs text-[#443d50] outline-none focus:border-[#9477bf]"><option value="1">1º trimestre</option><option value="2">2º trimestre</option><option value="3">3º trimestre</option><option value="4">4º trimestre</option></select></label>}
              </div>}
              {historyPeriodMode === 'range' && <>
                <label className="min-w-0 text-[10px] font-semibold text-[#817b89]">Data inicial<input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} data-testid="filter-sale-from" className="mt-1 h-10 w-full min-w-0 rounded-lg border border-[#e7e2ea] bg-white px-2.5 text-xs text-[#443d50] outline-none focus:border-[#9477bf]" /></label>
                <label className="min-w-0 text-[10px] font-semibold text-[#817b89]">Data final<input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} data-testid="filter-sale-to" className="mt-1 h-10 w-full min-w-0 rounded-lg border border-[#e7e2ea] bg-white px-2.5 text-xs text-[#443d50] outline-none focus:border-[#9477bf]" /></label>
              </>}
              <label className="col-span-2 min-w-0 text-[10px] font-semibold text-[#817b89]">Plano ou produto
                <PurpleSelect
                  value={filterProduct ? `product:${encodeURIComponent(filterProduct)}` : 'all-products'}
                  onValueChange={(value) => setFilterProduct(value === 'all-products' ? '' : decodeURIComponent(value.slice('product:'.length)))}
                  testId="filter-sale-product"
                  className="mt-1 rounded-lg bg-white px-2.5"
                  options={[
                    { value: 'all-products', label: 'Todos os produtos' },
                    ...productNames.map((product) => ({ value: `product:${encodeURIComponent(product)}`, label: product })),
                  ]}
                />
              </label>
              <label className="col-span-2 min-w-0 text-[10px] font-semibold text-[#817b89]">Situação
                <select value={filterStatus} onChange={(event) => setFilterStatus(event.target.value as typeof filterStatus)} data-testid="filter-sale-status" className="mt-1 h-10 w-full rounded-lg border border-[#e7e2ea] bg-white px-2.5 text-xs text-[#443d50] outline-none focus:border-[#9477bf]">
                  <option value="all">Todas as situações</option>
                  <option value="active">Ativas</option>
                  <option value="cancelled">Canceladas</option>
                </select>
              </label>
              <label className="col-span-2 min-w-0 text-[10px] font-semibold text-[#817b89]">Situação cadastral
                <select value={filterCadastroStatus} onChange={(event) => setFilterCadastroStatus(event.target.value as typeof filterCadastroStatus)} data-testid="filter-sale-cadastro-status" className="mt-1 h-10 w-full rounded-lg border border-[#e7e2ea] bg-white px-2.5 text-xs text-[#443d50] outline-none focus:border-[#9477bf]">
                  <option value="all">Todas as informações</option>
                  <option value="needs-review">Pendentes de verificação</option>
                  <option value="complete">Conferidas</option>
                </select>
              </label>
              <fieldset className="col-span-2 border-t border-[#e8e4eb] pt-2">
                <legend className="text-[10px] font-semibold text-[#817b89]">Dia da semana da venda</legend>
                <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="filters-history-weekdays">{[1, 2, 3, 4, 5, 6, 7].map((weekday) => {
                  const selected = historyWeekdays.includes(weekday);
                  return <label key={weekday} className={`inline-flex cursor-pointer items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-bold ${selected ? 'border-[#7656b8] bg-[#eee8f7] text-[#5d4a78]' : 'border-[#e7e2ea] bg-white text-[#746c7e]'}`}><input type="checkbox" checked={selected} onChange={() => setHistoryWeekdays((items) => selected ? items.filter((item) => item !== weekday) : [...items, weekday].sort())} className="accent-[#7656b8]" data-testid={`filter-history-weekday-${weekday}`} />{getWeekdayNameForIsoDay(weekday)}</label>;
                })}</div>
              </fieldset>
              <button type="button" onClick={() => { setHistoryPeriodMode('all'); setFromDate(''); setToDate(''); setHistoryWeekdays([]); setFilterProduct(''); setFilterStatus('all'); setFilterCadastroStatus('all'); }} className="col-span-2 justify-self-start rounded-lg px-2 py-1.5 text-[10px] font-semibold text-[#766d83] hover:bg-white" data-testid="button-clear-history-filters">Limpar filtros</button>
            </div>
            {invalidHistoryRange && <p className="mt-2 text-[10px] font-semibold text-[#a24f45]" role="alert" data-testid="status-history-date-range">{!fromDate || !toDate ? 'Informe as datas inicial e final.' : 'A data inicial deve ser anterior ou igual à data final.'}</p>}
            {invalidHistoryYear && <p className="mt-2 text-[10px] font-semibold text-[#a24f45]" role="alert" data-testid="status-history-year">Informe um ano válido entre 1000 e 9999.</p>}
          </div>
          <section className="mb-4 rounded-2xl border border-[#ead8b6] bg-[#fffaf0] p-3.5" data-testid="panel-sales-pending-drafts" aria-label="Pendências de vendas">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-extrabold text-[#6f5422]">Pendências de verificação</p>
                <p className="mt-1 text-[10px] leading-4 text-[#826c43]">
                  {visiblePendingDrafts.length} rascunho(s) sem data ou valor suficiente. Não entram no Scoreboard até serem completados.
                </p>
                <p className="mt-1 text-[9px] leading-4 text-[#8a744f]">Rascunhos sem data permanecem visíveis mesmo com filtro de período, pois não podem ser atribuídos a um mês.</p>
              </div>
              <button type="button" onClick={() => void refetchPendingDrafts()} disabled={isPendingDraftsLoading} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#e8d6b1] bg-white px-3 text-[10px] font-bold text-[#755b2b] disabled:opacity-50" data-testid="button-refresh-sales-pending"><RefreshCw size={12} /> Atualizar</button>
            </div>
            {isPendingDraftsLoading
              ? <p className="mt-3 text-[10px] text-[#826c43]" role="status">Carregando pendências…</p>
              : isPendingDraftsError
                ? <p className="mt-3 text-[10px] font-semibold text-[#9c483f]" role="alert">Não foi possível carregar as pendências. Tente atualizar.</p>
                : visiblePendingDrafts.length
                  ? <div className="mt-3 space-y-2">
                    {visiblePendingDrafts.map((draft) => <article key={draft.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#f0e3cc] bg-white px-3 py-2.5" data-testid={`row-sales-pending-${draft.id}`}>
                      <div className="min-w-0">
                        <p className="break-words text-xs font-bold text-[#4c3e26]">{draft.customerName || 'Cliente não informado'} · {draft.productName || 'Produto não informado'}</p>
                        <p className="mt-1 text-[10px] text-[#817b89]">
                          {draft.sourceSheet ? `${draft.sourceSheet} · linha ${draft.sourceRow}` : 'Lançamento manual'}
                          {' · '}{draft.saleDate?.slice(0, 10) || draft.saleDateText || 'Data ausente'}
                          {' · '}{draft.totalCents !== null ? formatCents(draft.totalCents) : draft.amountText || 'Valor ausente'}
                        </p>
                        <p className="mt-1 text-[9px] font-semibold text-[#9b6a26]">
                          Falta: {draft.missingFields.map((field) => field === 'saleDate' ? 'data da venda' : 'valor').join(' e ') || 'corrigir informações opcionais'}
                        </p>
                      </div>
                      <button type="button" onClick={() => setEditingPendingDraft(draft)} disabled={busy} className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-[#7656b8] px-3 text-[10px] font-bold text-white hover:bg-[#6848a9] disabled:opacity-50" data-testid={`button-edit-sales-pending-${draft.id}`}><Edit3 size={12} /> Completar</button>
                    </article>)}
                  </div>
                  : <p className="mt-3 text-[10px] text-[#826c43]" data-testid="status-sales-pending-empty">{filterCadastroStatus === 'complete' ? 'O filtro cadastral mostra somente registros conferidos.' : 'Nenhuma pendência financeira para completar neste filtro.'}</p>}
          </section>
          {isHistoryLoading ? <div className="space-y-3" aria-label="Carregando histórico" data-testid="status-sales-loading"><div className="skeleton h-16 rounded-2xl" /><div className="skeleton h-16 rounded-2xl" /><div className="skeleton h-16 rounded-2xl" /></div>
            : isHistoryError ? <div className="grid min-h-[220px] place-items-center rounded-2xl border border-dashed border-[#e6e1ea] bg-[#fbfafc] p-6 text-center" data-testid="status-sales-error"><div><CircleHelp className="mx-auto text-[#a6584b]" size={23} /><p className="mt-3 font-bold">Não foi possível carregar</p><p className="mt-1 text-sm text-[#827b8b]">Confira sua conexão e tente novamente.</p><button onClick={() => void refetchHistory()} className="mt-4 inline-flex items-center gap-2 rounded-full border border-[#ded8e5] bg-white px-4 py-2 text-xs font-bold text-[#5c506f] hover:bg-[#f8f6fa]" data-testid="button-retry-sales"><RefreshCw size={13} /> Tentar novamente</button></div></div>
            : filteredSales.length ? <div className="space-y-2" data-testid="list-sales">
              {filteredSales.map((sale) => <SaleRow key={sale.id} sale={sale} onEdit={() => startEditing(sale)} onHistory={() => setHistorySale(sale)} onCancel={() => { setFeedback(null); setCancellationError(''); setCancellationConflict(false); setCancellationReason(''); setCancelling(sale); }} busy={busy} />)}
              <p className="px-1 pt-2 text-[10px] font-medium text-[#938c99]" data-testid="text-sales-count">{filteredSales.length} {filteredSales.length === 1 ? 'lançamento' : 'lançamentos'} exibidos</p>
            </div> : <div className="grid min-h-[220px] place-items-center rounded-2xl border border-dashed border-[#e6e1ea] bg-[#fbfafc] p-6 text-center" data-testid="status-sales-empty"><div><div className="mx-auto grid h-12 w-12 place-items-center rounded-[17px] bg-[#f0ebf7] text-[#7656b8]"><ClipboardList size={21} /></div><h3 className="mt-4 font-bold tracking-[-.02em]">{(historySales?.length ?? 0) ? 'Nenhuma venda neste filtro' : 'Seu histórico começa aqui'}</h3><p className="mx-auto mt-1.5 max-w-[270px] text-xs leading-5 text-[#85808e]">{(historySales?.length ?? 0) ? 'Ajuste as datas, o produto ou a situação para encontrar lançamentos.' : 'Registre a primeira venda para acompanhar tudo por aqui.'}</p></div></div>}
          </div>
        </details>
      </section>
      <section className="mt-5 rounded-[24px] border border-[#e9e4ec] bg-white p-5 shadow-[0_7px_28px_rgba(47,38,63,.035)] md:p-6" aria-labelledby="refund-history-title" data-testid="panel-refund-history">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div><p className="eyebrow text-[9px] font-bold text-[#8b8494]">movimentações financeiras</p><h2 id="refund-history-title" className="mt-1 text-lg font-bold tracking-[-.035em]">Histórico de estornos</h2></div>
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#fff1ed] text-[#a84940]"><RotateCcw size={16} /></span>
        </div>
        {isRefundsLoading ? <div className="space-y-2" aria-label="Carregando estornos" data-testid="status-refunds-loading"><div className="skeleton h-16 rounded-xl" /><div className="skeleton h-16 rounded-xl" /></div>
          : isRefundsError ? <div className="rounded-xl border border-dashed border-[#ded7e7] p-4 text-center text-xs text-[#817b89]" role="alert" data-testid="status-refunds-error"><p>Não foi possível carregar o histórico de estornos.</p><button type="button" onClick={() => void refetchRefunds()} className="mt-2 font-bold text-[#6848a9] underline" data-testid="button-retry-refunds">Tentar novamente</button></div>
            : refunds?.length ? <ol className="space-y-2" data-testid="list-refunds">
              {refunds.map((refund) => {
                const totalRefunded = activeRefundTotalsBySale.get(refund.saleId) ?? 0n;
                const refundType = refund.status === 'voided'
                  ? 'Estorno anulado'
                  : totalRefunded === BigInt(refund.totalCents) ? 'Estorno total' : 'Estorno parcial';
                return <li key={refund.id} className="grid gap-2 rounded-xl border border-[#f0edf2] px-3.5 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start" data-testid={`row-refund-${refund.id}`}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-bold text-[#353044]">{refund.productName}</p>
                      <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold ${refund.status === 'voided' ? 'bg-[#f2eff1] text-[#79727d]' : refundType === 'Estorno total' ? 'bg-[#fff0ed] text-[#9c483f]' : 'bg-[#fff8e8] text-[#846829]'}`} data-testid={`text-refund-status-${refund.id}`}>{refundType}</span>
                    </div>
                    <p className="mt-1 text-[10px] text-[#817b89]">Venda de {formatDate(refund.saleDate)} · original {formatCents(refund.totalCents)} · estorno em {formatDate(refund.refundDate)}</p>
                    <p className="mt-1 text-[11px] leading-5 text-[#625a6d]">Motivo: {refund.reason}</p>
                    {refund.status === 'voided' && refund.voidReason && <p className="mt-1 text-[10px] text-[#9a625b]">Anulação: {refund.voidReason}</p>}
                  </div>
                  <strong className={`text-sm tabular-nums sm:text-right ${refund.status === 'voided' ? 'text-[#817b89] line-through' : 'text-[#9c483f]'}`} data-testid={`text-refund-amount-${refund.id}`}>{formatCents(refund.amountCents)}</strong>
                </li>;
              })}
            </ol> : <p className="rounded-xl border border-dashed border-[#ded7e7] px-3.5 py-5 text-center text-xs text-[#817b89]" data-testid="status-refunds-empty">Ainda não há estornos registrados.</p>}
      </section>
      <div className="mt-5 flex items-center gap-3 rounded-2xl border border-[#e7e3e8] bg-[#f1eef3] px-4 py-3.5 text-xs text-[#746d7b]">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-white text-[#7656b8]"><CalendarDays size={15} /></span>
        <span>Registros compartilhados com a equipe autorizada.</span><span className="ml-auto hidden text-[10px] font-semibold text-[#9993a0] md:block">DADOS ATUALIZADOS</span>
      </div>
      <Dialog open={backupDialogOpen} onOpenChange={(open) => { if (!isGeneratingBackup && !isExporting) setBackupDialogOpen(open); }}>
        <DialogContent className="max-h-[92dvh] max-w-xl overflow-y-auto border-[#e7e1e9] bg-[#fffefc] p-5 sm:rounded-[24px] sm:p-6">
          <DialogHeader className="text-left">
            <DialogTitle className="text-lg font-extrabold tracking-[-.035em] text-[#332d40]">Relatórios e backups</DialogTitle>
            <DialogDescription className="text-xs leading-5 text-[#827b8b]">
              Escolha um período independente dos filtros da Scoreboard. Relatórios somam vendas pela data da venda e estornos pela data efetiva.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 rounded-xl bg-[#f2eef8] p-1">
              <button type="button" onClick={() => { setPeriodDialogMode('report'); setPeriodBackupPreview(null); }} className={`rounded-lg px-3 py-2 text-xs font-bold transition ${periodDialogMode === 'report' ? 'bg-white text-[#6848a9] shadow-sm' : 'text-[#817b89]'}`} data-testid="tab-period-report">Relatório Excel / CSV</button>
              <button type="button" onClick={() => setPeriodDialogMode('backup')} className={`rounded-lg px-3 py-2 text-xs font-bold transition ${periodDialogMode === 'backup' ? 'bg-white text-[#6848a9] shadow-sm' : 'text-[#817b89]'}`} data-testid="tab-period-backup">Backup JSON</button>
            </div>

            <div>
              <p className="mb-2 text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Período</p>
              <div className="flex flex-wrap gap-1.5">
                {[
                  { value: 'months', label: 'Mês ou meses' },
                  { value: 'range', label: 'Intervalo de datas' },
                  { value: 'all', label: 'Todo o histórico' },
                ].map((item) => <button key={item.value} type="button" onClick={() => {
                  if (item.value === 'months') updatePeriodSelection({ mode: 'months', months: periodSelection.mode === 'months' ? periodSelection.months ?? [] : [periodMonthDraft], productName: periodSelection.productName ?? null });
                  else if (item.value === 'range') updatePeriodSelection({ mode: 'range', fromDate: periodSelection.mode === 'range' ? periodSelection.fromDate : todayLocal(), toDate: periodSelection.mode === 'range' ? periodSelection.toDate : todayLocal(), productName: periodSelection.productName ?? null });
                  else updatePeriodSelection({ mode: 'all', productName: periodSelection.productName ?? null });
                }} className={`rounded-lg border px-3 py-2 text-[11px] font-bold transition ${periodSelection.mode === item.value ? 'border-[#7656b8] bg-[#7656b8] text-white' : 'border-[#e5dfeb] bg-white text-[#655b71] hover:bg-[#f8f6fb]'}`} data-testid={`button-period-mode-${item.value}`}>{item.label}</button>)}
              </div>
            </div>

            {periodSelection.mode === 'months' && <div className="space-y-2">
              <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2 rounded-xl border border-[#e9e2f1] bg-[#faf8fd] p-2.5">
                <label className="min-w-0 text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Ano
                  <input type="number" min="1000" max="9999" value={periodQuarterYear} onChange={(event) => setPeriodQuarterYear(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-[#e7e2ea] bg-white px-2 text-xs normal-case tracking-normal text-[#342d43]" data-testid="input-report-quarter-year" />
                </label>
                <label className="min-w-0 text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Trimestre
                  <select value={periodQuarter} onChange={(event) => setPeriodQuarter(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-[#e7e2ea] bg-white px-2 text-xs normal-case tracking-normal text-[#342d43]" data-testid="select-report-quarter">
                    <option value="1">1º trimestre</option><option value="2">2º trimestre</option><option value="3">3º trimestre</option><option value="4">4º trimestre</option>
                  </select>
                </label>
                <button type="button" onClick={() => {
                  const firstMonth = (Number(periodQuarter) - 1) * 3 + 1;
                  const months = [0, 1, 2].map((offset) => `${periodQuarterYear}-${String(firstMonth + offset).padStart(2, '0')}`);
                  updatePeriodSelection({ mode: 'months', months, productName: periodSelection.productName ?? null, cadastralStatus: periodSelection.cadastralStatus ?? 'all' });
                }} disabled={!/^\d{4}$/.test(periodQuarterYear) || Number(periodQuarterYear) < 1000 || Number(periodQuarterYear) > 9999} className="h-9 rounded-lg bg-[#7656b8] px-3 text-[10px] font-bold text-white disabled:opacity-50" data-testid="button-apply-report-quarter">Aplicar</button>
              </div>
              <div className="flex gap-2">
                <label className="min-w-0 flex-1 text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Adicionar mês
                  <input type="month" value={periodMonthDraft} onChange={(event) => setPeriodMonthDraft(event.target.value)} data-testid="input-report-month" className="mt-1 h-10 w-full rounded-xl border border-[#e7e2ea] bg-[#fcfbfd] px-3 text-sm font-medium normal-case tracking-normal text-[#342d43] outline-none focus:border-[#9477bf]" />
                </label>
                <button type="button" onClick={() => {
                  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodMonthDraft)) return;
                  const months = [...new Set([...(periodSelection.months ?? []), periodMonthDraft])].sort();
                  updatePeriodSelection({ mode: 'months', months, productName: periodSelection.productName ?? null });
                }} className="mt-5 h-10 rounded-xl border border-[#dcd1eb] bg-[#f5f0fb] px-3 text-xs font-bold text-[#6848a9] transition hover:bg-[#eee6f8]" data-testid="button-add-report-month">Adicionar</button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(periodSelection.months ?? []).map((month) => <button key={month} type="button" onClick={() => updatePeriodSelection({ mode: 'months', months: (periodSelection.months ?? []).filter((item) => item !== month), productName: periodSelection.productName ?? null })} className="inline-flex items-center gap-1 rounded-full bg-[#7656b8] px-2.5 py-1 text-[10px] font-bold text-white" aria-label={`Remover mês ${month}`}>{formatMonthKey(month)} <X size={11} /></button>)}
                {!periodSelection.months?.length && <span className="text-[11px] text-[#9c483f]">Adicione ao menos um mês.</span>}
              </div>
            </div>}

            {periodSelection.mode === 'range' && <div className="grid grid-cols-2 gap-2">
              <label className="text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Data inicial
                <input type="date" value={periodSelection.fromDate ?? ''} onChange={(event) => updatePeriodSelection({ mode: 'range', fromDate: event.target.value, toDate: periodSelection.toDate, productName: periodSelection.productName ?? null })} className="mt-1 h-10 w-full rounded-xl border border-[#e7e2ea] bg-[#fcfbfd] px-3 text-sm text-[#342d43] outline-none focus:border-[#9477bf]" data-testid="input-report-from-date" />
              </label>
              <label className="text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Data final
                <input type="date" value={periodSelection.toDate ?? ''} onChange={(event) => updatePeriodSelection({ mode: 'range', fromDate: periodSelection.fromDate, toDate: event.target.value, productName: periodSelection.productName ?? null })} className="mt-1 h-10 w-full rounded-xl border border-[#e7e2ea] bg-[#fcfbfd] px-3 text-sm text-[#342d43] outline-none focus:border-[#9477bf]" data-testid="input-report-to-date" />
              </label>
              <p className="col-span-2 text-[10px] text-[#827b8b]">As duas datas são incluídas no intervalo.</p>
            </div>}

            {periodSelection.mode === 'all' && <p className="rounded-xl bg-[#f8f6f9] px-3 py-2.5 text-[11px] leading-5 text-[#716a79]">Todo o histórico está selecionado explicitamente.</p>}

            <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Plano / produto
              <select value={periodSelection.productName ?? ''} onChange={(event) => updatePeriodSelection({ ...periodSelection, productName: event.target.value || null })} data-testid="select-report-product" className="mt-1 h-10 w-full rounded-xl border border-[#e7e2ea] bg-[#fcfbfd] px-3 text-sm font-medium normal-case tracking-normal text-[#342d43] outline-none focus:border-[#7656b8] focus:ring-2 focus:ring-[#7656b8]/10">
                <option value="">Todos os planos</option>
                {productNames.map((name) => <option key={productNameKey(name)} value={name}>{name}</option>)}
              </select>
            </label>
            <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Situação cadastral
              <select value={periodSelection.cadastralStatus ?? 'all'} onChange={(event) => updatePeriodSelection({ ...periodSelection, cadastralStatus: event.target.value as 'all' | 'needs-review' | 'complete' })} data-testid="select-report-cadastro-status" className="mt-1 h-10 w-full rounded-xl border border-[#e7e2ea] bg-[#fcfbfd] px-3 text-sm font-medium normal-case tracking-normal text-[#342d43] outline-none focus:border-[#7656b8] focus:ring-2 focus:ring-[#7656b8]/10">
                <option value="all">Todas as informações</option>
                <option value="needs-review">Pendentes de verificação</option>
                <option value="complete">Conferidas</option>
              </select>
            </label>
            <p className="rounded-xl bg-[#f8f6f9] px-3 py-2 text-[10px] leading-4 text-[#716a79]">Rascunhos aparecem separados e ficam fora dos totais financeiros. Sem data válida, só podem ser atribuídos a “Todo o histórico”. Backups preservam as vendas e dependências do filtro escolhido.</p>

            {periodDialogMode === 'report' ? <div className="space-y-3">
              <div className="rounded-xl border border-[#e8e2ed] bg-white p-3.5" data-testid="panel-period-report-preview">
                <p className="text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Prévia do relatório</p>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {[
                    ['Faturamento', formatCents(Number(periodReportSummary.salesCents))],
                    ['Estornos', formatCents(Number(periodReportSummary.refundsCents))],
                    ['Líquido', formatCents(Number(periodReportSummary.netCents))],
                    ['Quantidade', periodReportSummary.quantity.toString()],
                  ].map(([label, value]) => <div key={label} className="rounded-lg bg-[#f8f6f9] px-2.5 py-2">
                    <p className="text-[9px] font-bold text-[#817b89]">{label}</p>
                    <p className="mt-1 text-xs font-extrabold tabular-nums text-[#40374e]" data-testid={`text-period-preview-${label.toLowerCase()}`}>{value}</p>
                  </div>)}
                </div>
                <p className="mt-2 text-[10px] text-[#827b8b]">{periodReportSummary.salesCount} vendas válidas · {periodReportSummary.refundsCount} estornos válidos · {periodReportVerificationCount} venda(s) com pendência cadastral · {periodReportPendingCount} rascunho(s) financeiros{periodReportSnapshot ? ` · atualizado ${periodReportSnapshot.refreshedAt}` : ''}</p>
              </div>
              {isExporting && <p className="text-[10px] text-[#827b8b]" role="status">Atualizando a prévia para exportar…</p>}
            </div> : <div className="space-y-3">
              <div className="flex items-center justify-between gap-3 rounded-xl bg-[#f8f6f9] px-3.5 py-3">
                <span className="text-[11px] leading-5 text-[#716a79]">Prévia conferida no servidor, incluindo vendas e estornos necessários para validar os vínculos.</span>
                <button type="button" onClick={() => void generatePeriodBackupPreview()} disabled={!validPeriodSelection || isGeneratingBackup} className="shrink-0 rounded-lg border border-[#dcd1eb] bg-white px-3 py-2 text-[10px] font-bold text-[#6848a9] disabled:opacity-50" data-testid="button-preview-period-backup">{isGeneratingBackup ? 'Conferindo…' : periodBackupPreview ? 'Atualizar prévia' : 'Gerar prévia'}</button>
              </div>
              {periodBackupPreview && <div className="rounded-xl border border-[#e8e2ed] bg-white p-3.5" data-testid="panel-period-backup-preview">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div><p className="text-sm font-extrabold text-[#40374e]">{periodBackupPreview.period}</p><p className="mt-1 text-[10px] text-[#827b8b]">Gerado {formatGeneratedAt(periodBackupPreview.generatedAt)} · {periodBackupPreview.counts.totalRecords} registros</p></div>
                  <span className="rounded-full bg-[#f2eef8] px-2.5 py-1 text-[9px] font-bold text-[#6848a9]">{periodBackupPreview.partial ? 'Cópia parcial' : 'Histórico completo'}</span>
                </div>
                <p className="mt-2 text-[11px] leading-5 text-[#625a6d]">Vendas {formatCents(periodBackupPreview.totals.salesCents)} · estornos {formatCents(periodBackupPreview.totals.refundsCents)} · líquido {formatCents(periodBackupPreview.totals.netCents)} · quantidade {periodBackupPreview.totals.quantity}</p>
                <p className="mt-1 text-[10px] text-[#827b8b]">{periodBackupPreview.counts.periodSales} vendas · {periodBackupPreview.counts.periodRefunds} estornos · {periodBackupPreview.counts.periodGoals} metas · {periodBackupPreview.counts.dependencySales + periodBackupPreview.counts.dependencyRefunds} dependências</p>
                {periodBackupPreview.counts.periodSales === 0 && periodBackupPreview.counts.periodRefunds === 0 && <p className="mt-2 rounded-lg border border-dashed border-[#ded7e7] px-3 py-2 text-[10px] text-[#716a79]">Sem movimentações no período. O arquivo preservará metas existentes sem criar vendas fictícias.</p>}
              </div>}
            </div>}
            {exportError && <p className="rounded-xl bg-[#fff0ed] px-3.5 py-2.5 text-xs font-semibold text-[#9c483f]" role="alert" data-testid="status-period-export-error">{exportError}</p>}
            {backupError && <p className="rounded-xl bg-[#fff0ed] px-3.5 py-2.5 text-xs font-semibold text-[#9c483f]" role="alert" data-testid="status-monthly-backup-error">{backupError}</p>}
          </div>
          <DialogFooter className="gap-2 sm:flex-row">
            <button type="button" onClick={() => setBackupDialogOpen(false)} disabled={isGeneratingBackup || isExporting} className="h-10 rounded-xl border border-[#e3dfe7] px-4 text-sm font-bold text-[#716a79] transition hover:bg-[#f8f6fa] disabled:opacity-50">Fechar</button>
            {periodDialogMode === 'report' ? <>
              <button type="button" onClick={() => void exportPeriodReport('csv')} disabled={!validPeriodSelection || isExporting} className="h-10 rounded-xl border border-[#dcd1eb] bg-white px-4 text-sm font-bold text-[#6848a9] disabled:opacity-50" data-testid="button-export-period-csv">Baixar CSV</button>
              <button type="button" onClick={() => void exportPeriodReport('xlsx')} disabled={!validPeriodSelection || isExporting} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#7656b8] px-4 text-sm font-bold text-white transition hover:bg-[#6848a9] disabled:cursor-wait disabled:opacity-60" data-testid="button-export-period-xlsx">{isExporting ? 'Atualizando…' : 'Baixar Excel'}</button>
            </> : <button type="button" onClick={periodBackupPreview ? downloadPeriodBackupPreview : () => void generatePeriodBackupPreview()} disabled={!validPeriodSelection || isGeneratingBackup || (!periodBackupPreview && !validPeriodSelection)} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#7656b8] px-4 text-sm font-bold text-white transition hover:bg-[#6848a9] disabled:cursor-wait disabled:opacity-60" data-testid="button-generate-monthly-backup">
              {isGeneratingBackup ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Download size={14} />}
              {isGeneratingBackup ? 'Conferindo…' : periodBackupPreview ? 'Baixar backup JSON' : 'Gerar prévia do backup'}
            </button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={restoreDialogOpen}
        onOpenChange={(open) => {
          if (!restoreBackup.isPending && !isPreviewingRestore) setRestoreDialogOpen(open);
        }}
      >
        <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto border-[#e7e1e9] bg-[#fffefc] p-6 sm:rounded-[24px]">
          <DialogHeader className="text-left">
            <DialogTitle className="text-lg font-extrabold tracking-[-.035em] text-[#332d40]">Restaurar backup financeiro</DialogTitle>
            <DialogDescription className="text-xs leading-5 text-[#827b8b]">
              Registros idênticos são ignorados. Se o mesmo ID tiver conteúdo diferente, o atual será mantido. Nada é apagado; a aplicação é atômica e uma cópia privada do estado anterior é guardada no servidor.
            </DialogDescription>
          </DialogHeader>
          {isPreviewingRestore && <p role="status" className="text-sm text-[#716a79]">Validando o arquivo e comparando os registros com a base…</p>}
          {restoreError && <p className="rounded-xl bg-[#fff0ed] px-3.5 py-2.5 text-xs font-semibold text-[#9c483f]" role="alert" data-testid="status-backup-restore-error">{restoreError}</p>}
          {restorePreview && !restoreResult && (
            <div className="space-y-3">
              <div className="rounded-xl bg-[#f8f6f9] px-3.5 py-3.5" data-testid="panel-backup-restore-preview">
                <p className="text-sm font-extrabold capitalize text-[#40374e]">{formatBackupPeriod(restorePreview.report.period)}</p>
                <p className="mt-1 text-[10px] text-[#827b8b]">Gerado em {formatGeneratedAt(restorePreview.backup.generatedAt)}</p>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold text-[#625a6d]">
                  <span data-testid="text-restore-preview-sales">{restorePreview.sales.length} vendas no arquivo</span>
                  <span data-testid="text-restore-preview-goals">{restorePreview.backup.goals.length} metas</span>
                </div>
                <p className="mt-2 text-[10px] leading-4 text-[#827b8b]">
                  {Object.values(restorePreview.report.toInsert).reduce((sum, count) => sum + count, 0)} registros novos · {Object.values(restorePreview.report.identical).reduce((sum, count) => sum + count, 0)} idênticos · {restorePreview.report.conflicts.length} conflitos.
                </p>
                <p className="mt-2 text-xs leading-5 text-[#625a6d]">No mês: vendas {formatCents(restorePreview.salesCents)} · estornos {formatCents(restorePreview.refundsCents)} · após estornos {formatCents(restorePreview.salesCents - restorePreview.refundsCents)}.</p>
                {restorePreview.report.dependencyMonths.length > 0 && <p className="mt-2 text-xs leading-5 text-[#7656b8]">Meses adicionais por dependência: {restorePreview.report.dependencyMonths.map(formatMonthKey).join(', ')}. As datas originais serão preservadas.</p>}
                {!('schemaVersion' in restorePreview.backup) && <p className="mt-2 text-xs text-[#85554e]">Formato legado: este arquivo não contém estornos nem o histórico completo. Apenas as informações presentes podem ser recuperadas.</p>}
              </div>
              {restorePreview.sales.length === 0
                ? <p className="rounded-xl border border-dashed border-[#ded7e7] px-3.5 py-3 text-xs text-[#716a79]" data-testid="status-restore-preview-empty">Este backup não contém lançamentos.</p>
                : <ul className="max-h-36 space-y-1.5 overflow-y-auto rounded-xl border border-[#eeeaf0] p-3 text-[11px] text-[#625a6d]" aria-label="Prévia dos lançamentos">
                  {restorePreview.sales.slice(0, 5).map((sale) => <li key={sale.id} className="flex justify-between gap-3"><span className="min-w-0 truncate">{formatDate(sale.saleDate)} · {sale.productName}{sale.scope === 'dependency' ? ' (dependência)' : ''}</span><span className="shrink-0 font-semibold tabular-nums">{formatCents(sale.totalCents)}</span></li>)}
                  {restorePreview.sales.length > 5 && <li className="pt-1 text-[#8a8491]">e mais {restorePreview.sales.length - 5} vendas…</li>}
                </ul>}
              {restorePreview.report.conflicts.length > 0 && <div className="rounded-xl border border-[#ecd9c9] bg-[#fff8ed] p-3 text-xs text-[#85554e]">
                <p className="font-bold">{restorePreview.report.blocked ? 'Restauração bloqueada por vínculos ou saldo.' : 'Conflitos: os registros atuais serão mantidos.'}</p>
                <ul className="mt-2 max-h-36 space-y-2 overflow-auto">{restorePreview.report.conflicts.map((conflict, index) => <li key={`${conflict.entityType}-${conflict.id}-${index}`}><span className="break-all font-semibold">{conflict.entityType} · {conflict.id}</span><br />{conflict.reason}</li>)}</ul>
              </div>}
                <p className="rounded-xl border border-[#e9e0c8] bg-[#fcf8ed] px-3.5 py-3 text-[10px] leading-5 text-[#725d2d]">
                 Ao confirmar, registros ausentes e dependências serão adicionados pelos IDs internos. Nada é apagado; IDs com conteúdo diferente permanecem como estão.
              </p>
            </div>
          )}
          {restoreResult && <div className="rounded-xl bg-[#eff6e5] px-3.5 py-3 text-xs leading-5 text-[#55772c]" role="status" data-testid="status-backup-restore-success">
            Backup de {formatBackupPeriod(restoreResult.period)} processado: {restoreResult.inserted.sales} vendas, {restoreResult.inserted.refunds} estornos, {restoreResult.inserted.goals} metas, {restoreResult.inserted.products} produtos e {restoreResult.inserted.histories} registros de histórico adicionados. {Object.values(restoreResult.identical).reduce((sum, count) => sum + count, 0)} idênticos ignorados; {restoreResult.conflicts.length} conflitos mantiveram os dados atuais.
          </div>}
          <DialogFooter className="gap-2">
            <button type="button" onClick={() => setRestoreDialogOpen(false)} disabled={restoreBackup.isPending} className="h-10 rounded-xl border border-[#e3dfe7] px-4 text-sm font-bold text-[#716a79] transition hover:bg-[#f8f6fa] disabled:opacity-50" data-testid="button-cancel-backup-restore">{restoreResult ? 'Concluir' : 'Cancelar'}</button>
            {!restoreResult && <button type="button" onClick={() => void confirmBackupRestore()} disabled={!restorePreview || restorePreview.report.blocked || restoreBackup.isPending || isPreviewingRestore} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#7656b8] px-4 text-sm font-bold text-white transition hover:bg-[#6848a9] disabled:cursor-wait disabled:opacity-60" data-testid="button-confirm-backup-restore">
              {restoreBackup.isPending && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
              {restoreBackup.isPending ? 'Restaurando…' : 'Confirmar restauração'}
            </button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={productsOpen} onOpenChange={(open) => { if (!(createProduct.isPending || updateProduct.isPending || deactivatingProduct)) setProductsOpen(open); }}>
        <DialogContent className="max-w-3xl border-[#e7e1e9] bg-[#fffefc] p-5 sm:rounded-[24px] md:p-6">
          <DialogHeader className="text-left">
            <DialogTitle className="text-lg font-extrabold tracking-[-.035em] text-[#332d40]">Produtos</DialogTitle>
            <DialogDescription className="text-xs leading-5 text-[#827b8b]">Nome e preço sugerido não alteram vendas já registradas. O vínculo de modalidade também classifica o histórico financeiro deste produto.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-5 md:grid-cols-[1fr_1fr]">
            <section className="min-w-0">
              <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Buscar produto
                <div className="relative mt-1.5">
                  <Search size={15} className="absolute left-3 top-3 text-[#9891a0]" />
                  <input value={productSearch} onChange={(event) => setProductSearch(event.target.value)} placeholder="Nome do produto" data-testid="input-search-products" className="h-11 w-full rounded-xl border border-[#e7e2ea] bg-[#fcfbfd] pl-9 pr-3 text-sm text-[#342d43] outline-none focus:border-[#9477bf]" />
                </div>
              </label>
              <div className="mt-3 max-h-[330px] space-y-2 overflow-y-auto pr-1">
                {isProductsLoading ? <div className="space-y-2" data-testid="status-products-loading"><div className="skeleton h-14 rounded-xl" /><div className="skeleton h-14 rounded-xl" /></div>
                  : isProductsError ? <div className="rounded-xl border border-dashed border-[#ded7e7] p-4 text-center text-xs text-[#817b89]" data-testid="status-products-error"><p>Não foi possível carregar os produtos.</p><button type="button" onClick={() => void refetchProducts()} className="mt-2 font-bold text-[#6848a9] underline" data-testid="button-retry-products">Tentar novamente</button></div>
                    : visibleProducts.length ? visibleProducts.map((product) => <article key={product.id} className="flex items-center gap-3 rounded-xl border border-[#eeeaf0] px-3 py-2.5" data-testid={`row-product-${product.id}`}>
                      <span className={`h-2 w-2 shrink-0 rounded-full ${product.isActive ? 'bg-[#8ab83f]' : 'bg-[#aaa4af]'}`} aria-label={product.isActive ? 'Ativo' : 'Inativo'} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-bold text-[#40374e]" data-testid={`text-product-name-${product.id}`}>{product.name}</p>
                        <p className="mt-0.5 text-[10px] text-[#8a8491]">{formatCents(product.suggestedPriceCents)} · {product.isActive ? 'Ativo' : 'Inativo'} · {product.modalityId ? occupancyModalities?.find((modality) => modality.id === product.modalityId)?.name ?? 'Modalidade não encontrada' : 'Não classificado'}</p>
                      </div>
                      <button type="button" onClick={() => editProduct(product)} aria-label={`Editar produto ${product.name}`} className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-[#776b88] hover:bg-[#f1edf7] hover:text-[#6848a9]" data-testid={`button-edit-product-${product.id}`}><Edit3 size={15} /></button>
                      {product.isActive && <button type="button" onClick={() => { setDeactivatingProduct(product); setDeactivationError(''); setProductFeedback(null); }} aria-label={`Inativar produto ${product.name}`} title="Inativar produto" disabled={busy} className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-[#a0584f] hover:bg-[#fff0ed] disabled:opacity-50" data-testid={`button-deactivate-product-${product.id}`}><Power size={15} /></button>}
                    </article>) : <div className="rounded-xl border border-dashed border-[#ded7e7] p-5 text-center text-xs text-[#817b89]" data-testid="status-products-empty">{products.length ? 'Nenhum produto encontrado.' : 'Nenhum produto cadastrado ainda.'}</div>}
              </div>
            </section>
            <section className="rounded-2xl bg-[#f8f6fa] p-4">
              <h3 className="text-sm font-bold text-[#40374e]">{editingProduct ? 'Editar produto' : 'Cadastrar produto'}</h3>
              <Form {...productForm}>
                <form onSubmit={productForm.handleSubmit(saveProduct)} className="mt-3 space-y-3">
                  <FormField name="name" render={({ field }) => <FormItem className="space-y-1.5"><FormLabel className="text-[11px] font-bold text-[#665f70]">Nome do produto</FormLabel><FormControl><input {...field} maxLength={120} placeholder="Ex.: Plano Essencial" data-testid="input-product-name" className="h-11 w-full rounded-xl border border-[#e7e2ea] bg-white px-3.5 text-sm text-[#342d43] outline-none focus:border-[#9477bf]" /></FormControl><FormMessage className="text-[11px]" /></FormItem>} />
                  <FormField name="suggestedPrice" render={({ field }) => <FormItem className="space-y-1.5"><FormLabel className="text-[11px] font-bold text-[#665f70]">Preço sugerido</FormLabel><FormControl><input {...field} inputMode="decimal" placeholder="0,00" data-testid="input-product-suggested-price" className="h-11 w-full rounded-xl border border-[#e7e2ea] bg-white px-3.5 text-sm text-[#342d43] outline-none focus:border-[#9477bf]" /></FormControl><FormMessage className="text-[11px]" /></FormItem>} />
                  <FormField name="modalityId" render={({ field }) => <FormItem className="space-y-1.5"><FormLabel className="text-[11px] font-bold text-[#665f70]">Modalidade associada (opcional)</FormLabel><FormControl><select {...field} data-testid="select-product-modality" className="h-11 w-full rounded-xl border border-[#e7e2ea] bg-white px-3.5 text-sm text-[#342d43] outline-none focus:border-[#9477bf]"><option value="">Sem vínculo · Não classificado</option>{(occupancyModalities ?? []).map((modality) => <option key={modality.id} value={modality.id}>{modality.name}</option>)}</select></FormControl><p className="text-[10px] leading-4 text-[#8a8491]">A modalidade é vinculada manualmente; o sistema não a deduz pelo nome do produto.</p>{areModalitiesError && <p role="alert" className="text-[10px] text-[#9c483f]">Não foi possível carregar as modalidades. <button type="button" onClick={() => void refetchModalities()} className="font-bold underline" data-testid="button-retry-product-modalities">Tentar novamente</button></p>}{areModalitiesLoading && <p className="text-[10px] text-[#8a8491]">Carregando modalidades…</p>}</FormItem>} />
                  <FormField name="isActive" render={({ field }) => <FormItem className="flex items-center justify-between rounded-xl border border-[#e9e4ec] bg-white px-3.5 py-3"><div><FormLabel className="text-xs font-bold text-[#4b4356]">Produto ativo</FormLabel><p className="mt-0.5 text-[10px] text-[#8a8491]">Produtos inativos não aparecem em novas vendas.</p></div><FormControl><input type="checkbox" checked={field.value} onChange={field.onChange} data-testid="input-product-active" className="h-5 w-5 accent-[#7656b8]" /></FormControl></FormItem>} />
                  {productFeedback && <p role={productFeedback.type === 'error' ? 'alert' : 'status'} className={`rounded-xl px-3 py-2.5 text-[11px] font-semibold ${productFeedback.type === 'error' ? 'bg-[#fff0ed] text-[#9c483f]' : 'bg-[#eff6e5] text-[#55772c]'}`} data-testid={`status-product-${productFeedback.type}`}>{productFeedback.message}</p>}
                  <div className="flex gap-2">
                    {editingProduct && <button type="button" onClick={() => { setEditingProduct(null); pendingProductKey.current = null; productForm.reset({ name: '', suggestedPrice: '', modalityId: '', isActive: true }); }} className="h-10 rounded-xl border border-[#e3dfe7] px-3 text-xs font-bold text-[#716a79]" data-testid="button-cancel-product-edit">Cancelar edição</button>}
                    <button type="submit" disabled={busy} className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-[#7656b8] px-3 text-xs font-bold text-white transition hover:bg-[#6848a9] disabled:opacity-60" data-testid="button-save-product">
                      {createProduct.isPending || updateProduct.isPending ? 'Salvando…' : editingProduct ? 'Salvar alterações' : <><PackagePlus size={14} /> Cadastrar produto</>}
                    </button>
                  </div>
                </form>
              </Form>
            </section>
          </div>
          <DialogFooter><button type="button" onClick={() => setProductsOpen(false)} className="h-10 rounded-xl border border-[#e3dfe7] px-4 text-sm font-bold text-[#716a79] hover:bg-[#f8f6fa]" data-testid="button-close-products">Concluir</button></DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deactivatingProduct} onOpenChange={(open) => { if (!open && !updateProduct.isPending) { setDeactivatingProduct(null); setDeactivationError(''); } }}>
        <AlertDialogContent className="rounded-[22px] border-[#e7e1e9] bg-[#fffefc]" data-testid="dialog-deactivate-product">
          <AlertDialogHeader>
            <AlertDialogTitle>Inativar produto?</AlertDialogTitle>
            <AlertDialogDescription data-testid="text-deactivate-product-warning">
              {deactivatingProduct && <>O produto <strong>{deactivatingProduct.name}</strong> não será apagado. Ele deixará de aparecer em novas vendas, mas vendas, estornos e metas existentes serão preservados. Você poderá reativá-lo pela edição do produto.</>}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deactivationError && <p role="alert" className="rounded-xl border border-[#f1d0ca] bg-[#fff3f1] px-3 py-2 text-xs font-semibold text-[#8e3d33]" data-testid="status-deactivate-product-error">{deactivationError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={updateProduct.isPending} data-testid="button-cancel-deactivate-product">Cancelar</AlertDialogCancel>
            <button type="button" onClick={() => void confirmDeactivateProduct()} disabled={updateProduct.isPending} className="inline-flex h-10 items-center justify-center rounded-md bg-[#bc4141] px-4 text-sm font-bold text-white hover:bg-[#a63636] disabled:opacity-60" data-testid="button-confirm-deactivate-product">{updateProduct.isPending ? 'Inativando…' : 'Inativar produto'}</button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={importOpen} onOpenChange={(open) => { if (!importSales.isPending) setImportOpen(open); }}>
        <DialogContent className="max-w-4xl border-[#e7e1e9] bg-[#fffefc] p-5 sm:rounded-[24px] md:p-6">
          <DialogHeader className="text-left">
            <DialogTitle className="text-lg font-extrabold tracking-[-.035em] text-[#332d40]">Importar vendas</DialogTitle>
            <DialogDescription className="text-xs leading-5 text-[#827b8b]">Identificamos cliente, data, plano/produto e valor. Colunas extras são ignoradas; produtos novos só entram no cadastro depois da confirmação.</DialogDescription>
          </DialogHeader>
          {importError && <p className="rounded-xl bg-[#fff0ed] px-3.5 py-2.5 text-xs font-semibold text-[#9c483f]" role="alert" data-testid="status-import-error">{importError}</p>}
          {importFeedback && <p role="status" className="rounded-xl bg-[#eff6e5] px-3.5 py-2.5 text-xs text-[#55772c]">{importFeedback}</p>}
          {!importWorkspace ? <div className="rounded-2xl border border-dashed border-[#ded7e7] p-6 text-center">
            <FileSpreadsheet className="mx-auto text-[#7656b8]" size={24} />
            <p className="mt-3 text-sm font-bold text-[#40374e]">Selecione um arquivo CSV ou XLSX</p>
            <p className="mt-1 text-xs text-[#817b89]">Lemos todas as abas e evitamos repetir o mesmo arquivo. XLS e outros formatos não são aceitos.</p>
            <button type="button" onClick={() => importFileRef.current?.click()} className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl bg-[#d7f500] px-4 text-xs font-extrabold text-[#262b15]" data-testid="button-select-import-file"><Upload size={14} /> Escolher arquivo</button>
          </div> : <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[#f8f6fa] px-3.5 py-3">
              <div className="min-w-0"><p className="truncate text-sm font-bold text-[#40374e]" data-testid="text-import-filename">{importWorkspace.filename}</p><p className="mt-0.5 text-[10px] text-[#817b89]">{importWorkspace.sheets.length} aba(s) · hash SHA-256 do arquivo original.</p></div>
              <span className="rounded-full bg-white px-3 py-1.5 text-[10px] font-bold text-[#5d4a78]" data-testid="text-import-valid-count">
                {candidateImportCount} candidatos = {readyImportCount} prontos + {pendingImportCount} pendentes + {alreadyImportedCount} já importados.
                {' '}{selectedImportLines.length} selecionados · {importTotalLabel}
              </span>
            </div>
            <p className="text-[10px] text-[#817b89]" data-testid="text-import-auxiliary-count">
              Contagem separada: {auxiliaryImportCount} auxiliares · {importWorkspace.sheets.reduce((sum, sheet) => sum + sheet.ignoredBlankRows, 0)} vazias/formatação · {importWorkspace.sheets.reduce((sum, sheet) => sum + sheet.ignoredHeaderRows, 0)} cabeçalhos · {importWorkspace.sheets.reduce((sum, sheet) => sum + sheet.ignoredSummaryRows, 0)} totais. Todas as abas, colunas e linhas do intervalo utilizado foram examinadas.
            </p>
            <div className="max-h-[340px] space-y-3 overflow-auto pr-1" data-testid="panel-import-sheets">
              {importWorkspace.sheets.map((sheet, sheetIndex) => <section key={sheet.name} className="rounded-xl border border-[#e9e4ec] p-3" data-testid={`panel-import-sheet-${sheetIndex}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="flex min-h-8 items-center gap-2 text-xs font-bold text-[#40374e]">
                    <input
                      type="checkbox"
                      checked={sheet.selected}
                      onChange={(event) => setImportWorkspace((current) => current ? {
                        ...current,
                        sheets: current.sheets.map((item) => item.name === sheet.name
                          ? { ...item, selected: event.target.checked }
                          : item),
                      } : current)}
                      data-testid={`checkbox-import-sheet-${sheetIndex}`}
                      className="h-4 w-4 accent-[#7656b8]"
                    />
                    {sheet.name}
                    {sheet.hidden && <span className="rounded-full bg-[#fff2db] px-2 py-0.5 text-[9px] font-bold text-[#805824]">Oculta</span>}
                  </label>
                  <span className="text-[10px] text-[#817b89]">
                    {sheet.blocks.length} bloco(s) · {sheet.rows.filter((row) => mapSalesImportRow(sheet, row).kind !== 'auxiliary').length} candidatos · {sheet.ignoredBlankRows} vazias · {sheet.rows.filter((row) => row.hidden).length} linhas ocultas
                  </span>
                </div>
                {sheet.filterRange && <p className="mt-1 text-[10px] text-[#817b89]">Filtro salvo: {sheet.filterRange}. O filtro não exclui conteúdo da leitura.</p>}
                {sheet.blocks.map((block, blockIndex) => <div key={blockIndex}>
                <p className="mt-3 text-[10px] font-semibold text-[#655579]">Bloco {blockIndex + 1} · {block.headerRow ? `cabeçalho na linha ${block.headerRow}` : 'sem cabeçalho; confirme as colunas'}</p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {([
                    { field: 'customerName', label: 'Nome do cliente · opcional' },
                    { field: 'saleDate', label: 'Data da venda · essencial' },
                    { field: 'totalAmount', label: 'Valor da venda · essencial' },
                    { field: 'productName', label: 'Plano/produto · opcional' },
                  ] as Array<{ field: SalesImportField; label: string }>).map(({ field, label }) => {
                    const selectedColumn = (blockIndex === 0 ? sheet.mapping : block.mapping)[field];
                    const rawSample = selectedColumn === null ? '' : sheet.rows.find((row) =>
                      row.blockIndex === blockIndex && String(row.cells[selectedColumn] ?? '').trim(),
                    )?.cells[selectedColumn] ?? '';
                    const parsedDateSample = field === 'saleDate' ? parseImportDate(rawSample, sheet.date1904) : null;
                    const sample = parsedDateSample ? formatDate(parsedDateSample) : String(rawSample).trim();
                    return <label key={field} className="min-w-0 text-[10px] font-bold text-[#665f70]">{label}
                      <select
                        value={selectedColumn === null ? '' : String(selectedColumn)}
                        onChange={(event) => {
                          const column = event.target.value === '' ? null : Number(event.target.value);
                          setImportWorkspace((current) => current ? {
                            ...current,
                            sheets: current.sheets.map((item) => item.name === sheet.name
                              ? {
                                ...item,
                                ...(blockIndex === 0 ? { mapping: { ...item.mapping, [field]: column } } : {}),
                                blocks: item.blocks.map((entry, index) => index === blockIndex
                                  ? { ...entry, mapping: { ...entry.mapping, [field]: column }, dateInferred: field === 'saleDate' ? false : entry.dateInferred }
                                  : entry),
                              }
                              : item),
                          } : current);
                        }}
                        data-testid={`select-import-map-${sheetIndex}-${blockIndex}-${field}`}
                        className="mt-1 h-9 w-full rounded-lg border border-[#e7e2ea] bg-white px-2 text-xs font-medium text-[#443d50] outline-none focus:border-[#9477bf]"
                      >
                        <option value="">{field === 'saleDate' || field === 'totalAmount' ? 'Não identificada — salvar pendente' : 'Não mapear'}</option>
                        {block.columns.map((column) => <option key={column.index} value={column.index}>{column.label}</option>)}
                      </select>
                      {sample && <span className="mt-1 block truncate font-normal text-[#8a8491]" title={sample}>Exemplo: {sample}</span>}
                    </label>;
                  })}
                </div>
                </div>)}
                <details className="mt-3 text-[10px] text-[#817b89]">
                  <summary className="cursor-pointer">Consultar linhas auxiliares, títulos, cabeçalhos e totais</summary>
                  {sheet.ignoredRows.map(({ source, reason }) => <div key={source.sourceRow} className="mt-2 rounded-lg border p-2">
                    Linha {source.sourceRow}: {reason}<ImportSourceDetails source={source} />
                  </div>)}
                  {sheet.rows.filter((row) => mapSalesImportRow(sheet, row).kind === 'auxiliary').map((row) =>
                    <div key={row.key} className="mt-2 rounded-lg border p-2">Linha {row.sourceRow}: {mapSalesImportRow(sheet, row).reason}<ImportSourceDetails source={row} /></div>,
                  )}
                </details>
              </section>)}
            </div>
            {importMappingIncomplete && <p className="rounded-xl bg-[#fff5e8] px-3.5 py-2.5 text-xs font-semibold text-[#805824]" role="alert" data-testid="status-import-mapping-required">Selecione ao menos uma aba.</p>}
            {pendingImportCount > 0 && <p className="rounded-xl bg-[#fff5e8] px-3.5 py-2.5 text-xs text-[#805824]" role="status" data-testid="status-import-invalid-rows">{pendingImportCount} linha(s) sem data ou valor suficiente para confirmar. Selecione-as para salvar como pendências; elas não entram no faturamento até serem completadas.</p>}
            <label className="flex items-center gap-2 text-xs text-[#655579]"><input type="checkbox" checked={importPendingOnly} onChange={(event) => setImportPendingOnly(event.target.checked)} data-testid="checkbox-import-pending-only" /> Consultar somente pendentes ({pendingImportCount})</label>
            {importOverLimit && <p className="rounded-xl bg-[#fff5e8] px-3.5 py-2.5 text-xs font-semibold text-[#805824]" role="alert" data-testid="status-import-limit">O limite é de 500 linhas por importação. Desmarque abas/linhas ou divida o arquivo.</p>}
            {importTotalTooLarge && <p className="rounded-xl bg-[#fff0ed] px-3.5 py-2.5 text-xs font-semibold text-[#9c483f]" role="alert">O total ultrapassa o limite de precisão do sistema. Reduza a seleção antes de importar.</p>}
            <div className="max-h-[300px] overflow-auto rounded-xl border border-[#e9e4ec]" data-testid="table-import-preview">
              <table className="w-full min-w-[760px] border-collapse text-left text-xs">
                <thead className="sticky top-0 bg-[#f1edf7] text-[10px] font-bold uppercase tracking-[.08em] text-[#655579]"><tr><th className="px-3 py-2.5">Importar</th><th className="px-3 py-2.5">Aba / linha</th><th className="px-3 py-2.5">Cliente</th><th className="px-3 py-2.5">Data</th><th className="px-3 py-2.5">Plano/produto</th><th className="px-3 py-2.5">Valor</th><th className="px-3 py-2.5">Resultado</th></tr></thead>
                <tbody className="divide-y divide-[#f0edf2]">
                  {importedLines.filter((line) => line.kind !== 'auxiliary' || line.alreadyImported)
                    .filter((line) => !importPendingOnly || (line.kind === 'pending' && !line.alreadyImported)).map((line) => {
                    const excluded = skippedImportRows.has(line.key);
                    const idSuffix = `${encodeURIComponent(line.sourceSheet)}-${line.sourceRow}`;
                    const duplicateNotices = importDuplicateNotices.get(line.key) ?? [];
                    return <tr key={line.key} className={line.value ? 'bg-white' : 'bg-[#fffaf9]'} data-testid={`row-import-${idSuffix}`}>
                      <td className="px-3 py-2.5">
                        <input type="checkbox" disabled={line.kind === 'auxiliary' || line.alreadyImported || busy} checked={line.kind !== 'auxiliary' && !line.alreadyImported && line.sheetSelected && !excluded} onChange={(event) => setImportRowIncluded(line.key, event.target.checked)} aria-label={`${duplicateNotices.length ? 'Importar mesmo assim' : 'Incluir'} linha ${line.sourceRow} da aba ${line.sourceSheet}`} data-testid={`checkbox-import-include-${idSuffix}`} className="h-4 w-4 accent-[#7656b8]" />
                      </td>
                      <td className="px-3 py-2.5 text-[#4b4356]">{line.sourceSheet} · {line.sourceRow}{line.source.hidden && <span className="block text-[9px]">Linha oculta/filtro — conteúdo incluído</span>}</td>
                      <td className="px-3 py-2.5 text-[#4b4356]">{line.preview.customerName || '—'}</td>
                      <td className="px-3 py-2.5 text-[#4b4356]">{isValidCalendarDate(line.preview.saleDate) ? formatDate(line.preview.saleDate) : line.preview.saleDate || '—'}<span className="mt-1 block text-[9px] text-[#817b89]">{line.dateSource}</span></td>
                      <td className="px-3 py-2.5 text-[#4b4356]">{line.preview.productName ?? 'Não categorizado'}</td>
                      <td className="px-3 py-2.5 tabular-nums text-[#4b4356]">{line.preview.totalCents !== null ? formatCents(line.preview.totalCents) : line.preview.amountText || '—'}</td>
                      <td className="px-3 py-2.5">
                        {line.alreadyImported ? <span className="text-[10px] font-semibold text-[#655579]">Já salva — não será duplicada</span> : line.kind === 'pending'
                          ? <span className="text-[10px] font-semibold text-[#9c483f]">{excluded ? 'Pendente não selecionada' : 'Será salva como pendência: '}{line.reason}</span> : !line.sheetSelected
                          ? <span className="text-[10px] text-[#817b89]">Aba fora da seleção</span>
                          : excluded
                            ? <span className="text-[10px] font-semibold text-[#817b89]">Linha desmarcada</span>
                            : <span className={`inline-flex rounded-full px-2 py-1 text-[10px] font-bold ${line.value ? 'bg-[#eff6e5] text-[#55772c]' : 'bg-[#fff0ed] text-[#9c483f]'}`} data-testid={`status-import-row-${idSuffix}`}>
                               {line.needsVerification ? 'Informações pendentes de verificação' : 'Pronta para importar'}
                            </span>}
                        {duplicateNotices.length > 0 && <div role="status" aria-live="polite" className="mt-1.5 rounded-lg border border-[#f1dfb8] bg-[#fff9eb] px-2 py-1.5 text-[9px] leading-3.5 text-[#775624]" data-testid={`status-import-possible-duplicate-${idSuffix}`}>
                          <strong className="block">⚠ Possível venda duplicada</strong>
                          <ul className="mt-0.5 space-y-0.5">
                            {duplicateNotices.slice(0, 2).map((notice, index) => (
                              <li key={`${notice.label}-${index}`}>Coincidem: {notice.fields.map((field) => saleDuplicateFieldLabels[field]).join(', ')} · {notice.label}</li>
                            ))}
                          </ul>
                          {duplicateNotices.length > 2 && <span className="mt-0.5 block">+ {duplicateNotices.length - 2} correspondência(s)</span>}
                          <div className="mt-1.5 flex flex-wrap gap-1.5">
                            <button type="button" aria-pressed={!excluded} disabled={busy} onClick={() => setImportRowIncluded(line.key, true)} className={`rounded-md px-2 py-1 font-bold ${excluded ? 'bg-white text-[#775624]' : 'bg-[#7656b8] text-white'}`} data-testid={`button-import-duplicate-keep-${idSuffix}`}>Importar mesmo assim</button>
                            <button type="button" aria-pressed={excluded} disabled={busy} onClick={() => setImportRowIncluded(line.key, false)} className={`rounded-md px-2 py-1 font-bold ${excluded ? 'bg-[#775624] text-white' : 'bg-white text-[#775624]'}`} data-testid={`button-import-duplicate-ignore-${idSuffix}`}>Ignorar esta linha</button>
                          </div>
                        </div>}
                        <ImportSourceDetails source={line.source} />
                      </td>
                  </tr>;
                  })}
                </tbody>
              </table>
            </div>
            <div className="rounded-xl border border-[#e9e0c8] bg-[#fcf8ed] px-3.5 py-3 text-[10px] leading-5 text-[#725d2d]">
              {selectedImportLines.length} linha(s) selecionada(s) · {validImportRows.length} venda(s) confirmada(s) ({importTotalLabel}) · {pendingImportRows.length} pendência(s). Só vendas com data e valor válidos entram nos indicadores; os rascunhos serão salvos sem afetar o faturamento após confirmar.
            </div>
          </>}
          <DialogFooter className="gap-2">
            <button type="button" onClick={() => { setImportOpen(false); setImportWorkspace(null); setImportError(''); }} disabled={importSales.isPending} className="h-10 rounded-xl border border-[#e3dfe7] px-4 text-sm font-bold text-[#716a79] hover:bg-[#f8f6fa] disabled:opacity-50" data-testid="button-cancel-import">Cancelar</button>
            {importWorkspace && <button type="button" onClick={() => void commitImport()} disabled={(!validImportRows.length && !pendingImportRows.length) || importTotalTooLarge || importOverLimit || importMappingIncomplete || busy} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#7656b8] px-4 text-sm font-bold text-white hover:bg-[#6848a9] disabled:opacity-55" data-testid="button-confirm-import">
              {importSales.isPending ? 'Importando…' : <><Check size={14} /> Confirmar vendas e pendências</>}
            </button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={refundDialogOpen} onOpenChange={(open) => { if (!createSalesRefund.isPending) setRefundDialogOpen(open); }}>
        <DialogContent className="max-w-lg border-[#e7e1e9] bg-[#fffefc] p-6 sm:rounded-[24px]">
          <DialogHeader className="text-left">
            <DialogTitle className="text-lg font-extrabold tracking-[-.035em] text-[#332d40]">Registrar estorno</DialogTitle>
            <DialogDescription className="text-xs leading-5 text-[#827b8b]">Escolha uma venda ativa. O valor registrado não pode ultrapassar o saldo disponível e ficará vinculado ao histórico original.</DialogDescription>
          </DialogHeader>
          {isRefundCandidatesLoading ? <div className="skeleton h-14 rounded-xl" aria-label="Carregando vendas com saldo" data-testid="status-refund-candidates-loading" />
            : isRefundCandidatesError ? <div className="rounded-xl border border-dashed border-[#ded7e7] p-4 text-center text-xs text-[#817b89]" role="alert" data-testid="status-refund-candidates-error"><p>Não foi possível buscar vendas com saldo disponível.</p><button type="button" onClick={() => void refetchRefundCandidates()} className="mt-2 font-bold text-[#6848a9] underline" data-testid="button-retry-refund-candidates">Tentar novamente</button></div>
              : !refundCandidates?.length ? <p className="rounded-xl border border-dashed border-[#ded7e7] px-3.5 py-5 text-center text-xs text-[#817b89]" data-testid="status-refund-candidates-empty">Não há vendas ativas com saldo disponível para estorno.</p>
                : <form onSubmit={(event) => void submitRefund(event)} className="space-y-3.5" data-testid="form-create-refund">
                  <label className="block text-[10px] font-bold text-[#665f70]">Venda original
                    <select value={refundSaleId} onChange={(event) => { setRefundSaleId(event.target.value); setRefundError(''); }} required data-testid="select-refund-sale" className="mt-1.5 h-11 w-full rounded-xl border border-[#e7e2ea] bg-[#fcfbfd] px-3 text-sm font-medium text-[#342d43] outline-none focus:border-[#9477bf]">
                      <option value="" disabled>Selecione uma venda</option>
                      {refundCandidates.map((candidate) => <option key={candidate.saleId} value={candidate.saleId}>{formatDate(candidate.saleDate)} · {candidate.productName} · disponível {formatCents(candidate.remainingCents)}</option>)}
                    </select>
                  </label>
                  {selectedRefundCandidate && <div className="grid grid-cols-3 gap-2 rounded-xl bg-[#f8f6fa] px-3.5 py-3" data-testid="panel-refund-sale-balance">
                    <div><p className="text-[9px] font-bold uppercase tracking-[.08em] text-[#81798b]">Original</p><p className="mt-1 text-xs font-extrabold tabular-nums text-[#40374e]" data-testid="text-refund-sale-total">{formatCents(selectedRefundCandidate.totalCents)}</p></div>
                    <div><p className="text-[9px] font-bold uppercase tracking-[.08em] text-[#81798b]">Já estornado</p><p className="mt-1 text-xs font-extrabold tabular-nums text-[#40374e]" data-testid="text-refund-sale-refunded">{formatCents(selectedRefundCandidate.refundedCents)}</p></div>
                    <div><p className="text-[9px] font-bold uppercase tracking-[.08em] text-[#81798b]">Disponível</p><p className="mt-1 text-xs font-extrabold tabular-nums text-[#55772c]" data-testid="text-refund-sale-remaining">{formatCents(selectedRefundCandidate.remainingCents)}</p></div>
                  </div>}
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block text-[10px] font-bold text-[#665f70]">Data do estorno
                      <input type="date" value={refundDate} min={selectedRefundCandidate?.saleDate.slice(0, 10)} onChange={(event) => { setRefundDate(event.target.value); setRefundError(''); }} required data-testid="input-refund-date" className="mt-1.5 h-11 w-full rounded-xl border border-[#e7e2ea] bg-[#fcfbfd] px-3 text-sm font-medium text-[#342d43] outline-none focus:border-[#9477bf]" />
                    </label>
                    <label className="block text-[10px] font-bold text-[#665f70]">Valor
                      <input type="text" inputMode="decimal" value={refundAmount} onChange={(event) => { setRefundAmount(event.target.value); setRefundError(''); }} required placeholder="0,00" data-testid="input-refund-amount" className="mt-1.5 h-11 w-full rounded-xl border border-[#e7e2ea] bg-[#fcfbfd] px-3 text-sm font-medium text-[#342d43] outline-none focus:border-[#9477bf]" />
                    </label>
                  </div>
                  {refundAmountCents !== null && selectedRefundCandidate && refundAmountCents > selectedRefundCandidate.remainingCents && <p className="text-[10px] font-semibold text-[#9c483f]" data-testid="status-refund-amount-limit">O valor não pode passar do saldo disponível de {formatCents(selectedRefundCandidate.remainingCents)}.</p>}
                  <label className="block text-[10px] font-bold text-[#665f70]">Motivo
                    <textarea value={refundReason} onChange={(event) => { setRefundReason(event.target.value); setRefundError(''); }} maxLength={500} rows={3} required placeholder="Descreva o motivo do estorno" data-testid="input-refund-reason" className="mt-1.5 w-full rounded-xl border border-[#e7e2ea] bg-[#fcfbfd] px-3.5 py-3 text-sm font-normal text-[#342d43] outline-none focus:border-[#9477bf]" />
                  </label>
                  <p className="text-[10px] text-[#8a8491]">{refundReason.trim().length}/500 caracteres. Data, valor e motivo são registrados no histórico.</p>
                  {refundError && <p className="rounded-xl bg-[#fff0ed] px-3.5 py-2.5 text-xs font-semibold text-[#9c483f]" role="alert" data-testid="status-refund-error">{refundError}</p>}
                  <DialogFooter className="gap-2">
                    <button type="button" onClick={() => setRefundDialogOpen(false)} disabled={createSalesRefund.isPending} className="h-10 rounded-xl border border-[#e3dfe7] px-4 text-sm font-bold text-[#716a79] hover:bg-[#f8f6fa]" data-testid="button-cancel-refund">Cancelar</button>
                    <button type="submit" disabled={!selectedRefundCandidate || createSalesRefund.isPending} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#a84940] px-4 text-sm font-bold text-white hover:bg-[#963c35] disabled:opacity-55" data-testid="button-submit-refund">
                      {createSalesRefund.isPending ? 'Salvando…' : <><RotateCcw size={14} /> Confirmar estorno</>}
                    </button>
                  </DialogFooter>
                </form>}
        </DialogContent>
      </Dialog>

      <Dialog open={!!cancelling} onOpenChange={(open) => { if (!cancelSale.isPending && !open) { setCancelling(null); setCancellationReason(''); setCancellationError(''); setCancellationConflict(false); } }}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-lg max-h-[calc(100dvh-2rem)] min-w-0 overflow-y-auto border-[#e7e1e9] bg-[#fffefc] p-4 sm:rounded-[24px] sm:p-6">
          <DialogHeader className="text-left">
            <DialogTitle className="text-lg font-extrabold tracking-[-.035em] text-[#332d40]">Cancelar venda</DialogTitle>
            <DialogDescription className="text-xs leading-5 text-[#827b8b]">O cancelamento mantém o registro no histórico e não apaga seus dados.</DialogDescription>
          </DialogHeader>
          {cancelling && <div className="rounded-xl bg-[#f8f6fa] px-3.5 py-3" data-testid="panel-cancellation-sale">
            <p className="break-words text-sm font-bold text-[#40374e] [overflow-wrap:anywhere]">{cancelling.productName}</p>
            <p className="mt-1 text-xs text-[#817b89]">{formatDate(cancelling.saleDate)} · {cancelling.quantity} un. · {formatCents(cancelling.totalCents)}</p>
          </div>}
          <label className="block text-[11px] font-bold text-[#665f70]">Motivo do cancelamento
            <textarea value={cancellationReason} onChange={(event) => setCancellationReason(event.target.value)} maxLength={500} rows={4} placeholder="Descreva o motivo" data-testid="input-cancellation-reason" className="mt-1.5 block w-full max-w-full resize-y rounded-xl border border-[#e7e2ea] bg-[#fcfbfd] px-3.5 py-3 text-sm font-normal text-[#342d43] outline-none focus:border-[#9477bf]" />
          </label>
          <p className="break-words text-[10px] text-[#8a8491]">{cancellationReason.trim().length}/500 caracteres. O motivo ficará visível no histórico.</p>
          {cancellationError && <p className="break-words rounded-xl bg-[#fff0ed] px-3.5 py-2.5 text-xs font-semibold text-[#9c483f]" role="alert" data-testid="status-cancellation-error">{cancellationError}</p>}
          <DialogFooter className="w-full min-w-0 gap-2 sm:flex-row sm:space-x-0">
            {cancellationConflict && <button type="button" onClick={async () => { await Promise.all([refetchHistory(), refetchSales()]); setCancelling(null); setCancellationError(''); setCancellationConflict(false); }} className="h-10 w-full rounded-xl border border-[#ded7e7] px-4 text-xs font-bold text-[#5d4a78] hover:bg-[#f7f4fa] sm:w-auto" data-testid="button-refresh-cancel-conflict">Atualizar venda</button>}
            <button type="button" onClick={() => setCancelling(null)} disabled={cancelSale.isPending} className="h-10 w-full rounded-xl border border-[#e3dfe7] px-4 text-sm font-bold text-[#716a79] hover:bg-[#f8f6fa] sm:w-auto" data-testid="button-cancel-cancellation">Cancelar</button>
            <button type="button" onClick={() => void confirmCancellation()} disabled={!cancellationReason.trim() || cancellationReason.trim().length > 500 || busy} className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-[#a84940] px-4 text-sm font-bold text-white hover:bg-[#963c35] disabled:opacity-55 sm:w-auto" data-testid="button-confirm-cancellation">
              {cancelSale.isPending ? 'Cancelando…' : <><X size={14} /> Confirmar cancelamento</>}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {historySale && <SaleHistoryDialog sale={historySale} onClose={() => setHistorySale(null)} />}
      {editingPendingDraft && <SalesPendingDraftDialog
        draft={editingPendingDraft}
        busy={updatePendingDraft.isPending}
        onClose={() => { if (!updatePendingDraft.isPending) setEditingPendingDraft(null); }}
        onSave={savePendingDraft}
      />}
    </>
  );
}

function SaleRow({ sale, onEdit, onHistory, onCancel, busy }: { sale: Sale; onEdit: () => void; onHistory: () => void; onCancel: () => void; busy: boolean }) {
  const cancelled = sale.status === 'cancelled';
  const verificationIssues = getSaleVerificationIssues(sale);
  const needsVerification = verificationIssues.length > 0;
  const labelClass = 'mb-1 block text-[9px] font-bold uppercase tracking-[.09em] text-[#91899a]';
  return <article className={`min-w-0 rounded-2xl border px-3 py-3 transition sm:px-4 ${cancelled ? 'border-[#ede8e9] bg-[#fcfafa]' : 'border-[#f0edf2] hover:border-[#e5dfeb] hover:bg-[#fdfcfe]'}`} data-testid={`row-sale-${sale.id}`}>
    <div className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
      <div className="min-w-0">
        <span className={labelClass}>Data</span>
        <span className="block text-[11px] font-medium text-[#6f6879]" data-testid={`text-sale-date-${sale.id}`}>{formatDate(sale.saleDate, { day: '2-digit', month: 'short', year: 'numeric' })}</span>
        <span className="mt-0.5 block text-[9px] capitalize text-[#91899a]" data-testid={`text-sale-weekday-${sale.id}`}>{getWeekdayName(sale.saleDate, 'short')}</span>
      </div>
      <div className="min-w-0">
        <span className={labelClass}>Tipo</span>
        <span className="block text-[11px] font-bold text-[#81798b]">{cancelled ? 'Cancelamento' : 'Venda'}</span>
      </div>
      <div className="col-span-2 min-w-0">
        <span className={labelClass}>Produto</span>
        <p className={`break-words [overflow-wrap:anywhere] text-sm font-bold ${cancelled ? 'text-[#77717f]' : 'text-[#353044]'}`} data-testid={`text-sale-product-${sale.id}`}>{sale.productName}</p>
      </div>
      <div className="col-span-2 min-w-0">
        <span className={labelClass}>Cliente</span>
        <p className="break-words [overflow-wrap:anywhere] text-[11px] font-medium text-[#5d4a78]" data-testid={`text-sale-customer-name-${sale.id}`}>{sale.customerName || 'Não informado'}</p>
      </div>
      <div className="min-w-0">
        <span className={labelClass}>Quantidade</span>
        <span className="block break-words text-[11px] text-[#746d7b]">{sale.quantity} un.</span>
      </div>
      <div className="min-w-0">
        <span className={labelClass}>Valor</span>
        <span className={`block break-words text-sm font-bold tabular-nums ${cancelled ? 'text-[#817b86] line-through decoration-[#b38b86]' : 'text-[#403650]'}`} data-testid={`text-sale-total-${sale.id}`}>{formatCents(sale.totalCents)}</span>
      </div>
      <div className="min-w-0">
        <span className={labelClass}>Situação</span>
        <span className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold ${cancelled ? 'bg-[#f2ecec] text-[#796565]' : 'bg-[#eff6e5] text-[#55772c]'}`} data-testid={`status-sale-${sale.id}`}>{cancelled ? 'Cancelada' : 'Ativa'}</span>
      </div>
    </div>
    {needsVerification && <p className="mt-3 inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-lg bg-[#fff5e8] px-2.5 py-1.5 text-[10px] font-semibold text-[#805824]" role="status" data-testid={`status-sale-review-${sale.id}`}><CircleHelp size={12} /> Informações pendentes de verificação: {verificationIssues.join(' e ')}{!cancelled && ' · use Editar para completar.'}</p>}
    {(sale.notes || (cancelled && sale.cancellationReason)) && <div className="mt-3 space-y-1 border-t border-[#efebf0] pt-2.5">
      {sale.notes && <p className="break-words [overflow-wrap:anywhere] text-[10px] leading-4 text-[#81798b]"><span className="font-bold">Observação:</span> {sale.notes}</p>}
      {cancelled && sale.cancellationReason && <p className="break-words [overflow-wrap:anywhere] text-[10px] leading-4 text-[#9a625b]" data-testid={`text-sale-cancellation-reason-${sale.id}`}><span className="font-bold">Motivo:</span> {sale.cancellationReason}</p>}
    </div>}
    <div className="mt-3 flex min-w-0 flex-wrap items-center justify-end gap-1 border-t border-[#efebf0] pt-2">
      <button type="button" onClick={onHistory} aria-label={`Ver histórico da venda ${sale.productName}`} className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-[#776b88] transition hover:bg-[#f1edf7] hover:text-[#6848a9]" data-testid={`button-sale-history-${sale.id}`}><History size={15} /></button>
      {!cancelled && <>
        <button type="button" onClick={onEdit} disabled={busy} aria-label={`Editar venda ${sale.productName}`} className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[11px] font-bold text-[#716a79] transition hover:bg-[#f0ebf7] hover:text-[#6848a9] disabled:opacity-40" data-testid={`button-edit-sale-${sale.id}`}><Edit3 size={14} className="shrink-0" /> Editar</button>
        <button type="button" onClick={onCancel} disabled={busy} aria-label={`Cancelar venda ${sale.productName}`} className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[11px] font-bold text-[#98706b] transition hover:bg-[#fff0ed] hover:text-[#a84940] disabled:opacity-40" data-testid={`button-cancel-sale-${sale.id}`}><X size={14} className="shrink-0" /> Cancelar</button>
      </>}
      {cancelled && <span className="px-2.5 py-2 text-[10px] font-medium text-[#8a8491]">Registro preservado</span>}
    </div>
  </article>;
}

function SaleHistoryDialog({ sale, onClose }: { sale: Sale; onClose: () => void }) {
  const { data: history, isLoading, isError, refetch } = useGetSaleHistory(sale.id, {
    query: {
      queryKey: getGetSaleHistoryQueryKey(sale.id),
      refetchOnMount: 'always',
    },
  });
  const operationLabels: Record<string, string> = {
    create: 'Venda registrada',
    import: 'Venda importada',
    update: 'Venda editada',
    cancel: 'Venda cancelada',
    restore: 'Restaurada do backup',
    'restore-update': 'Dados do backup restaurados',
  };

  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-w-lg border-[#e7e1e9] bg-[#fffefc] p-6 sm:rounded-[24px]">
      <DialogHeader className="text-left">
        <DialogTitle className="text-lg font-extrabold tracking-[-.035em] text-[#332d40]">Histórico da venda</DialogTitle>
        <DialogDescription className="text-xs leading-5 text-[#827b8b]">Consulte alterações e cancelamentos sem precisar identificar o registro por código.</DialogDescription>
      </DialogHeader>
      <div className="rounded-xl bg-[#f8f6fa] px-3.5 py-3" data-testid={`panel-sale-history-${sale.id}`}>
        <p className="text-sm font-bold text-[#40374e]">{sale.productName}</p>
        {sale.customerName && <p className="mt-1 text-xs font-semibold text-[#5d4a78]" data-testid="text-sale-history-customer-name">Nome: {sale.customerName}</p>}
        <p className="mt-1 text-xs text-[#817b89]">{formatDate(sale.saleDate)} · {sale.quantity} un. · {formatCents(sale.totalCents)}</p>
        {sale.status === 'cancelled' && sale.cancellationReason && <p className="mt-2 text-xs text-[#9a625b]">Motivo do cancelamento: {sale.cancellationReason}</p>}
      </div>
      {isLoading ? <div className="space-y-2" aria-label="Carregando histórico" data-testid="status-sale-history-loading"><div className="skeleton h-14 rounded-xl" /><div className="skeleton h-14 rounded-xl" /></div>
        : isError ? <div className="rounded-xl border border-dashed border-[#ded7e7] p-4 text-center text-xs text-[#817b89]" role="alert" data-testid="status-sale-history-error"><p>Não foi possível carregar o histórico.</p><button type="button" onClick={() => void refetch()} className="mt-2 font-bold text-[#6848a9] underline" data-testid="button-retry-sale-history">Tentar novamente</button></div>
          : history?.length ? <ol className="max-h-72 space-y-2 overflow-y-auto" aria-label="Alterações da venda" data-testid="list-sale-history">
            {history.map((entry) => {
              const after = entry.afterData;
              const reason = after && typeof after.cancellationReason === 'string' ? after.cancellationReason : null;
              return <li key={entry.id} className="rounded-xl border border-[#eeeaf0] px-3.5 py-3" data-testid={`row-sale-history-${entry.id}`}>
                <div className="flex items-start justify-between gap-3">
                  <p className="text-xs font-bold text-[#40374e]">{operationLabels[entry.operation] ?? 'Registro atualizado'}</p>
                  <time className="shrink-0 text-[10px] text-[#8a8491]" dateTime={entry.createdAt}>{new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(entry.createdAt))}</time>
                </div>
                {reason && <p className="mt-1.5 text-[11px] leading-5 text-[#7d6670]">Motivo: {reason}</p>}
                <p className="mt-1.5 text-[9px] text-[#9a94a0]">Equipe autorizada</p>
              </li>;
            })}
          </ol> : <p className="rounded-xl border border-dashed border-[#ded7e7] px-3.5 py-4 text-center text-xs text-[#817b89]" data-testid="status-sale-history-empty">Nenhuma alteração registrada.</p>}
      <DialogFooter><button type="button" onClick={onClose} className="h-10 rounded-xl border border-[#e3dfe7] px-4 text-sm font-bold text-[#716a79] hover:bg-[#f8f6fa]" data-testid="button-close-sale-history">Fechar</button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function SalesPendingDraftDialog({
  draft,
  busy,
  onClose,
  onSave,
}: {
  draft: SalesPendingDraft;
  busy: boolean;
  onClose: () => void;
  onSave: (id: string, data: UpdateSalesPendingDraftInput) => Promise<UpdateSalesPendingDraftResult>;
}) {
  const [customerName, setCustomerName] = useState(draft.customerName ?? '');
  const [saleDate, setSaleDate] = useState(draft.saleDate?.slice(0, 10) ?? '');
  const [productName, setProductName] = useState(draft.productName ?? '');
  const [amount, setAmount] = useState(draft.totalCents === null
    ? draft.amountText ?? ''
    : `${Math.floor(draft.totalCents / 100)},${String(draft.totalCents % 100).padStart(2, '0')}`);
  const [notes, setNotes] = useState(draft.notes ?? '');
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (saleDate && !isValidCalendarDate(saleDate)) {
      setError('Informe uma data válida ou deixe a data pendente.');
      return;
    }
    const cents = amount.trim() ? parseBrlCents(amount) : null;
    try {
      await onSave(draft.id, {
        customerName: customerName.trim() || null,
        saleDate: saleDate || null,
        saleDateText: saleDate ? null : draft.saleDateText,
        productName: productName.trim() || null,
        totalCents: cents,
        amountText: cents === null ? amount.trim() || null : null,
        notes: notes.trim() || null,
        expectedVersion: draft.version,
      });
    } catch (saveError) {
      setError(errorMessage(saveError));
    }
  }

  const labelClass = 'block text-[10px] font-bold uppercase tracking-[.08em] text-[#817b89]';
  const fieldClass = 'mt-1 h-10 w-full rounded-xl border border-[#e7e2ea] bg-white px-3 text-sm text-[#342d43] outline-none focus:border-[#9477bf]';
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto border-[#e7e1e9] bg-[#fffefc] p-5 sm:rounded-[24px] md:p-6">
      <DialogHeader className="text-left">
        <DialogTitle className="text-lg font-extrabold tracking-[-.035em] text-[#332d40]">Completar pendência de venda</DialogTitle>
        <DialogDescription className="text-xs leading-5 text-[#827b8b]">
          A venda só será confirmada quando houver data e valor válidos. Enquanto isso, o rascunho não afeta o faturamento.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={(event) => void submit(event)} className="space-y-3">
        {(draft.sourceFileName || draft.sourceSheet) && <p className="rounded-xl bg-[#f8f6fa] px-3 py-2 text-[10px] text-[#716a79]">
          Origem: {draft.sourceFileName || 'Planilha'}{draft.sourceSheet ? ` · ${draft.sourceSheet} · linha ${draft.sourceRow}` : ''}
        </p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={labelClass}>Nome do cliente · opcional
            <input value={customerName} maxLength={120} onChange={(event) => setCustomerName(event.target.value)} className={fieldClass} data-testid="input-pending-customer" />
          </label>
          <label className={labelClass}>Data da venda · essencial
            <input type="date" value={saleDate} onChange={(event) => setSaleDate(event.target.value)} className={fieldClass} data-testid="input-pending-date" />
            {!saleDate && draft.saleDateText && <span className="mt-1 block text-[9px] font-normal normal-case tracking-normal text-[#9b6a26]">Texto original: {draft.saleDateText}</span>}
          </label>
          <label className={labelClass}>Plano/produto · opcional
            <input value={productName} maxLength={120} onChange={(event) => setProductName(event.target.value)} className={fieldClass} data-testid="input-pending-product" />
          </label>
          <label className={labelClass}>Valor total · essencial
            <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" maxLength={120} placeholder="0,00" className={fieldClass} data-testid="input-pending-amount" />
            {draft.totalCents === null && draft.amountText && <span className="mt-1 block text-[9px] font-normal normal-case tracking-normal text-[#9b6a26]">Valor original: {draft.amountText}</span>}
          </label>
        </div>
        <label className={labelClass}>Observações · opcional
          <textarea value={notes} maxLength={1000} onChange={(event) => setNotes(event.target.value)} rows={3} className="mt-1 w-full resize-y rounded-xl border border-[#e7e2ea] bg-white px-3 py-2.5 text-sm text-[#342d43] outline-none focus:border-[#9477bf]" data-testid="input-pending-notes" />
        </label>
        {amount.trim() && parseBrlCents(amount) === null && <p className="rounded-lg bg-[#fff5e8] px-3 py-2 text-[10px] font-semibold text-[#805824]" role="status">O valor ainda não é válido; será mantido como pendência e não entrará no faturamento.</p>}
        {error && <p className="rounded-lg bg-[#fff0ed] px-3 py-2 text-xs font-semibold text-[#9c483f]" role="alert" data-testid="status-pending-draft-error">{error}</p>}
        <DialogFooter className="gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="h-10 rounded-xl border border-[#e3dfe7] px-4 text-sm font-bold text-[#716a79] disabled:opacity-50" data-testid="button-cancel-pending-draft">Cancelar</button>
          <button type="submit" disabled={busy} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#7656b8] px-4 text-sm font-bold text-white disabled:opacity-50" data-testid="button-save-pending-draft">
            {busy ? 'Salvando…' : 'Salvar pendência'}
          </button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
