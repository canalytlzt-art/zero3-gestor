import { useMemo, useRef, useState, type ChangeEvent, type FormEvent, type InputHTMLAttributes } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, CalendarDays, Check, ChevronDown, CircleHelp, ClipboardList, Download, Edit3, FileSpreadsheet, Filter, History, PackagePlus, Plus, Power, RefreshCw, RotateCcw, Save, Search, Upload, X } from 'lucide-react';
import {
  getGetProductsQueryKey,
  getGetOccupancyModalitiesQueryKey,
  getGetSaleHistoryQueryKey,
  getGetSalesHistoryQueryKey,
  getGetSalesGoalsQueryKey,
  getGetSalesQueryKey,
  getGetSalesRefundCandidatesQueryKey,
  getGetSalesRefundsQueryKey,
  getGetSalesScoreboardQueryKey,
  getMonthlySalesBackup,
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
  useGetSalesRefundCandidates,
  useGetSalesRefunds,
  useImportSales,
  useRestoreMonthlySalesBackup,
  useUpdateProduct,
  useUpdateSale,
} from '@workspace/api-client-react';
import type { CreateProductInput, MonthlySalesBackupInput, Product, Sale, SaleInput, SalesRestorePreview, SalesRestoreResult, UpdateProductInput } from '@workspace/api-client-react';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { PurpleSelect } from '@/components/ui/purple-select';
import { SuggestionInput } from '@/components/ui/suggestion-input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { downloadMonthlyBackup, parseMonthlySalesBackup } from '@/lib/sales-export';
import { formatCents, formatMonthKey, getSaoPauloMonthKey, normalizeProductName, productNameKey } from '@/lib/sales-utils';
import { mapSalesImportRow, parseImportDate, parseSalesSpreadsheet, type SalesImportField, type SalesImportSheet } from '@/lib/sales-import';
import { ImportSourceDetails } from './import-source-details';

const MAX_BACKUP_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMPORT_ROWS = 500;

