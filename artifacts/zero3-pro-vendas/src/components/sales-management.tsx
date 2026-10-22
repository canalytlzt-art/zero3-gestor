import { useMemo, useRef, useState, type ChangeEvent, type InputHTMLAttributes } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, CalendarDays, Check, CircleHelp, ClipboardList, Download, Edit3, FileSpreadsheet, Filter, History, PackagePlus, Plus, RefreshCw, RotateCcw, Save, Search, Upload, X } from 'lucide-react';
import {
  getGetProductsQueryKey,
  getGetSaleHistoryQueryKey,
  getGetSalesHistoryQueryKey,
  getGetSalesGoalsQueryKey,
  getGetSalesQueryKey,
  useCancelSale,
  useCreateProduct,
  useCreateSale,
  useGetProducts,
  useGetSaleHistory,
  useGetSales,
  useGetSalesHistory,
  useGetSalesGoals,
  useImportSales,
  useRestoreMonthlySalesBackup,
  useUpdateProduct,
  useUpdateSale,
} from '@workspace/api-client-react';
import type { CreateProductInput, MonthlySalesBackupInput, Product, Sale, SaleInput, SalesImportRow, SalesRestoreResult, UpdateProductInput } from '@workspace/api-client-react';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { createMonthlySalesBackup, downloadMonthlyBackup, parseMonthlySalesBackup } from '@/lib/sales-export';
import { formatCents, formatMonthKey, getSaoPauloMonthKey, normalizeProductName, productNameKey } from '@/lib/sales-utils';

const MAX_BACKUP_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMPORT_ROWS = 500;

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

const productFormSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome do produto.').max(120, 'Use até 120 caracteres.'),
  suggestedPrice: z.string().min(1, 'Informe o preço sugerido.').refine((value) => parseBrlCents(value) !== null, 'Informe um valor em reais válido.'),
  isActive: z.boolean(),
});
type ProductFormValues = z.infer<typeof productFormSchema>;

