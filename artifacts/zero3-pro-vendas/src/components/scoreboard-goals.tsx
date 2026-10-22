import { useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CircleHelp, RefreshCw, Target } from 'lucide-react';
import {
  getGetSalesGoalsQueryKey,
  useUpsertSalesGoal,
} from '@workspace/api-client-react';
import type { SalesGoal } from '@workspace/api-client-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  formatCents,
  formatMonthKey,
  getSaoPauloMonthKey,
  productNameKey,
} from '@/lib/sales-utils';

interface ScoreboardGoalsProps {
  actualRevenueCents: bigint;
  monthKeys: string[];
  comparisonMode: 'complete' | 'partial-range' | 'invalid';
  selectedProductName: string | null;
  products: { key: string; name: string }[];
  goals: SalesGoal[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

function goalMatchesScope(goal: SalesGoal, selectedProductName: string | null) {
  if (selectedProductName === null) return goal.productName === null;
  return goal.productName !== null && productNameKey(goal.productName) === productNameKey(selectedProductName);
}

function parseBrlCents(value: string): number | null {
  const cleaned = value.trim();
  if (!/^\d+(?:[,.]\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ''] = cleaned.replace(',', '.').split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents <= 0n || cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(cents);
}

function formatTargetInput(targetCents: number): string {
  const cents = BigInt(targetCents);
  return `${cents / 100n},${String(cents % 100n).padStart(2, '0')}`;
}

function formatGoalPercent(actual: bigint, target: bigint): string {
  const tenthsOfPercent = (actual * 1000n + target / 2n) / target;
  return `${(tenthsOfPercent / 10n).toLocaleString('pt-BR')},${tenthsOfPercent % 10n}%`;
}

function getGoalErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const apiError = error as { message?: unknown; data?: { error?: unknown } };
    if (typeof apiError.data?.error === 'string') return apiError.data.error;
    if (typeof apiError.message === 'string') return apiError.message;
  }
  return 'Não foi possível salvar a meta. Tente novamente.';
}

function getDefaultGoalMonth(monthKeys: string[]): string {
  const currentMonth = getSaoPauloMonthKey();
  if (monthKeys.includes(currentMonth)) return currentMonth;
  return monthKeys.at(-1) ?? currentMonth;
}

export default function ScoreboardGoals({
  actualRevenueCents,
  monthKeys,
  comparisonMode,
  selectedProductName,
  products,
  goals,
  isLoading,
  isError,
  onRetry,
}: ScoreboardGoalsProps) {
  const queryClient = useQueryClient();
  const saveGoal = useUpsertSalesGoal();
  const pendingGoalKey = useRef<{ fingerprint: string; key: string } | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [goalMonth, setGoalMonth] = useState('');
  const [goalScope, setGoalScope] = useState('');
  const [goalAmount, setGoalAmount] = useState('');
  const [saveError, setSaveError] = useState('');

  const selectedScopeProduct = products.find((product) => product.key === goalScope);
  const activeGoals = monthKeys.map((month) => goals.find(
    (goal) => goal.month === month && goalMatchesScope(goal, selectedProductName),
  ));
  const configuredGoalCount = activeGoals.filter(Boolean).length;
  const fullCoverage = monthKeys.length > 0 && configuredGoalCount === monthKeys.length;
  const noConfiguredGoals = configuredGoalCount === 0;
  const targetCents = fullCoverage
    ? activeGoals.reduce((total, goal) => total + BigInt(goal!.targetCents), 0n)
    : 0n;
  const actualCents = actualRevenueCents;
  const amountDifference = actualCents < targetCents
    ? targetCents - actualCents
    : actualCents - targetCents;
  const periodLabel = monthKeys.length === 1
    ? formatMonthKey(monthKeys[0])
    : monthKeys.length > 1
      ? `${formatMonthKey(monthKeys[0])} a ${formatMonthKey(monthKeys[monthKeys.length - 1])} · ${monthKeys.length} meses`
      : 'Período não selecionado';
  const selectedPlanLabel = selectedProductName ?? 'Todos os planos';

  function findGoal(month: string, scope: string) {
    const productName = scope ? products.find((product) => product.key === scope)?.name ?? null : null;
    if (scope && !productName) return undefined;
    return goals.find((goal) => (
      goal.month === month && goalMatchesScope(goal, productName)
    ));
  }

  function openDialog() {
    const initialMonth = getDefaultGoalMonth(monthKeys);
    const selectedProduct = products.find((product) => product.key === productNameKey(selectedProductName ?? ''));
    const initialScope = selectedProductName && selectedProduct ? selectedProduct.key : '';
    const existing = findGoal(initialMonth, initialScope);
    setGoalMonth(initialMonth);
    setGoalScope(initialScope);
    setGoalAmount(existing ? formatTargetInput(existing.targetCents) : '');
    setSaveError('');
    setDialogOpen(true);
  }

  function updateGoalMonth(month: string) {
    setGoalMonth(month);
    const existing = findGoal(month, goalScope);
    setGoalAmount(existing ? formatTargetInput(existing.targetCents) : '');
    setSaveError('');
  }

  function updateGoalScope(scope: string) {
    setGoalScope(scope);
    const existing = findGoal(goalMonth, scope);
    setGoalAmount(existing ? formatTargetInput(existing.targetCents) : '');
    setSaveError('');
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saveGoal.isPending) return;

    const targetCentsValue = parseBrlCents(goalAmount);
    if (!goalMonth || !targetCentsValue) {
      setSaveError('Informe uma meta mensal positiva, com até duas casas decimais.');
      return;
    }
    if (goalScope && !selectedScopeProduct) {
      setSaveError('Selecione um plano ou produto existente.');
      return;
    }

    try {
      const productName = selectedScopeProduct?.name ?? null;
      const fingerprint = JSON.stringify({
        month: goalMonth,
        productName,
        targetCents: targetCentsValue,
      });
      if (pendingGoalKey.current?.fingerprint !== fingerprint) {
        pendingGoalKey.current = { fingerprint, key: crypto.randomUUID() };
      }
      await saveGoal.mutateAsync({
        data: {
          month: goalMonth,
          productName,
          targetCents: targetCentsValue,
          idempotencyKey: pendingGoalKey.current.key,
        },
      });
      await queryClient.invalidateQueries({ queryKey: getGetSalesGoalsQueryKey() });
      pendingGoalKey.current = null;
      setDialogOpen(false);
    } catch (error) {
      setSaveError(getGoalErrorMessage(error));
    }
  }