const saleFormSchema = z.object({
  saleDate: z.string().refine(isValidCalendarDate, 'Informe uma data válida.'),
  productName: z.string().max(120, 'Use até 120 caracteres.').refine((value) => normalizeProductName(value).length > 0, 'Informe o produto.'),
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
  const queryClient = useQueryClient();
  const { data: sales, isLoading, isFetching, isError, refetch: refetchSales } = useGetSales({
    query: { queryKey: getGetSalesQueryKey(), refetchOnMount: 'always' },
  });
  const { data: historySales, isLoading: isHistoryLoading, isError: isHistoryError, refetch: refetchHistory } = useGetSalesHistory({
    query: { queryKey: getGetSalesHistoryQueryKey(), refetchOnMount: 'always' },
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
  const [cancellationReason, setCancellationReason] = useState('');
  const [cancellationError, setCancellationError] = useState('');
  const [cancellationConflict, setCancellationConflict] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [filterProduct, setFilterProduct] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'cancelled'>('all');
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
  const [backupMonth, setBackupMonth] = useState(getSaoPauloMonthKey());
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
    || createSalesRefund.isPending;
  const operationLock = useRef(false);
  const pendingSaleKey = useRef<{ fingerprint: string; key: string } | null>(null);
  const pendingProductKey = useRef<{ fingerprint: string; key: string } | null>(null);
  const pendingCancellationKey = useRef<{ fingerprint: string; key: string } | null>(null);
  const pendingRefundKey = useRef<{ fingerprint: string; key: string } | null>(null);
  const [importPendingOnly, setImportPendingOnly] = useState(false);

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

  const filteredSales = useMemo(
    () => filterSalesForExport(historySales ?? [], fromDate, toDate, filterProduct, products)
      .filter((sale) => filterStatus === 'all' || sale.status === filterStatus),
    [historySales, fromDate, toDate, filterProduct, filterStatus, products],
  );
  const visibleProducts = useMemo(() => products.filter((product) => product.name.toLocaleLowerCase('pt-BR').includes(productSearch.trim().toLocaleLowerCase('pt-BR'))), [products, productSearch]);
  const backupMonthSales = useMemo(
    () => (historySales ?? []).filter((sale) => sale.saleDate.slice(0, 7) === backupMonth),
    [historySales, backupMonth],
  );
  const backupMonthRefunds = useMemo(
    () => (refunds ?? []).filter((refund) => refund.refundDate.slice(0, 7) === backupMonth),
    [refunds, backupMonth],
  );
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
  const backupMonthGoals = useMemo(
    () => (salesGoals ?? []).filter((goal) => goal.month === backupMonth),
    [salesGoals, backupMonth],
  );

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
  const selectedImportLines = useMemo(() => {
    const selectedSheets = new Set((importWorkspace?.sheets ?? []).filter((sheet) => sheet.selected).map((sheet) => sheet.name));
    return importedLines.filter((line) => line.kind === 'ready' && !line.alreadyImported
      && selectedSheets.has(line.sourceSheet) && !skippedImportRows.has(line.key));
  }, [importWorkspace, importedLines, skippedImportRows]);
  const validImportRows = useMemo(() => selectedImportLines.flatMap((line) => {
    if (!line.value) return [];
    const normalizedName = line.value.productName ? normalizeProductName(line.value.productName) : null;
    const canonical = normalizedName
      ? products.find((product) => productNameKey(product.name) === productNameKey(normalizedName))
      : null;
    return [{
      customerName: line.value.customerName,
      saleDate: line.value.saleDate,
      totalCents: line.value.totalCents,
      productName: canonical?.name ?? normalizedName ?? null,
      sourceSheet: line.value.sourceSheet,
      sourceRow: line.value.sourceRow,
    }];
  }), [selectedImportLines, products]);
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
    ]);
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

  async function commitImport() {
    if (!importWorkspace || importMappingIncomplete || !validImportRows.length || importTotalTooLarge
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
        },
      });
      const committedKeys = selectedImportLines.map((line) => line.key);
      setImportWorkspace((current) => current?.fileHash === workspace.fileHash ? {
        ...current, importedKeys: [...new Set([...current.importedKeys, ...committedKeys])],
      } : current);
      await invalidateSalesRelated();
      setImportFeedback(result.replayed || result.importedCount === 0
        ? `As linhas selecionadas já estavam importadas. Nenhuma venda duplicada foi criada.`
        : `${result.importedCount} ${result.importedCount === 1 ? 'venda importada' : 'vendas importadas'}; ${result.skippedCount} já existentes. ${pendingImportCount} pendência(s) continuam disponíveis para consulta.`);
    } catch (error) {
      setImportError(errorMessage(error));
    } finally {
      operationLock.current = false;
    }
  }

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
      const [result, refundResult, productResult] = await Promise.all([refetchHistory(), refetchRefunds(), refetchProducts()]);
      if (result.isError || !result.data || refundResult.isError || !refundResult.data || productResult.isError || !productResult.data) {
        throw new Error('Não foi possível atualizar vendas, estornos e produtos antes da exportação.');
      }
      const generatedDay = new Date().toISOString().slice(0, 10);
      const { downloadSalesWorkbook } = await import('@/lib/sales-workbook');
      downloadSalesWorkbook(result.data, refundResult.data, productResult.data, {
        fromDate, toDate, productName: filterProduct,
        generatedAt: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
      }, `zero3-pro-relatorio-vendas-${generatedDay}.xlsx`);
      setExportFeedback('Planilha exportada com vendas e estornos válidos dos filtros de data e produto. Cancelamentos não entram no resultado financeiro.');
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
    void Promise.all([refetchHistory(), refetchRefunds(), refetchGoals()]);
  }

  async function generateMonthlyBackup() {
    if (isGeneratingBackup) return;
    setIsGeneratingBackup(true);
    setBackupError('');
    try {
      const backup = await getMonthlySalesBackup({ month: backupMonth });
      downloadMonthlyBackup(backup);
      setBackupError('');
      setExportError('');
      setExportFeedback(`Backup de ${formatMonthKey(backupMonth)}: ${backup.counts.periodSales} vendas, ${backup.counts.periodRefunds} estornos e ${backup.counts.periodGoals} metas do mês; ${backup.counts.dependencySales + backup.counts.dependencyRefunds} dependências preservadas.`);
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
    defaultValues: { saleDate: todayLocal(), productName: '', quantity: '1', unitAmount: '', customerName: '', notes: '' },
  });
  const quantityInput = form.watch('quantity') || '';
  const quantity = /^\d+$/.test(quantityInput) ? BigInt(quantityInput) : 0n;
  const unitCents = parseBrlCents(form.watch('unitAmount') || '') ?? 0;
  const total = quantity * BigInt(unitCents);

  function resetForm() {
    pendingSaleKey.current = null;
    setEditing(null);
    form.reset({ saleDate: todayLocal(), productName: '', quantity: '1', unitAmount: '', customerName: '', notes: '' });
  }

  function startEditing(sale: Sale) {
    pendingSaleKey.current = null;
    setFeedback(null);
    setEditing(sale);
    form.reset({
      saleDate: sale.saleDate,
      productName: sale.productName,
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
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between" data-testid="sales-actions">
        <div>
          <p className="eyebrow text-[9px] font-bold text-[#8b8494]">rotina comercial</p>
          <p className="mt-1 text-sm text-[#77717f]">Registre, revise e acompanhe cada venda da equipe.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
                    if (form.getValues('unitAmount')) return;
                    const matched = activeProducts.find((product) => productNameKey(product.name) === productNameKey(value));
                    if (matched) form.setValue('unitAmount', formatCentsInput(matched.suggestedPriceCents), { shouldValidate: true });
                  }} />
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
              <label className="min-w-0 text-[10px] font-semibold text-[#817b89]">De
                <input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} data-testid="filter-sale-from" className="mt-1 h-10 w-full min-w-0 rounded-lg border border-[#e7e2ea] bg-white px-2.5 text-xs text-[#443d50] outline-none focus:border-[#9477bf]" />
              </label>
              <label className="min-w-0 text-[10px] font-semibold text-[#817b89]">Até
                <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} data-testid="filter-sale-to" className="mt-1 h-10 w-full min-w-0 rounded-lg border border-[#e7e2ea] bg-white px-2.5 text-xs text-[#443d50] outline-none focus:border-[#9477bf]" />
              </label>
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
            </div>
          </div>
          <div className="mb-2 hidden grid-cols-[94px_88px_minmax(130px,1fr)_58px_116px_100px_188px] items-center gap-2 px-3 text-[9px] font-bold uppercase tracking-[.08em] text-[#8a8491] lg:grid" data-testid="header-sales-history">
            <span>Data</span><span>Tipo</span><span>Produto</span><span>Qtd.</span><span className="text-right">Valor</span><span>Situação</span><span className="text-right">Ações</span>
          </div>
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
      <Dialog open={backupDialogOpen} onOpenChange={(open) => { if (!isGeneratingBackup) setBackupDialogOpen(open); }}>
        <DialogContent className="max-w-lg border-[#e7e1e9] bg-[#fffefc] p-6 sm:rounded-[24px]">
          <DialogHeader className="text-left">
            <DialogTitle className="text-lg font-extrabold tracking-[-.035em] text-[#332d40]">Backup mensal</DialogTitle>
            <DialogDescription className="text-xs leading-5 text-[#827b8b]">
              Inclui vendas, estornos, metas, produtos e histórico, sem filtro de plano. Vendas de outros meses e seus estornos são incluídos quando necessários aos vínculos, sem mudar suas datas.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Mês do backup
              <input type="month" value={backupMonth} onChange={(event) => setBackupMonth(event.target.value)} data-testid="input-monthly-backup-month" className="mt-1.5 h-11 w-full rounded-xl border border-[#e7e2ea] bg-[#fcfbfd] px-3.5 text-sm font-medium normal-case tracking-normal text-[#342d43] outline-none focus:border-[#9477bf]" />
            </label>
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-xl bg-[#f8f6f9] px-3.5 py-3">
                <p className="text-[9px] font-bold uppercase tracking-[.1em] text-[#817b89]">Lançamentos</p>
                <p className="mt-1 text-sm font-extrabold tabular-nums text-[#40374e]" data-testid="text-monthly-backup-sales-count">{backupMonthSales.length}</p>
                <p className="mt-1 text-[10px] text-[#8a8491]">Independente do filtro de plano.</p>
              </div>
              <div className="rounded-xl bg-[#f8f6f9] px-3.5 py-3">
                <p className="text-[9px] font-bold uppercase tracking-[.1em] text-[#817b89]">Estornos do mês</p>
                <p className="mt-1 text-sm font-extrabold tabular-nums text-[#40374e]">{backupMonthRefunds.length}</p>
              </div>
              <div className="rounded-xl bg-[#f8f6f9] px-3.5 py-3">
                <p className="text-[9px] font-bold uppercase tracking-[.1em] text-[#817b89]">Metas mensais</p>
                <p className="mt-1 text-sm font-extrabold tabular-nums text-[#40374e]" data-testid="text-monthly-backup-goals-count">{backupMonthGoals.length}</p>
              </div>
            </div>
            <p className="text-[10px] leading-4 text-[#827b8b]">As contagens acima são uma prévia. O arquivo é conferido diretamente no servidor e pode incluir dependências de outros meses.</p>
            {(isLoading || isFetching || isGoalsLoading || isGoalsFetching) && <p className="text-[11px] text-[#827b8b]" role="status">Atualizando a base para gerar uma cópia recente…</p>}
            {!isLoading && !isFetching && !isError && backupMonthSales.length === 0 && backupMonthRefunds.length === 0 && <p className="rounded-xl border border-dashed border-[#ded7e7] px-3.5 py-3 text-xs leading-5 text-[#716a79]" data-testid="status-monthly-backup-empty">Nenhuma movimentação neste mês. O arquivo terá zero movimentações; metas existentes serão preservadas. Nenhuma linha fictícia será criada.</p>}
            {(isError || isGoalsError) && <div className="rounded-xl bg-[#fff5f2] px-3.5 py-3 text-xs text-[#85554e]" role="alert" data-testid="status-monthly-backup-load-error"><p>Não foi possível ler todos os dados para gerar o backup.</p><button type="button" onClick={() => void Promise.all([refetchSales(), refetchGoals()])} className="mt-2 inline-flex items-center gap-1.5 font-bold underline underline-offset-2"><RefreshCw size={12} /> Tentar novamente</button></div>}
            {backupError && <p className="rounded-xl bg-[#fff0ed] px-3.5 py-2.5 text-xs font-semibold text-[#9c483f]" role="alert" data-testid="status-monthly-backup-error">{backupError}</p>}
          </div>
          <DialogFooter className="gap-2">
            <button type="button" onClick={() => setBackupDialogOpen(false)} disabled={isGeneratingBackup} className="h-10 rounded-xl border border-[#e3dfe7] px-4 text-sm font-bold text-[#716a79] transition hover:bg-[#f8f6fa] disabled:opacity-50" data-testid="button-cancel-monthly-backup">Fechar</button>
            <button type="button" onClick={() => void generateMonthlyBackup()} disabled={isGeneratingBackup || !/^\d{4}-(0[1-9]|1[0-2])$/.test(backupMonth)} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#7656b8] px-4 text-sm font-bold text-white transition hover:bg-[#6848a9] disabled:cursor-wait disabled:opacity-60" data-testid="button-generate-monthly-backup">
              {isGeneratingBackup ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Download size={14} />}
              {isGeneratingBackup ? 'Gerando…' : 'Baixar backup JSON'}
            </button>
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
            <DialogTitle className="text-lg font-extrabold tracking-[-.035em] text-[#332d40]">Restaurar backup mensal</DialogTitle>
            <DialogDescription className="text-xs leading-5 text-[#827b8b]">
              Registros idênticos são ignorados. Se o mesmo ID tiver conteúdo diferente, o atual será mantido. Nada é apagado; a aplicação é atômica e uma cópia privada do estado anterior é guardada no servidor.
            </DialogDescription>
          </DialogHeader>
          {isPreviewingRestore && <p role="status" className="text-sm text-[#716a79]">Validando o arquivo e comparando os registros com a base…</p>}
          {restoreError && <p className="rounded-xl bg-[#fff0ed] px-3.5 py-2.5 text-xs font-semibold text-[#9c483f]" role="alert" data-testid="status-backup-restore-error">{restoreError}</p>}
          {restorePreview && !restoreResult && (
            <div className="space-y-3">
              <div className="rounded-xl bg-[#f8f6f9] px-3.5 py-3.5" data-testid="panel-backup-restore-preview">
                <p className="text-sm font-extrabold capitalize text-[#40374e]">{formatMonthKey(restorePreview.report.period)}</p>
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
                Ao confirmar, os lançamentos ausentes serão adicionados pelos IDs internos e as metas deste mês serão restauradas ou atualizadas. Nenhum registro fora do mês será alterado.
              </p>
            </div>
          )}
          {restoreResult && <div className="rounded-xl bg-[#eff6e5] px-3.5 py-3 text-xs leading-5 text-[#55772c]" role="status" data-testid="status-backup-restore-success">
            Backup de {formatMonthKey(restoreResult.period)} processado: {restoreResult.inserted.sales} vendas, {restoreResult.inserted.refunds} estornos, {restoreResult.inserted.goals} metas, {restoreResult.inserted.products} produtos e {restoreResult.inserted.histories} registros de histórico adicionados. {Object.values(restoreResult.identical).reduce((sum, count) => sum + count, 0)} idênticos ignorados; {restoreResult.conflicts.length} conflitos mantiveram os dados atuais.
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
            <DialogDescription className="text-xs leading-5 text-[#827b8b]">Mapeie as colunas, revise cada linha e confirme antes de registrar os dados.</DialogDescription>
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
                    { field: 'customerName', label: 'Nome do cliente', required: true },
                    { field: 'saleDate', label: 'Data de início', required: true },
                    { field: 'totalAmount', label: 'Valor da venda', required: true },
                    { field: 'productName', label: 'Plano/produto', required: false },
                  ] as Array<{ field: SalesImportField; label: string; required: boolean }>).map(({ field, label, required }) => {
                    const selectedColumn = (blockIndex === 0 ? sheet.mapping : block.mapping)[field];
                    const rawSample = selectedColumn === null ? '' : sheet.rows.find((row) =>
                      row.blockIndex === blockIndex && String(row.cells[selectedColumn] ?? '').trim(),
                    )?.cells[selectedColumn] ?? '';
                    const parsedDateSample = field === 'saleDate' ? parseImportDate(rawSample, sheet.date1904) : null;
                    const sample = parsedDateSample ? formatDate(parsedDateSample) : String(rawSample).trim();
                    return <label key={field} className="min-w-0 text-[10px] font-bold text-[#665f70]">{label}{required ? ' *' : ''}
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
                        <option value="">{required ? 'Selecione/confirme a coluna' : 'Não categorizar'}</option>
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
            {pendingImportCount > 0 && <p className="rounded-xl bg-[#fff5e8] px-3.5 py-2.5 text-xs text-[#805824]" role="status" data-testid="status-import-invalid-rows">{pendingImportCount} pendência(s) não selecionada(s). Você pode importar os registros prontos em uma confirmação; as pendências continuam nesta lista e não serão gravadas.</p>}
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
                    return <tr key={line.key} className={line.value ? 'bg-white' : 'bg-[#fffaf9]'} data-testid={`row-import-${idSuffix}`}>
                      <td className="px-3 py-2.5">
                        <input type="checkbox" disabled={line.kind !== 'ready' || line.alreadyImported || busy} checked={line.kind === 'ready' && !line.alreadyImported && line.sheetSelected && !excluded} onChange={(event) => setSkippedImportRows((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.delete(line.key);
                          else next.add(line.key);
                          return next;
                        })} aria-label={`Incluir linha ${line.sourceRow} da aba ${line.sourceSheet}`} data-testid={`checkbox-import-include-${idSuffix}`} className="h-4 w-4 accent-[#7656b8]" />
                      </td>
                      <td className="px-3 py-2.5 text-[#4b4356]">{line.sourceSheet} · {line.sourceRow}{line.source.hidden && <span className="block text-[9px]">Linha oculta/filtro — conteúdo incluído</span>}</td>
                      <td className="px-3 py-2.5 text-[#4b4356]">{line.preview.customerName || '—'}</td>
                      <td className="px-3 py-2.5 text-[#4b4356]">{isValidCalendarDate(line.preview.saleDate) ? formatDate(line.preview.saleDate) : line.preview.saleDate || '—'}<span className="mt-1 block text-[9px] text-[#817b89]">{line.dateSource}</span></td>
                      <td className="px-3 py-2.5 text-[#4b4356]">{line.preview.productName ?? 'Não categorizado'}</td>
                      <td className="px-3 py-2.5 tabular-nums text-[#4b4356]">{line.preview.totalCents !== null ? formatCents(line.preview.totalCents) : line.preview.amountText || '—'}</td>
                      <td className="px-3 py-2.5">
                        {line.alreadyImported ? <span className="text-[10px] font-semibold text-[#655579]">Já importado — não será duplicado</span> : line.kind === 'pending'
                          ? <span className="text-[10px] font-semibold text-[#9c483f]">Pendente: {line.reason}</span> : !line.sheetSelected
                          ? <span className="text-[10px] text-[#817b89]">Aba fora da seleção</span>
                          : excluded
                            ? <span className="text-[10px] font-semibold text-[#817b89]">Linha desmarcada</span>
                            : <span className={`inline-flex rounded-full px-2 py-1 text-[10px] font-bold ${line.value ? 'bg-[#eff6e5] text-[#55772c]' : 'bg-[#fff0ed] text-[#9c483f]'}`} data-testid={`status-import-row-${idSuffix}`}>
                               {line.value ? 'Pronta para importar' : line.reason}
                            </span>}
                        <ImportSourceDetails source={line.source} />
                      </td>
                  </tr>;
                  })}
                </tbody>
              </table>
            </div>
            <div className="rounded-xl border border-[#e9e0c8] bg-[#fcf8ed] px-3.5 py-3 text-[10px] leading-5 text-[#725d2d]">
              {selectedImportLines.length} registros prontos selecionados · {importTotalLabel}. {pendingImportCount} pendências permanecem fora da importação, sem descartar seu conteúdo. A origem persistente (arquivo + aba + linha) permite reprocessar as linhas restantes sem repetir as anteriores. Nenhuma gravação ocorre até confirmar.
            </div>
          </>}
          <DialogFooter className="gap-2">
            <button type="button" onClick={() => { setImportOpen(false); setImportWorkspace(null); setImportError(''); }} disabled={importSales.isPending} className="h-10 rounded-xl border border-[#e3dfe7] px-4 text-sm font-bold text-[#716a79] hover:bg-[#f8f6fa] disabled:opacity-50" data-testid="button-cancel-import">Cancelar</button>
            {importWorkspace && <button type="button" onClick={() => void commitImport()} disabled={!validImportRows.length || importTotalTooLarge || importOverLimit || importMappingIncomplete || busy} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#7656b8] px-4 text-sm font-bold text-white hover:bg-[#6848a9] disabled:opacity-55" data-testid="button-confirm-import">
              {importSales.isPending ? 'Importando…' : <><Check size={14} /> Confirmar importação</>}
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
        <DialogContent className="max-w-lg border-[#e7e1e9] bg-[#fffefc] p-6 sm:rounded-[24px]">
          <DialogHeader className="text-left">
            <DialogTitle className="text-lg font-extrabold tracking-[-.035em] text-[#332d40]">Cancelar venda</DialogTitle>
            <DialogDescription className="text-xs leading-5 text-[#827b8b]">O cancelamento mantém o registro no histórico e não apaga seus dados.</DialogDescription>
          </DialogHeader>
          {cancelling && <div className="rounded-xl bg-[#f8f6fa] px-3.5 py-3" data-testid="panel-cancellation-sale">
            <p className="text-sm font-bold text-[#40374e]">{cancelling.productName}</p>
            <p className="mt-1 text-xs text-[#817b89]">{formatDate(cancelling.saleDate)} · {cancelling.quantity} un. · {formatCents(cancelling.totalCents)}</p>
          </div>}
          <label className="block text-[11px] font-bold text-[#665f70]">Motivo do cancelamento
            <textarea value={cancellationReason} onChange={(event) => setCancellationReason(event.target.value)} maxLength={500} rows={4} placeholder="Descreva o motivo" data-testid="input-cancellation-reason" className="mt-1.5 w-full rounded-xl border border-[#e7e2ea] bg-[#fcfbfd] px-3.5 py-3 text-sm font-normal text-[#342d43] outline-none focus:border-[#9477bf]" />
          </label>
          <p className="text-[10px] text-[#8a8491]">{cancellationReason.trim().length}/500 caracteres. O motivo ficará visível no histórico.</p>
          {cancellationError && <p className="rounded-xl bg-[#fff0ed] px-3.5 py-2.5 text-xs font-semibold text-[#9c483f]" role="alert" data-testid="status-cancellation-error">{cancellationError}</p>}
          <DialogFooter className="gap-2">
            {cancellationConflict && <button type="button" onClick={async () => { await Promise.all([refetchHistory(), refetchSales()]); setCancelling(null); setCancellationError(''); setCancellationConflict(false); }} className="h-10 rounded-xl border border-[#ded7e7] px-4 text-xs font-bold text-[#5d4a78] hover:bg-[#f7f4fa]" data-testid="button-refresh-cancel-conflict">Atualizar venda</button>}
            <button type="button" onClick={() => setCancelling(null)} disabled={cancelSale.isPending} className="h-10 rounded-xl border border-[#e3dfe7] px-4 text-sm font-bold text-[#716a79] hover:bg-[#f8f6fa]" data-testid="button-cancel-cancellation">Manter venda</button>
            <button type="button" onClick={() => void confirmCancellation()} disabled={!cancellationReason.trim() || cancellationReason.trim().length > 500 || busy} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#a84940] px-4 text-sm font-bold text-white hover:bg-[#963c35] disabled:opacity-55" data-testid="button-confirm-cancellation">
              {cancelSale.isPending ? 'Cancelando…' : <><X size={14} /> Confirmar cancelamento</>}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {historySale && <SaleHistoryDialog sale={historySale} onClose={() => setHistorySale(null)} />}
    </>
  );
}

