import { Download } from 'lucide-react';

const appBasePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const PDF_READY_TIMEOUT_MS = 5_000;
const CHART_SETTLE_TIMEOUT_MS = 4_000;
const CHART_QUIET_WINDOW_MS = 350;

function waitForFrame() {
  return new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

function waitForTimeout(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitForChartQuiet(root: ParentNode) {
  const charts = [...root.querySelectorAll('svg.recharts-surface')];
  if (!charts.length) {
    await waitForFrame();
    await waitForFrame();
    return;
  }

  let lastMutation = performance.now();
  const observer = new MutationObserver(() => { lastMutation = performance.now(); });
  charts.forEach((chart) => observer.observe(chart, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  }));

  const startedAt = performance.now();
  try {
    while (performance.now() - startedAt < CHART_SETTLE_TIMEOUT_MS
      && performance.now() - lastMutation < CHART_QUIET_WINDOW_MS) {
      await waitForTimeout(50);
    }
  } finally {
    observer.disconnect();
  }
}

async function waitForPdfAssets(root: ParentNode) {
  const fontsReady = document.fonts?.ready.catch(() => undefined) ?? Promise.resolve();
  const imageReady = [...root.querySelectorAll('img')].map(async (image) => {
    if (!image.complete) {
      await new Promise<void>((resolve) => {
        image.addEventListener('load', () => resolve(), { once: true });
        image.addEventListener('error', () => resolve(), { once: true });
      });
    }
    if (image.decode) await image.decode().catch(() => undefined);
  });

  await Promise.race([
    Promise.allSettled([fontsReady, ...imageReady]).then(() => undefined),
    waitForTimeout(PDF_READY_TIMEOUT_MS),
  ]);
}

async function prepareDashboardPdf() {
  const root = document.querySelector('.pdf-report-root') ?? document.body;
  await waitForPdfAssets(root);
  await waitForFrame();
  await waitForFrame();
  await waitForChartQuiet(root);
  await waitForFrame();
}

function fileSlug(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export async function beginDashboardPdf(
  scope: string,
  title: string,
  period = '',
  options: { includeDetails?: boolean } = {},
) {
  if (document.body.dataset.zero3PdfPreparing === 'true') return;

  const previousTitle = document.title;
  const previousScope = document.body.dataset.zero3PdfScope;
  const previousDetails = document.body.dataset.zero3PdfDetails;
  const previousPreparing = document.body.dataset.zero3PdfPreparing;
  const printStyleId = 'zero3-dashboard-pdf-page-style';
  const previousPrintStyle = document.getElementById(printStyleId) as HTMLStyleElement | null;
  const previousPrintRule = previousPrintStyle?.textContent ?? null;
  const printStyle = previousPrintStyle ?? document.createElement('style');
  const landscape = scope === 'complete-full' || scope === 'financial-timeline' || scope === 'contracts-monthly';

  printStyle.id = printStyleId;
  printStyle.textContent = `@page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 9mm; }`;
  if (!previousPrintStyle) document.head.append(printStyle);
  document.body.dataset.zero3PdfScope = scope;
  document.body.dataset.zero3PdfDetails = String(
    scope === 'complete-full' ? options.includeDetails !== false : options.includeDetails === true,
  );
  document.body.dataset.zero3PdfPreparing = 'true';
  document.title = `Zero3-PRO-${fileSlug(title)}${period ? `-${fileSlug(period)}` : ''}`;

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    window.removeEventListener('afterprint', restore);
    document.title = previousTitle;
    if (previousScope) document.body.dataset.zero3PdfScope = previousScope;
    else delete document.body.dataset.zero3PdfScope;
    if (previousDetails !== undefined) document.body.dataset.zero3PdfDetails = previousDetails;
    else delete document.body.dataset.zero3PdfDetails;
    if (previousPreparing !== undefined) document.body.dataset.zero3PdfPreparing = previousPreparing;
    else delete document.body.dataset.zero3PdfPreparing;
    if (previousPrintRule !== null) printStyle.textContent = previousPrintRule;
    else printStyle.remove();
  };
  window.addEventListener('afterprint', restore, { once: true });

  try {
    await prepareDashboardPdf();
    if (typeof window.print !== 'function') {
      restore();
      return;
    }
    window.print();
  } catch {
    restore();
  }
}

export function DownloadPdfButton({
  scope,
  title,
  period,
  compact = false,
  disabled = false,
}: {
  scope: string;
  title: string;
  period?: string;
  compact?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => { void beginDashboardPdf(scope, title, period); }}
      disabled={disabled}
      className={`dashboard-pdf-hide inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[#e5ddec] bg-[#faf8fc] font-bold text-[#65479c] transition hover:bg-[#f0eaf6] disabled:cursor-not-allowed disabled:opacity-50 ${compact ? 'h-8 px-2.5 text-[10px]' : 'h-9 px-3 text-xs'}`}
      aria-label={`Baixar PDF de ${title}`}
      data-testid={`button-download-pdf-${scope}`}
    >
      <Download size={13} aria-hidden="true" />
      <span>PDF</span>
    </button>
  );
}

export function PdfPrintHeader({
  title,
  period,
  filters,
}: {
  title: string;
  period: string;
  filters: string;
}) {
  return (
    <header className="dashboard-pdf-only dashboard-pdf-page-heading">
      <img src={`${appBasePath}/logo.svg`} alt="Zero3 PRO" />
      <div className="dashboard-pdf-page-title">
        <p>RELATÓRIO DE INDICADOR · ZERO3 PRO</p>
        <h1>{title}</h1>
        <span>Período: {period}</span>
        <span>Filtros: {filters}</span>
      </div>
    </header>
  );
}

export function PdfPrintTable({
  headers,
  rows,
  summary,
}: {
  headers: string[];
  rows: string[][];
  summary?: string[];
}) {
  return (
    <div className="dashboard-pdf-table">
      <table>
        <thead><tr>{headers.map((header) => <th key={header} scope="col">{header}</th>)}</tr></thead>
        <tbody>
          {rows.length
            ? rows.map((row, rowIndex) => <tr key={`${row[0]}-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${cellIndex}-${cell}`}>{cell}</td>)}</tr>)
            : <tr><td colSpan={headers.length} className="dashboard-pdf-empty">Sem dados no período selecionado.</td></tr>}
        </tbody>
        {summary && <tfoot><tr>{summary.map((cell, cellIndex) => <td key={`${cellIndex}-${cell}`}><strong>{cell}</strong></td>)}</tr></tfoot>}
      </table>
    </div>
  );
}