type ImportMappingKey = 'saleDate' | 'productName' | 'quantity' | 'unitAmount' | 'notes';
type ImportLine = { sourceRow: number; cells: unknown[]; value: SalesImportRow | null; errors: string[]; possibleMatches: Sale[] };
type ImportWorkspace = {
  filename: string;
  fileHash: string;
  headers: string[];
  lines: { sourceRow: number; cells: unknown[] }[];
  mappings: Record<ImportMappingKey, string>;
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

function parseImportDate(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000);
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }
  const text = String(value ?? '').trim();
  if (isValidCalendarDate(text)) return text;
  const br = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(text);
  if (br) {
    const normalized = `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
    return isValidCalendarDate(normalized) ? normalized : null;
  }
  const isoSlash = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text);
  if (isoSlash) {
    const normalized = `${isoSlash[1]}-${isoSlash[2].padStart(2, '0')}-${isoSlash[3].padStart(2, '0')}`;
    return isValidCalendarDate(normalized) ? normalized : null;
  }
  return null;
}

function parseImportQuantity(value: unknown): number | null {
  const text = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed <= 2147483647 ? parsed : null;
}

function rowByMapping(workspace: ImportWorkspace, line: { sourceRow: number; cells: unknown[] }): Omit<ImportLine, 'possibleMatches'> {
  const cell = (key: ImportMappingKey) => line.cells[workspace.headers.indexOf(workspace.mappings[key])];
  const productName = normalizeProductName(String(cell('productName') ?? ''));
  const saleDate = parseImportDate(cell('saleDate'));
  const quantity = parseImportQuantity(cell('quantity'));
  const unitAmountCents = parseBrlCents(String(cell('unitAmount') ?? ''));
  const noteRaw = workspace.mappings.notes ? String(cell('notes') ?? '').trim().replace(/\s+/g, ' ') : '';
  const errors: string[] = [];
  if (!saleDate) errors.push('Data inválida.');
  if (!productName) errors.push('Produto obrigatório.');
  else if (productName.length > 120) errors.push('Produto acima de 120 caracteres.');
  if (quantity === null) errors.push('Quantidade deve ser um inteiro positivo.');
  if (unitAmountCents === null) errors.push('Valor deve ter no máximo duas casas decimais.');
  if (noteRaw.length > 1000) errors.push('Observação acima de 1.000 caracteres.');
  if (![saleDate, productName, quantity, unitAmountCents].some(Boolean) && !noteRaw) {
    return { sourceRow: line.sourceRow, cells: line.cells, value: null, errors: ['Linha vazia; será ignorada.'] };
  }
  return {
    sourceRow: line.sourceRow,
    cells: line.cells,
    value: saleDate && productName && quantity !== null && unitAmountCents !== null && noteRaw.length <= 1000
      ? { saleDate, productName, quantity, unitAmountCents, notes: noteRaw || null, sourceRow: line.sourceRow }
      : null,
    errors,
  };
}

function formatDate(value: string, options: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' }) {
  return new Date(`${value}T12:00:00`).toLocaleDateString('pt-BR', options);
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

function Field({ label, name, type = 'text', placeholder, testId, onChange, ...props }: {
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
        <input {...field} {...props} onChange={(event) => { field.onChange(event); onChange?.(event); }} type={type} placeholder={placeholder} data-testid={testId}
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
  const { data: historySales, isLoading: isHistoryLoading, isError: isHistoryError, refetch: refetchHistory } = useGetSalesHistory({
    query: { queryKey: getGetSalesHistoryQueryKey(), refetchOnMount: 'always' },
  });
  const { data: productRecords, isLoading: isProductsLoading, isError: isProductsError, refetch: refetchProducts } = useGetProducts({
    query: { queryKey: getGetProductsQueryKey(), refetchOnMount: 'always' },
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
  const createProduct = useCreateProduct();
  const updateProduct = useUpdateProduct();
  const importSales = useImportSales();
  const restoreBackup = useRestoreMonthlySalesBackup();
  const [editing, setEditing] = useState<Sale | null>(null);
  const [cancelling, setCancelling] = useState<Sale | null>(null);
  const [historySale, setHistorySale] = useState<Sale | null>(null);
  const [cancellationReason, setCancellationReason] = useState('');
  const [cancellationError, setCancellationError] = useState('');
  const [cancellationConflict, setCancellationConflict] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [filterProduct, setFilterProduct] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'cancelled'>('all');
  const [historyHint, setHistoryHint] = useState('');
  const [productsOpen, setProductsOpen] = useState(false);
  const [productSearch, setProductSearch] = useState('');
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [productFeedback, setProductFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importWorkspace, setImportWorkspace] = useState<ImportWorkspace | null>(null);
  const [importError, setImportError] = useState('');
  const [importFeedback, setImportFeedback] = useState('');
  const [skippedImportRows, setSkippedImportRows] = useState<Set<number>>(new Set());
  const importFileRef = useRef<HTMLInputElement>(null);
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
  const busy = createSale.isPending || updateSale.isPending || cancelSale.isPending
    || createProduct.isPending || updateProduct.isPending || importSales.isPending;
  const operationLock = useRef(false);
  const pendingSaleKey = useRef<{ fingerprint: string; key: string } | null>(null);
  const pendingProductKey = useRef<{ fingerprint: string; key: string } | null>(null);
  const pendingCancellationKey = useRef<{ fingerprint: string; key: string } | null>(null);
  const completedImportHashes = useRef(new Set<string>());

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
    () => filterSalesForExport(historySales ?? [], fromDate, toDate, filterProduct)
      .filter((sale) => filterStatus === 'all' || sale.status === filterStatus),
    [historySales, fromDate, toDate, filterProduct, filterStatus],
  );
  const visibleProducts = useMemo(() => products.filter((product) => product.name.toLocaleLowerCase('pt-BR').includes(productSearch.trim().toLocaleLowerCase('pt-BR'))), [products, productSearch]);
  const backupMonthSales = useMemo(
    () => (sales ?? []).filter((sale) => sale.saleDate.slice(0, 7) === backupMonth),
    [sales, backupMonth],
  );
  const backupMonthGoals = useMemo(
    () => (salesGoals ?? []).filter((goal) => goal.month === backupMonth),
    [salesGoals, backupMonth],
  );

  const productForm = useForm<ProductFormValues>({
    resolver: zodResolver(productFormSchema),
    defaultValues: { name: '', suggestedPrice: '', isActive: true },
  });
  const importedLines = useMemo(() => importWorkspace ? importWorkspace.lines
    .map((line) => rowByMapping(importWorkspace, line))
    .map((line) => ({
      ...line,
      possibleMatches: line.value ? (historySales ?? []).filter((sale) =>
        sale.saleDate === line.value?.saleDate
        && productNameKey(sale.productName) === productNameKey(line.value.productName)
        && sale.quantity === line.value.quantity
        && sale.unitAmountCents === line.value.unitAmountCents) : [],
    })) : [], [importWorkspace, historySales]);
  const validImportRows = useMemo(() => importedLines.flatMap((line) => {
    if (!line.value) return [];
    const canonical = products.find((product) => productNameKey(product.name) === productNameKey(line.value!.productName));
    return skippedImportRows.has(line.sourceRow) ? [] : [{ ...line.value, productName: canonical?.name ?? line.value.productName }];
  }), [importedLines, products, skippedImportRows]);
  const possibleDuplicateCount = importedLines.filter((line) => line.value && line.possibleMatches.length > 0).length;
  const skippedImportCount = importedLines.filter((line) => !line.value || skippedImportRows.has(line.sourceRow)).length;
  const importOverLimit = validImportRows.length > MAX_IMPORT_ROWS;
  const importMappingIncomplete = !importWorkspace || (['saleDate', 'productName', 'quantity', 'unitAmount'] as const)
    .some((key) => !importWorkspace.mappings[key]);

  async function invalidateSalesRelated() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetSalesQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetSalesHistoryQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetProductsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetSalesGoalsQueryKey() }),
    ]);
  }

  function openProductManager() {
    setProductFeedback(null);
    setEditingProduct(null);
    setProductSearch('');
    productForm.reset({ name: '', suggestedPrice: '', isActive: true });
    setProductsOpen(true);
  }

  function editProduct(product: Product) {
    setProductFeedback(null);
    setEditingProduct(product);
    productForm.reset({
      name: product.name,
      suggestedPrice: `${Math.floor(product.suggestedPriceCents / 100)},${String(product.suggestedPriceCents % 100).padStart(2, '0')}`,
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
    const fingerprint = `${editingProduct?.id ?? 'novo'}:${editingProduct?.version ?? ''}:${name}:${suggestedPriceCents}:${values.isActive}`;
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
          isActive: values.isActive,
          expectedVersion: editingProduct.version,
          idempotencyKey: pendingProductKey.current.key,
        };
        await updateProduct.mutateAsync({ id: editingProduct.id, data });
        setProductFeedback({ type: 'success', message: 'Produto atualizado. Os lançamentos anteriores mantêm seus dados originais.' });
      } else {
        const data: CreateProductInput = {
          name,
          suggestedPriceCents,
          isActive: values.isActive,
          idempotencyKey: pendingProductKey.current.key,
        };
        await createProduct.mutateAsync({ data });
        setProductFeedback({ type: 'success', message: 'Produto cadastrado.' });
      }
      await invalidateSalesRelated();
      setEditingProduct(null);
      pendingProductKey.current = null;
      productForm.reset({ name: '', suggestedPrice: '', isActive: true });
    } catch (error) {
      setProductFeedback({ type: 'error', message: conflictAwareMessage(error, 'produto') });
      if (error && typeof error === 'object' && 'status' in error && error.status === 409) void invalidateSalesRelated();
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
    if (!file) return;
    if (!/\.(csv|xlsx)$/i.test(file.name)) {
      setImportError('Selecione um arquivo CSV ou XLSX.');
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
      if (completedImportHashes.current.has(fileHash)) {
        setImportFeedback('Este arquivo já foi importado. Nenhuma venda duplicada foi criada.');
        setImportOpen(false);
        return;
      }
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(bytes, { type: 'array', cellDates: false });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) throw new Error('O arquivo não contém uma planilha.');
      const grid = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], { header: 1, raw: true, defval: '' }) as unknown[][];
      if (grid.length < 2 || !grid[0]?.length) throw new Error('Inclua uma linha de cabeçalhos e ao menos uma linha de dados.');
      const headers = grid[0].map((value, index) => String(value ?? '').trim() || `Coluna ${index + 1}`);
      const uniqueHeaders = headers.map((header, index) => headers.slice(0, index).includes(header) ? `${header} (${index + 1})` : header);
      const normalized = uniqueHeaders.map((header) => header.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
      const findHeader = (patterns: RegExp[]) => uniqueHeaders[normalized.findIndex((header) => patterns.some((pattern) => pattern.test(header)))] ?? '';
      const mappings: ImportWorkspace['mappings'] = {
        saleDate: findHeader([/^data$/, /data.*venda/, /sale.?date/]),
        productName: findHeader([/produto/, /plano/, /product/]),
        quantity: findHeader([/^qtd/, /quantidade/, /quantity/]),
        unitAmount: findHeader([/valor.*unit/, /preco.*unit/, /unit.*price/, /^valor$/]),
        notes: findHeader([/observ/, /nota/, /note/]),
      };
      setImportWorkspace({
        filename: file.name,
        fileHash,
        headers: uniqueHeaders,
        lines: grid.slice(1).map((cells, index) => ({ sourceRow: index + 2, cells })),
        mappings,
      });
      setImportOpen(true);
    } catch (error) {
      setImportError(errorMessage(error));
      setImportOpen(true);
    }
  }

  async function commitImport() {
    if (!importWorkspace || importMappingIncomplete || !validImportRows.length || importOverLimit || isHistoryLoading || isHistoryError || importSales.isPending || operationLock.current) return;
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
      completedImportHashes.current.add(workspace.fileHash);
      await invalidateSalesRelated();
      setImportFeedback(result.replayed || result.importedCount === 0
        ? `Este arquivo já foi importado. Nenhuma venda duplicada foi criada.`
        : `${result.importedCount} ${result.importedCount === 1 ? 'venda importada' : 'vendas importadas'} de ${workspace.filename}.`);
      setImportWorkspace(null);
    } catch (error) {
      const apiStatus = error && typeof error === 'object' && 'status' in error ? error.status : null;
      const message = errorMessage(error);
      if (apiStatus === 409 || /já (foi )?importad|already imported|duplicate file|arquivo duplicado/i.test(message)) {
        completedImportHashes.current.add(workspace.fileHash);
        setImportFeedback('Este arquivo já foi importado. Nenhuma venda duplicada foi criada.');
        setImportWorkspace(null);
      } else {
        setImportError(message);
      }
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
      await invalidateSalesRelated();
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
    pendingSaleKey.current = null;
    setEditing(null);
    form.reset({ saleDate: todayLocal(), productName: '', quantity: '1', unitAmount: '', notes: '' });
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
          <button type="button" onClick={() => { setFromDate(''); setToDate(''); setFilterProduct(''); setFilterStatus('active'); setHistoryHint('Escolha uma venda ativa no histórico para iniciar o cancelamento.'); document.getElementById('sales-history-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[#e9d9d5] bg-[#fffaf8] px-4 text-sm font-bold text-[#8e554e] transition hover:bg-[#fff0ed]" data-testid="button-new-cancellation"><RotateCcw size={15} /> Novo estorno</button>
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
                  <Field name="productName" label="Plano ou produto" placeholder="Ex.: Plano Essencial" testId="input-sale-product" list="sale-product-suggestions" autoComplete="off" onChange={(event) => {
                    if (form.getValues('unitAmount')) return;
                    const matched = activeProducts.find((product) => productNameKey(product.name) === productNameKey(event.target.value));
                    if (matched) form.setValue('unitAmount', formatCentsInput(matched.suggestedPriceCents), { shouldValidate: true });
                  }} />
                  <datalist id="sale-product-suggestions">{activeProducts.map((product) => <option key={product.id} value={product.name} />)}</datalist>
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

        <div id="sales-history-panel" className="min-w-0 rounded-[24px] border border-[#e9e4ec] bg-white p-5 shadow-[0_7px_28px_rgba(47,38,63,.035)] md:p-6">
          <div className="mb-5 flex items-center justify-between gap-3">
            <div><p className="eyebrow text-[9px] font-bold text-[#8b8494]">histórico</p><h2 className="mt-1 text-lg font-bold tracking-[-.035em]">Histórico de vendas</h2></div>
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#f1edf7] text-[#7656b8]"><ClipboardList size={17} /></span>
          </div>
          {historyHint && <p className="mb-3 rounded-xl bg-[#fcf8ed] px-3.5 py-2.5 text-xs font-semibold text-[#725d2d]" role="status" data-testid="status-cancellation-hint">{historyHint}</p>}
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
                  {productNames.map((product) => <option key={product} value={product}>{product}</option>)}
                </select>
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

      <Dialog open={productsOpen} onOpenChange={(open) => { if (!(createProduct.isPending || updateProduct.isPending)) setProductsOpen(open); }}>
        <DialogContent className="max-w-3xl border-[#e7e1e9] bg-[#fffefc] p-5 sm:rounded-[24px] md:p-6">
          <DialogHeader className="text-left">
            <DialogTitle className="text-lg font-extrabold tracking-[-.035em] text-[#332d40]">Produtos</DialogTitle>
            <DialogDescription className="text-xs leading-5 text-[#827b8b]">Gerencie nomes e preços sugeridos. Alterações não modificam os dados de vendas anteriores.</DialogDescription>
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
                        <p className="mt-0.5 text-[10px] text-[#8a8491]">{formatCents(product.suggestedPriceCents)} · {product.isActive ? 'Ativo' : 'Inativo'}</p>
                      </div>
                      <button type="button" onClick={() => editProduct(product)} aria-label={`Editar produto ${product.name}`} className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-[#776b88] hover:bg-[#f1edf7] hover:text-[#6848a9]" data-testid={`button-edit-product-${product.id}`}><Edit3 size={15} /></button>
                    </article>) : <div className="rounded-xl border border-dashed border-[#ded7e7] p-5 text-center text-xs text-[#817b89]" data-testid="status-products-empty">{products.length ? 'Nenhum produto encontrado.' : 'Nenhum produto cadastrado ainda.'}</div>}
              </div>
            </section>
            <section className="rounded-2xl bg-[#f8f6fa] p-4">
              <h3 className="text-sm font-bold text-[#40374e]">{editingProduct ? 'Editar produto' : 'Cadastrar produto'}</h3>
              <Form {...productForm}>
                <form onSubmit={productForm.handleSubmit(saveProduct)} className="mt-3 space-y-3">
                  <FormField name="name" render={({ field }) => <FormItem className="space-y-1.5"><FormLabel className="text-[11px] font-bold text-[#665f70]">Nome do produto</FormLabel><FormControl><input {...field} maxLength={120} placeholder="Ex.: Plano Essencial" data-testid="input-product-name" className="h-11 w-full rounded-xl border border-[#e7e2ea] bg-white px-3.5 text-sm text-[#342d43] outline-none focus:border-[#9477bf]" /></FormControl><FormMessage className="text-[11px]" /></FormItem>} />
                  <FormField name="suggestedPrice" render={({ field }) => <FormItem className="space-y-1.5"><FormLabel className="text-[11px] font-bold text-[#665f70]">Preço sugerido</FormLabel><FormControl><input {...field} inputMode="decimal" placeholder="0,00" data-testid="input-product-suggested-price" className="h-11 w-full rounded-xl border border-[#e7e2ea] bg-white px-3.5 text-sm text-[#342d43] outline-none focus:border-[#9477bf]" /></FormControl><FormMessage className="text-[11px]" /></FormItem>} />
                  <FormField name="isActive" render={({ field }) => <FormItem className="flex items-center justify-between rounded-xl border border-[#e9e4ec] bg-white px-3.5 py-3"><div><FormLabel className="text-xs font-bold text-[#4b4356]">Produto ativo</FormLabel><p className="mt-0.5 text-[10px] text-[#8a8491]">Produtos inativos não aparecem em novas vendas.</p></div><FormControl><input type="checkbox" checked={field.value} onChange={field.onChange} data-testid="input-product-active" className="h-5 w-5 accent-[#7656b8]" /></FormControl></FormItem>} />
                  {productFeedback && <p role={productFeedback.type === 'error' ? 'alert' : 'status'} className={`rounded-xl px-3 py-2.5 text-[11px] font-semibold ${productFeedback.type === 'error' ? 'bg-[#fff0ed] text-[#9c483f]' : 'bg-[#eff6e5] text-[#55772c]'}`} data-testid={`status-product-${productFeedback.type}`}>{productFeedback.message}</p>}
                  <div className="flex gap-2">
                    {editingProduct && <button type="button" onClick={() => { setEditingProduct(null); pendingProductKey.current = null; productForm.reset({ name: '', suggestedPrice: '', isActive: true }); }} className="h-10 rounded-xl border border-[#e3dfe7] px-3 text-xs font-bold text-[#716a79]" data-testid="button-cancel-product-edit">Cancelar edição</button>}
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

      <Dialog open={importOpen} onOpenChange={(open) => { if (!importSales.isPending) setImportOpen(open); }}>
        <DialogContent className="max-w-4xl border-[#e7e1e9] bg-[#fffefc] p-5 sm:rounded-[24px] md:p-6">
          <DialogHeader className="text-left">
            <DialogTitle className="text-lg font-extrabold tracking-[-.035em] text-[#332d40]">Importar vendas</DialogTitle>
            <DialogDescription className="text-xs leading-5 text-[#827b8b]">Mapeie as colunas, revise cada linha e confirme antes de registrar os dados.</DialogDescription>
          </DialogHeader>
          {importError && <p className="rounded-xl bg-[#fff0ed] px-3.5 py-2.5 text-xs font-semibold text-[#9c483f]" role="alert" data-testid="status-import-error">{importError}</p>}
          {!importWorkspace ? <div className="rounded-2xl border border-dashed border-[#ded7e7] p-6 text-center">
            <FileSpreadsheet className="mx-auto text-[#7656b8]" size={24} />
            <p className="mt-3 text-sm font-bold text-[#40374e]">Selecione um arquivo CSV ou XLSX</p>
            <p className="mt-1 text-xs text-[#817b89]">O arquivo original é conferido por hash para impedir importações repetidas.</p>
            <button type="button" onClick={() => importFileRef.current?.click()} className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl bg-[#d7f500] px-4 text-xs font-extrabold text-[#262b15]" data-testid="button-select-import-file"><Upload size={14} /> Escolher arquivo</button>
          </div> : <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[#f8f6fa] px-3.5 py-3">
              <div className="min-w-0"><p className="truncate text-sm font-bold text-[#40374e]" data-testid="text-import-filename">{importWorkspace.filename}</p><p className="mt-0.5 text-[10px] text-[#817b89]">Hash SHA-256 calculado a partir dos bytes originais.</p></div>
              <span className="rounded-full bg-white px-3 py-1.5 text-[10px] font-bold text-[#5d4a78]" data-testid="text-import-valid-count">{validImportRows.length} para importar · {skippedImportCount} ignoradas</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              {([
                ['saleDate', 'Data da venda', true],
                ['productName', 'Produto', true],
                ['quantity', 'Quantidade', true],
                ['unitAmount', 'Valor unitário', true],
                ['notes', 'Observação', false],
              ] as const).map(([key, label, required]) => <label key={key} className="min-w-0 text-[10px] font-bold text-[#665f70]">{label}{required ? ' *' : ''}
                <select value={importWorkspace.mappings[key]} onChange={(event) => setImportWorkspace({ ...importWorkspace, mappings: { ...importWorkspace.mappings, [key]: event.target.value } })} data-testid={`select-import-map-${key}`} className="mt-1 h-10 w-full rounded-lg border border-[#e7e2ea] bg-white px-2 text-xs font-medium text-[#443d50] outline-none focus:border-[#9477bf]">
                  <option value="">{required ? 'Selecione a coluna' : 'Não importar'}</option>
                  {importWorkspace.headers.map((header) => <option key={header} value={header}>{header}</option>)}
                </select>
              </label>)}
            </div>
            {importMappingIncomplete && <p className="rounded-xl bg-[#fff5e8] px-3.5 py-2.5 text-xs font-semibold text-[#805824]" role="alert" data-testid="status-import-mapping-required">Mapeie as quatro colunas obrigatórias para validar as linhas.</p>}
            {importOverLimit && <p className="rounded-xl bg-[#fff5e8] px-3.5 py-2.5 text-xs font-semibold text-[#805824]" role="alert" data-testid="status-import-limit">Este arquivo tem mais de 500 linhas válidas. Divida o arquivo para importar sem omitir vendas.</p>}
            <div className="max-h-[300px] overflow-auto rounded-xl border border-[#e9e4ec]" data-testid="table-import-preview">
              <table className="w-full min-w-[660px] border-collapse text-left text-xs">
                <thead className="sticky top-0 bg-[#f1edf7] text-[10px] font-bold uppercase tracking-[.08em] text-[#655579]"><tr><th className="px-3 py-2.5">Linha</th><th className="px-3 py-2.5">Data</th><th className="px-3 py-2.5">Produto</th><th className="px-3 py-2.5">Qtd.</th><th className="px-3 py-2.5">Valor</th><th className="px-3 py-2.5">Resultado</th></tr></thead>
                <tbody className="divide-y divide-[#f0edf2]">
                  {importedLines.map((line) => <tr key={line.sourceRow} className={line.value ? 'bg-white' : 'bg-[#fffaf9]'} data-testid={`row-import-${line.sourceRow}`}>
                    <td className="px-3 py-2.5 tabular-nums text-[#817b89]">{line.sourceRow}</td>
                    <td className="px-3 py-2.5 text-[#4b4356]">{line.value ? formatDate(line.value.saleDate) : '—'}</td>
                    <td className="max-w-[180px] truncate px-3 py-2.5 text-[#4b4356]">{line.value?.productName ?? '—'}</td>
                    <td className="px-3 py-2.5 tabular-nums text-[#4b4356]">{line.value?.quantity ?? '—'}</td>
                    <td className="px-3 py-2.5 tabular-nums text-[#4b4356]">{line.value ? formatCents(line.value.unitAmountCents) : '—'}</td>
                    <td className="px-3 py-2.5">
                      {line.value && (line.possibleMatches.length > 0 || skippedImportRows.has(line.sourceRow)) ? <div className="space-y-1.5">
                        <span className={`inline-flex rounded-full px-2 py-1 text-[10px] font-bold ${skippedImportRows.has(line.sourceRow) ? 'bg-[#f2ecec] text-[#796565]' : 'bg-[#fcf3df] text-[#805824]'}`} data-testid={`status-import-row-${line.sourceRow}`}>
                          {skippedImportRows.has(line.sourceRow) ? 'Marcada para ignorar' : `Possível duplicidade · ${line.possibleMatches.length} venda(s) coincidente(s)`}
                        </span>
                        <label className="flex min-h-8 items-center gap-1.5 text-[10px] font-medium text-[#6f6879]">
                          <input type="checkbox" checked={!skippedImportRows.has(line.sourceRow)} onChange={(event) => setSkippedImportRows((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.delete(line.sourceRow);
                            else next.add(line.sourceRow);
                            return next;
                          })} data-testid={`checkbox-import-include-${line.sourceRow}`} className="h-4 w-4 accent-[#7656b8]" />
                          Incluir esta linha
                        </label>
                        {line.possibleMatches.length > 0 && <ul className="space-y-0.5 text-[9px] leading-4 text-[#807763]" aria-label={`Vendas coincidentes da linha ${line.sourceRow}`}>
                          {line.possibleMatches.slice(0, 2).map((match, index) => <li key={`${match.saleDate}-${index}`} data-testid={`text-import-match-${line.sourceRow}-${index}`}>No histórico: {match.status === 'cancelled' ? 'cancelada' : 'ativa'} · {match.quantity} un. · {formatCents(match.unitAmountCents)} / un.</li>)}
                          {line.possibleMatches.length > 2 && <li>Mais {line.possibleMatches.length - 2} correspondências.</li>}
                        </ul>}
                      </div> : <span className={`inline-flex rounded-full px-2 py-1 text-[10px] font-bold ${line.value ? 'bg-[#eff6e5] text-[#55772c]' : 'bg-[#fff0ed] text-[#9c483f]'}`} data-testid={`status-import-row-${line.sourceRow}`}>{line.value ? 'Será importada' : line.errors.join(' ') || 'Linha vazia'}</span>}
                    </td>
                  </tr>)}
                </tbody>
              </table>
            </div>
            <div className="rounded-xl border border-[#e9e0c8] bg-[#fcf8ed] px-3.5 py-3 text-[10px] leading-5 text-[#725d2d]">
              {possibleDuplicateCount > 0 ? `${possibleDuplicateCount} linha(s) com possível duplicidade sinalizada(s); nenhuma é removida automaticamente e elas permanecem incluídas até você desmarcá-las.` : 'Nenhuma possível duplicidade encontrada nos registros existentes.'} Serão enviadas {importOverLimit || importMappingIncomplete ? '0' : validImportRows.length} linhas; {skippedImportCount} linhas inválidas, vazias ou desmarcadas serão ignoradas. Nenhum dado é salvo até você confirmar.
            </div>
          </>}
          <DialogFooter className="gap-2">
            <button type="button" onClick={() => { setImportOpen(false); setImportWorkspace(null); setImportError(''); }} disabled={importSales.isPending} className="h-10 rounded-xl border border-[#e3dfe7] px-4 text-sm font-bold text-[#716a79] hover:bg-[#f8f6fa] disabled:opacity-50" data-testid="button-cancel-import">Cancelar</button>
            {importWorkspace && <button type="button" onClick={() => void commitImport()} disabled={!validImportRows.length || importOverLimit || importMappingIncomplete || busy} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#7656b8] px-4 text-sm font-bold text-white hover:bg-[#6848a9] disabled:opacity-55" data-testid="button-confirm-import">
              {importSales.isPending ? 'Importando…' : <><Check size={14} /> Confirmar importação</>}
            </button>}
          </DialogFooter>
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