function SaleRow({ sale, onEdit, onHistory, onCancel, busy }: { sale: Sale; onEdit: () => void; onHistory: () => void; onCancel: () => void; busy: boolean }) {
  const cancelled = sale.status === 'cancelled';
  return <article className={`grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 rounded-2xl border px-3 py-3 transition lg:grid-cols-[94px_88px_minmax(130px,1fr)_58px_116px_100px_188px] lg:items-center lg:gap-2 ${cancelled ? 'border-[#ede8e9] bg-[#fcfafa]' : 'border-[#f0edf2] hover:border-[#e5dfeb] hover:bg-[#fdfcfe]'}`} data-testid={`row-sale-${sale.id}`}>
    <span className="col-start-1 row-start-1 text-[11px] font-medium text-[#6f6879] lg:order-1" data-testid={`text-sale-date-${sale.id}`}>{formatDate(sale.saleDate, { day: '2-digit', month: 'short', year: 'numeric' })}</span>
    <span className="col-start-2 row-start-1 justify-self-end text-[10px] font-bold text-[#81798b] lg:order-2">{cancelled ? 'Cancelamento' : 'Venda'}</span>
    <div className="col-span-2 row-start-2 min-w-0 lg:col-span-1 lg:row-auto lg:order-3">
      <p className={`truncate text-sm font-bold ${cancelled ? 'text-[#77717f]' : 'text-[#353044]'}`} data-testid={`text-sale-product-${sale.id}`}>{sale.productName}</p>
      {sale.customerName && <p className="mt-1 truncate text-[10px] font-medium text-[#5d4a78]" title={sale.customerName} data-testid={`text-sale-customer-name-${sale.id}`}>Nome: {sale.customerName}</p>}
      {sale.notes && <p className="mt-1 truncate text-[10px] text-[#81798b]" title={sale.notes}>{sale.notes}</p>}
      {cancelled && sale.cancellationReason && <p className="mt-1 truncate text-[10px] text-[#9a625b]" title={sale.cancellationReason} data-testid={`text-sale-cancellation-reason-${sale.id}`}>Motivo: {sale.cancellationReason}</p>}
    </div>
    <span className="col-start-1 row-start-3 text-[11px] text-[#746d7b] lg:col-auto lg:row-auto lg:order-4">{sale.quantity} un.</span>
    <span className={`col-start-2 row-start-3 justify-self-end whitespace-nowrap text-right text-sm font-bold tabular-nums lg:col-auto lg:row-auto lg:order-5 ${cancelled ? 'text-[#817b86] line-through decoration-[#b38b86]' : 'text-[#403650]'}`} data-testid={`text-sale-total-${sale.id}`}>{formatCents(sale.totalCents)}</span>
    <span className={`col-start-1 row-start-4 justify-self-start rounded-full px-2.5 py-1 text-[10px] font-bold lg:col-auto lg:row-auto lg:order-6 ${cancelled ? 'bg-[#f2ecec] text-[#796565]' : 'bg-[#eff6e5] text-[#55772c]'}`} data-testid={`status-sale-${sale.id}`}>{cancelled ? 'Cancelada' : 'Ativa'}</span>
    <div className="col-start-2 row-start-4 flex justify-end gap-1 lg:col-auto lg:row-auto lg:order-7">
      <button type="button" onClick={onHistory} aria-label={`Ver histórico da venda ${sale.productName}`} className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-[#776b88] transition hover:bg-[#f1edf7] hover:text-[#6848a9]" data-testid={`button-sale-history-${sale.id}`}><History size={15} /></button>
      {!cancelled && <>
        <button type="button" onClick={onEdit} disabled={busy} aria-label={`Editar venda ${sale.productName}`} className="inline-flex h-10 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-bold text-[#716a79] transition hover:bg-[#f0ebf7] hover:text-[#6848a9] disabled:opacity-40" data-testid={`button-edit-sale-${sale.id}`}><Edit3 size={14} /> Editar</button>
        <button type="button" onClick={onCancel} disabled={busy} aria-label={`Cancelar venda ${sale.productName}`} className="inline-flex h-10 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-bold text-[#98706b] transition hover:bg-[#fff0ed] hover:text-[#a84940] disabled:opacity-40" data-testid={`button-cancel-sale-${sale.id}`}><X size={14} /> Cancelar</button>
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
