import { useEffect, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, RefreshCw, Save } from 'lucide-react';
import {
  getGetActiveContractsQueryKey,
  useGetActiveContracts,
  useUpsertActiveContractsMonth,
} from '@workspace/api-client-react';
import type { ActiveContractsMonth } from '@workspace/api-client-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatMonthKey, getSaoPauloMonthKey } from '@/lib/sales-utils';

const inputClass = 'mt-1.5 h-10 w-full rounded-xl border border-[#e7e2ea] bg-white px-3 text-sm font-medium text-[#443d50] outline-none transition focus:border-[#9477bf] focus:ring-2 focus:ring-[#9477bf]/15';
const labelClass = 'block text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]';
const maximumCount = 2_147_483_647;

function parseCount(value: string): number | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count <= maximumCount ? count : null;
}

function errorMessage(error: unknown) {
  return error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message
    : 'Não foi possível salvar o saldo de contratos ativos.';
}

export default function ActiveContractsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const queryKey = getGetActiveContractsQueryKey();
  const contractsQuery = useGetActiveContracts({
    query: { queryKey, enabled: open, refetchOnMount: 'always' },
  });
  const saveContract = useUpsertActiveContractsMonth();
  const records = contractsQuery.data ?? [];

  const [month, setMonth] = useState(getSaoPauloMonthKey());
  const [activeCount, setActiveCount] = useState('');
  const [targetCount, setTargetCount] = useState('');
  const [notes, setNotes] = useState('');
  const [dirty, setDirty] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setMonth(getSaoPauloMonthKey());
    setDirty(false);
    setFeedback(null);
  }, [open]);

  useEffect(() => {
    if (!open || dirty) return;
    const saved = records.find((record) => record.month === month);
    setActiveCount(saved ? String(saved.activeCount) : '');
    setTargetCount(saved?.targetCount == null ? '' : String(saved.targetCount));
    setNotes(saved?.notes ?? '');
  }, [dirty, month, open, records]);

  function selectMonth(value: string) {
    setMonth(value);
    setDirty(false);
    setFeedback(null);
  }

  function editRecord(record: ActiveContractsMonth) {
    setMonth(record.month);
    setActiveCount(String(record.activeCount));
    setTargetCount(record.targetCount == null ? '' : String(record.targetCount));
    setNotes(record.notes ?? '');
    setDirty(true);
    setFeedback(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      setFeedback({ type: 'error', text: 'Selecione um mês válido.' });
      return;
    }
    const active = parseCount(activeCount);
    const target = targetCount === '' ? null : parseCount(targetCount);
    if (active === null) {
      setFeedback({ type: 'error', text: 'Informe a quantidade de contratos ativos como um inteiro não negativo.' });
      return;
    }
    if (targetCount !== '' && target === null) {
      setFeedback({ type: 'error', text: 'A meta deve ser um inteiro não negativo ou ficar em branco.' });
      return;
    }

    const existed = records.some((record) => record.month === month);
    setFeedback(null);
    try {
      const saved = await saveContract.mutateAsync({
        month,
        data: {
          activeCount: active,
          targetCount: target,
          notes: notes.trim() || null,
        },
      });
      queryClient.setQueryData<ActiveContractsMonth[]>(queryKey, (current = []) => [
        ...current.filter((record) => record.month !== saved.month),
        saved,
      ].sort((left, right) => left.month.localeCompare(right.month)));
      await queryClient.invalidateQueries({ queryKey });
      setDirty(false);
      setFeedback({ type: 'success', text: existed ? 'O mês foi atualizado.' : 'O saldo mensal foi salvo.' });
    } catch (error) {
      setFeedback({ type: 'error', text: errorMessage(error) });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(90dvh,880px)] w-[min(760px,calc(100vw-1.25rem))] overflow-y-auto rounded-[24px] border border-[#e9e4eb] bg-[#fffefc] p-0 sm:max-w-[760px]" data-testid="dialog-active-contracts">
        <DialogHeader className="border-b border-[#f0edf1] px-5 py-5 sm:px-7">
          <p className="text-[9px] font-bold uppercase tracking-[.15em] text-[#8c73b4]">lançamentos · administração</p>
          <DialogTitle className="font-[family-name:var(--app-font-serif)] text-2xl font-extrabold tracking-[-.05em] text-[#342d40]">Contratos ativos mensais</DialogTitle>
          <DialogDescription className="text-xs leading-5 text-[#837b8b]">
            Registre o saldo administrativo de cada mês. Cada correção atualiza somente o mês escolhido; os demais meses permanecem.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 px-5 py-5 sm:px-7">
          <form onSubmit={(event) => void submit(event)} className="rounded-2xl border border-[#e9e4eb] bg-[#fbfafc] p-4 sm:p-5" data-testid="form-active-contracts">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={labelClass}>Mês e ano
                <input type="month" value={month} onChange={(event) => selectMonth(event.target.value)} className={inputClass} required data-testid="input-active-contracts-month" />
              </label>
              <label className={labelClass}>Contratos ativos
                <input type="number" inputMode="numeric" min="0" max={maximumCount} step="1" value={activeCount} onChange={(event) => { setActiveCount(event.target.value); setDirty(true); }} className={inputClass} placeholder="Ex.: 143" required data-testid="input-active-contracts-count" />
              </label>
              <label className={labelClass}>Meta mensal
                <input type="number" inputMode="numeric" min="0" max={maximumCount} step="1" value={targetCount} onChange={(event) => { setTargetCount(event.target.value); setDirty(true); }} className={inputClass} placeholder="Opcional" data-testid="input-active-contracts-target" />
              </label>
              <label className={`${labelClass} sm:col-span-2`}>Observações opcionais
                <textarea value={notes} onChange={(event) => { setNotes(event.target.value); setDirty(true); }} maxLength={1000} rows={2} className="mt-1.5 w-full resize-y rounded-xl border border-[#e7e2ea] bg-white px-3 py-2.5 text-sm font-medium text-[#443d50] outline-none transition focus:border-[#9477bf] focus:ring-2 focus:ring-[#9477bf]/15" placeholder="Ex.: fechamento e ajustes do mês" data-testid="input-active-contracts-notes" />
              </label>
            </div>
            {feedback && <p className={`mt-3 rounded-xl px-3 py-2 text-xs font-semibold ${feedback.type === 'success' ? 'bg-[#eff6e5] text-[#55772c]' : 'bg-[#fff1ef] text-[#a24f45]'}`} role={feedback.type === 'error' ? 'alert' : 'status'} data-testid="status-active-contracts-save">{feedback.text}</p>}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-[10px] leading-4 text-[#837b8b]">Os contratos são informados manualmente e não são calculados a partir das vendas.</p>
              <button type="submit" disabled={saveContract.isPending || contractsQuery.isLoading} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-[#7656b8] px-4 text-xs font-bold text-white transition hover:bg-[#6848a9] disabled:cursor-wait disabled:opacity-60" data-testid="button-save-active-contracts">
                {saveContract.isPending ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
                {saveContract.isPending ? 'Salvando…' : records.some((record) => record.month === month) ? 'Atualizar mês' : 'Salvar mês'}
              </button>
            </div>
          </form>

          <section aria-label="Histórico de contratos ativos">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-extrabold text-[#443d50]">Meses registrados</h3>
              {contractsQuery.isFetching && <span className="text-[10px] text-[#837b8b]">Atualizando…</span>}
            </div>
            {contractsQuery.isError ? (
              <div className="rounded-xl border border-[#ecd5d4] bg-[#fff9f8] px-4 py-3 text-xs text-[#806462]" role="alert" data-testid="error-active-contracts-list">
                Não foi possível carregar os saldos salvos. {errorMessage(contractsQuery.error)}
                <button type="button" onClick={() => void contractsQuery.refetch()} className="ml-2 font-bold text-[#65479c] underline">Tentar novamente</button>
              </div>
            ) : !records.length && !contractsQuery.isLoading ? (
              <p className="rounded-xl border border-dashed border-[#ded7e4] bg-[#fbf9fc] px-4 py-8 text-center text-xs text-[#837b8b]" data-testid="empty-active-contracts">Nenhum mês cadastrado. Os meses sem registro não são tratados como zero.</p>
            ) : (
              <div className="max-h-64 overflow-auto rounded-xl border border-[#eeeaf1]">
                <table className="w-full min-w-[520px] border-collapse text-left text-xs">
                  <thead className="sticky top-0 bg-[#f8f5fb] text-[9px] uppercase tracking-[.08em] text-[#817b89]">
                    <tr><th className="px-3 py-2.5">Mês</th><th className="px-3 py-2.5">Ativos</th><th className="px-3 py-2.5">Meta</th><th className="px-3 py-2.5">Observações</th><th className="px-3 py-2.5"><span className="sr-only">Ação</span></th></tr>
                  </thead>
                  <tbody className="divide-y divide-[#f0edf1] bg-white">
                    {[...records].sort((left, right) => right.month.localeCompare(left.month)).map((record) => (
                      <tr key={record.month} data-testid={`row-active-contracts-${record.month}`}>
                        <td className="whitespace-nowrap px-3 py-2.5 font-bold capitalize text-[#4b4357]">{formatMonthKey(record.month)}</td>
                        <td className="px-3 py-2.5 font-extrabold tabular-nums text-[#342d40]">{record.activeCount.toLocaleString('pt-BR')}</td>
                        <td className="px-3 py-2.5 tabular-nums text-[#716879]">{record.targetCount == null ? 'Não definida' : record.targetCount.toLocaleString('pt-BR')}</td>
                        <td className="max-w-48 truncate px-3 py-2.5 text-[#837b8b]" title={record.notes ?? undefined}>{record.notes || '—'}</td>
                        <td className="px-3 py-2.5 text-right">
                          <button type="button" onClick={() => editRecord(record)} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[10px] font-bold text-[#65479c] hover:bg-[#f4f0f8]" aria-label={`Editar contratos de ${formatMonthKey(record.month)}`} data-testid={`button-edit-active-contracts-${record.month}`}><Pencil size={12} /> Editar</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <DialogFooter className="border-t border-[#f0edf1] px-5 py-4 sm:px-7">
          <button type="button" onClick={() => onOpenChange(false)} className="inline-flex h-10 items-center gap-2 rounded-xl border border-[#e3dfe7] px-4 text-sm font-bold text-[#716a79] transition hover:bg-[#f8f6fa]" data-testid="button-close-active-contracts"><Check size={14} /> Concluído</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