  return (
    <>
      <section
        className="rounded-[22px] border border-[#e7e1e9] bg-[#fffefc] px-4 py-4 shadow-[0_8px_28px_rgba(47,39,62,.035)] sm:px-5"
        aria-labelledby="scoreboard-goal-heading"
        data-testid="card-scoreboard-goal"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="eyebrow text-[9px] font-bold text-[#8a8491]">objetivo comercial</p>
            <h2 id="scoreboard-goal-heading" className="mt-1 flex items-center gap-2 text-base font-extrabold tracking-[-.035em] text-[#332d40]">
              <Target size={17} className="text-[#7656b8]" />
              Meta mensal de faturamento
            </h2>
            <p className="mt-1 text-[11px] text-[#827b8b]">
              {selectedPlanLabel} <span aria-hidden="true">·</span> {periodLabel}
            </p>
          </div>
          <button
            type="button"
            onClick={openDialog}
            disabled={isLoading || isError}
            className="inline-flex h-9 shrink-0 items-center justify-center rounded-xl border border-[#ded7e7] bg-white px-3.5 text-xs font-bold text-[#5d4a78] transition hover:bg-[#f7f4fa] disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="button-define-sales-goal"
          >
            Definir meta
          </button>
        </div>

        <div className="mt-4 grid gap-2 border-t border-[#efebf0] pt-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl bg-[#f8f6f9] px-3.5 py-3" data-testid="scoreboard-goal-realized">
            <p className="text-[9px] font-bold uppercase tracking-[.1em] text-[#817b89]">Realizado</p>
            <p className="mt-1 text-sm font-extrabold tabular-nums text-[#40374e]">{formatCents(actualCents)}</p>
          </div>

          {comparisonMode === 'partial-range' ? (
            <div className="rounded-xl border border-[#e9e0c8] bg-[#fcf8ed] px-3.5 py-3 sm:col-span-1 xl:col-span-3" data-testid="status-scoreboard-goal-partial-range">
              <p className="text-xs font-bold text-[#725d2d]">Comparação mensal não aplicável</p>
              <p className="mt-1 text-[11px] leading-5 text-[#827248]">O intervalo contém partes de meses. O faturamento filtrado continua sendo exibido, mas a comparação com metas mensais não é automática.</p>
              {!isLoading && !isError && noConfiguredGoals && <p className="mt-1 text-[11px] font-semibold text-[#827248]">Meta não definida para este plano e período.</p>}
            </div>
          ) : isLoading ? (
            <div className="flex items-center gap-2 rounded-xl bg-[#f8f6f9] px-3.5 py-3 text-xs text-[#817b89]" data-testid="status-scoreboard-goal-loading">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#d8d0e2] border-t-[#7656b8]" />
              Carregando metas…
            </div>
          ) : isError ? (
            <div className="rounded-xl bg-[#fff5f2] px-3.5 py-3 text-xs text-[#85554e]" data-testid="status-scoreboard-goal-error">
              <div className="flex items-center gap-2"><CircleHelp size={14} /> Não foi possível carregar metas.</div>
              <button type="button" onClick={onRetry} className="mt-2 inline-flex items-center gap-1.5 font-bold underline underline-offset-2">
                <RefreshCw size={12} /> Tentar novamente
              </button>
            </div>
          ) : comparisonMode === 'invalid' || monthKeys.length === 0 ? (
            <div className="rounded-xl bg-[#f8f6f9] px-3.5 py-3 text-xs text-[#817b89]" data-testid="status-scoreboard-goal-invalid">
              Selecione um período válido para consultar a meta correspondente.
            </div>
          ) : noConfiguredGoals ? (
            <div className="rounded-xl bg-[#f8f6f9] px-3.5 py-3" data-testid="status-scoreboard-goal-undefined">
              <p className="text-[9px] font-bold uppercase tracking-[.1em] text-[#817b89]">Meta</p>
              <p className="mt-1 text-sm font-extrabold text-[#625a6d]">Meta não definida</p>
              <p className="mt-1 text-[10px] leading-4 text-[#8a8491]">Defina uma meta mensal para comparar este plano e período.</p>
            </div>
          ) : !fullCoverage ? (
            <div className="rounded-xl border border-[#e9e0c8] bg-[#fcf8ed] px-3.5 py-3 sm:col-span-1 xl:col-span-3" data-testid="status-scoreboard-goal-partial-coverage">
              <p className="text-xs font-bold text-[#725d2d]">Cobertura parcial de metas</p>
              <p className="mt-1 text-[11px] leading-5 text-[#827248]">
                Meta cadastrada para {configuredGoalCount} de {monthKeys.length} meses. Cadastre as metas restantes para comparar o período; o percentual não é exibido com cobertura incompleta.
              </p>
            </div>
          ) : (
            <>
              <div className="rounded-xl bg-[#f8f6f9] px-3.5 py-3" data-testid="scoreboard-goal-target">
                <p className="text-[9px] font-bold uppercase tracking-[.1em] text-[#817b89]">Meta</p>
                <p className="mt-1 text-sm font-extrabold tabular-nums text-[#40374e]">{formatCents(targetCents)}</p>
              </div>
              <div className="rounded-xl bg-[#f8f6f9] px-3.5 py-3" data-testid="scoreboard-goal-difference">
                <p className="text-[9px] font-bold uppercase tracking-[.1em] text-[#817b89]">{actualCents > targetCents ? 'Excedente' : 'Valor que falta'}</p>
                <p className="mt-1 text-sm font-extrabold tabular-nums text-[#40374e]">{formatCents(amountDifference)}</p>
              </div>
              <div className="rounded-xl bg-[#f0edf4] px-3.5 py-3" data-testid="scoreboard-goal-percent">
                <p className="text-[9px] font-bold uppercase tracking-[.1em] text-[#777080]">Atingimento</p>
                <p className="mt-1 text-sm font-extrabold tabular-nums text-[#392f4b]">{formatGoalPercent(actualCents, targetCents)}</p>
              </div>
            </>
          )}
        </div>

        {fullCoverage && actualCents === targetCents && comparisonMode === 'complete' && (
          <p className="mt-2 text-[10px] font-semibold text-[#55772c]" data-testid="text-scoreboard-goal-met">Meta atingida.</p>
        )}
        {fullCoverage && actualCents > targetCents && comparisonMode === 'complete' && (
          <p className="mt-2 text-[10px] font-semibold text-[#55772c]" data-testid="text-scoreboard-goal-exceeded">O faturamento está acima da meta.</p>
        )}
      </section>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!saveGoal.isPending) setDialogOpen(open);
        }}
      >
        <DialogContent className="max-w-md border-[#e7e1e9] bg-[#fffefc] p-6 sm:rounded-[24px]">
          <DialogHeader className="text-left">
            <DialogTitle className="text-lg font-extrabold tracking-[-.035em] text-[#332d40]">Definir meta mensal</DialogTitle>
            <DialogDescription className="text-xs leading-5 text-[#827b8b]">
              A meta será salva para o mês e o plano escolhidos e poderá ser ajustada depois.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={(event) => void handleSave(event)} className="space-y-4">
            <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Mês
              <input
                type="month"
                value={goalMonth}
                onChange={(event) => updateGoalMonth(event.target.value)}
                required
                data-testid="input-sales-goal-month"
                className="mt-1.5 h-11 w-full rounded-xl border border-[#e7e2ea] bg-[#fcfbfd] px-3.5 text-sm font-medium normal-case tracking-normal text-[#342d43] outline-none focus:border-[#9477bf]"
              />
            </label>

            <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Plano ou produto
              <select
                value={goalScope}
                onChange={(event) => updateGoalScope(event.target.value)}
                data-testid="select-sales-goal-scope"
                className="mt-1.5 h-11 w-full rounded-xl border border-[#e7e2ea] bg-[#fcfbfd] px-3.5 text-sm font-medium normal-case tracking-normal text-[#342d43] outline-none focus:border-[#9477bf]"
              >
                <option value="">Todos os planos (meta geral)</option>
                {products.map((product) => <option key={product.key} value={product.key}>{product.name}</option>)}
              </select>
            </label>

            <label className="block text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]">Meta mensal de faturamento (R$)
              <input
                type="text"
                inputMode="decimal"
                value={goalAmount}
                onChange={(event) => { setGoalAmount(event.target.value); setSaveError(''); }}
                placeholder="Ex.: 5000,00"
                maxLength={20}
                required
                data-testid="input-sales-goal-amount"
                className="mt-1.5 h-11 w-full rounded-xl border border-[#e7e2ea] bg-[#fcfbfd] px-3.5 text-sm font-medium normal-case tracking-normal text-[#342d43] outline-none placeholder:text-[#aaa4b0] focus:border-[#9477bf]"
              />
              <span className="mt-1.5 block text-[10px] font-medium normal-case tracking-normal text-[#938c9b]">Informe um valor positivo com até duas casas decimais.</span>
            </label>

            {saveError && <p className="rounded-xl bg-[#fff0ed] px-3.5 py-2.5 text-xs font-semibold text-[#9c483f]" role="alert" data-testid="status-sales-goal-save-error">{saveError}</p>}

            <DialogFooter className="gap-2 pt-1">
              <button
                type="button"
                onClick={() => setDialogOpen(false)}
                disabled={saveGoal.isPending}
                className="h-10 rounded-xl border border-[#e3dfe7] px-4 text-sm font-bold text-[#716a79] transition hover:bg-[#f8f6fa] disabled:opacity-50"
                data-testid="button-cancel-sales-goal"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={saveGoal.isPending || !goalMonth || parseBrlCents(goalAmount) === null || Boolean(goalScope && !selectedScopeProduct)}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#7656b8] px-4 text-sm font-bold text-white transition hover:bg-[#6848a9] disabled:cursor-wait disabled:opacity-60"
                data-testid="button-save-sales-goal"
              >
                {saveGoal.isPending && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
                {saveGoal.isPending ? 'Salvando…' : 'Salvar meta'}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
