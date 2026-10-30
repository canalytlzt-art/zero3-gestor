import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, RotateCcw, Sparkles } from 'lucide-react';
import {
  getGetOccupancyMonthlyAggregatorAdjustmentsQueryKey,
  getGetOccupancyRecordsQueryKey,
  useGetOccupancyMonthlyAggregatorAdjustments,
  usePreviewOccupancyMonthlyAggregatorAdjustment,
  useSaveOccupancyMonthlyAggregatorAdjustment,
  useUndoOccupancyMonthlyAggregatorAdjustment,
  type OccupancyModality,
  type OccupancyMonthlyAggregatorAdjustmentPreview,
} from '@workspace/api-client-react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { formatMonthKey, getSaoPauloMonthKey } from '@/lib/sales-utils';

const inputClass = 'mt-1.5 h-10 w-full rounded-lg border border-[#e7e2ea] bg-[#fffefc] px-3 text-sm font-medium text-[#443d50] outline-none focus:border-[#9477bf]';
const labelClass = 'block text-[10px] font-bold uppercase tracking-[.1em] text-[#817b89]';
const countFormat = new Intl.NumberFormat('pt-BR');

function errorMessage(error: unknown) {
  if (!error || typeof error !== 'object') return 'Não foi possível concluir o ajuste. Tente novamente.';
  const detail = error as { message?: unknown; data?: { error?: unknown } };
  return typeof detail.data?.error === 'string'
    ? detail.data.error
    : typeof detail.message === 'string'
      ? detail.message
      : 'Não foi possível concluir o ajuste. Tente novamente.';
}

function validCount(value: string) {
  if (!/^\d+$/.test(value.trim())) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count <= 2_147_483_647 ? count : null;
}

export default function MonthlyAggregatorAdjustment({
  modalities,
}: {
  modalities: OccupancyModality[];
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(getSaoPauloMonthKey());
  const [modalityId, setModalityId] = useState('');
  const [target, setTarget] = useState('');
  const [preview, setPreview] = useState<OccupancyMonthlyAggregatorAdjustmentPreview | null>(null);
  const [undoOpen, setUndoOpen] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const targetCount = validCount(target);
  const scopeKey = modalityId || 'all';
  const adjustmentQuery = useGetOccupancyMonthlyAggregatorAdjustments(
    { month },
    {
      query: {
        queryKey: getGetOccupancyMonthlyAggregatorAdjustmentsQueryKey({ month }),
        enabled: open && /^\d{4}-(0[1-9]|1[0-2])$/.test(month),
        refetchOnMount: 'always',
        staleTime: 0,
      },
    },
  );
  const savedAdjustment = useMemo(
    () => (adjustmentQuery.data ?? []).find((item) => item.scopeKey === scopeKey) ?? null,
    [adjustmentQuery.data, scopeKey],
  );
  const previewMutation = usePreviewOccupancyMonthlyAggregatorAdjustment();
  const saveMutation = useSaveOccupancyMonthlyAggregatorAdjustment();
  const undoMutation = useUndoOccupancyMonthlyAggregatorAdjustment();
  const busy = previewMutation.isPending || saveMutation.isPending || undoMutation.isPending;

  useEffect(() => {
    setPreview(null);
    setTarget(savedAdjustment?.active ? String(savedAdjustment.targetPresences) : '');
  }, [month, scopeKey, savedAdjustment?.id, savedAdjustment?.version, savedAdjustment?.active, savedAdjustment?.targetPresences]);

  const refreshRelatedData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getGetOccupancyRecordsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetOccupancyMonthlyAggregatorAdjustmentsQueryKey({ month }) }),
    ]);
  };

  const requestPreview = async () => {
    if (targetCount === null) {
      setMessage({ kind: 'error', text: 'Informe um número inteiro entre zero e 2.147.483.647.' });
      return;
    }
    setMessage(null);
    try {
      const result = await previewMutation.mutateAsync({
        data: { month, modalityId: modalityId || null, targetPresences: targetCount },
      });
      setPreview(result);
      if (!result.canSave) setMessage({ kind: 'error', text: result.message });
    } catch (error) {
      setMessage({ kind: 'error', text: errorMessage(error) });
    }
  };

  const saveAdjustment = async () => {
    if (!preview?.canSave) return;
    setMessage(null);
    try {
      await saveMutation.mutateAsync({
        month: preview.month,
        data: {
          month: preview.month,
          modalityId: preview.modalityId,
          targetPresences: preview.targetPresences,
          expectedVersion: preview.expectedVersion,
          adjustmentId: preview.adjustmentId,
          snapshotToken: preview.snapshotToken,
        },
      });
      setPreview(null);
      setMessage({ kind: 'success', text: 'Ajuste salvo. Os gráficos e o histórico de check-ins serão atualizados.' });
      await refreshRelatedData();
    } catch (error) {
      setMessage({ kind: 'error', text: errorMessage(error) });
    }
  };

  const undoAdjustment = async () => {
    if (!savedAdjustment?.active) return;
    setMessage(null);
    try {
      await undoMutation.mutateAsync({
        id: savedAdjustment.id,
        data: { expectedVersion: savedAdjustment.version },
      });
      setUndoOpen(false);
      setPreview(null);
      setMessage({ kind: 'success', text: 'Estimativas desfeitas. Os valores registrados anteriormente foram preservados.' });
      await refreshRelatedData();
    } catch (error) {
      setMessage({ kind: 'error', text: errorMessage(error) });
    }
  };

  const changeMonth = (value: string) => {
    setMonth(value);
    setPreview(null);
    setMessage(null);
  };
  const changeModality = (value: string) => {
    setModalityId(value);
    setPreview(null);
    setMessage(null);
  };
  const changeTarget = (value: string) => {
    setTarget(value);
    setPreview(null);
    setMessage(null);
  };

  return (
    <section className="mx-auto w-full max-w-5xl overflow-hidden rounded-[22px] border border-[#e4dced] bg-[#fffefc] shadow-[0_10px_30px_-26px_rgba(55,40,72,.34)]" data-testid="panel-monthly-aggregator-adjustment">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="monthly-aggregator-adjustment-content"
        className="flex min-h-12 w-full items-center justify-between gap-3 bg-[#f7f3fb] px-4 py-3 text-left text-sm font-extrabold text-[#5d4a78] hover:bg-[#f0e9f8] sm:px-5"
        data-testid="button-toggle-monthly-aggregator-adjustment"
      >
        <span className="flex items-center gap-2"><Sparkles size={16} /> Ajuste Mensal de Agregadores</span>
        <ChevronDown size={16} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {open && <div id="monthly-aggregator-adjustment-content" className="space-y-4 p-4 sm:p-5" data-testid="content-monthly-aggregator-adjustment">
        <p className="max-w-3xl text-xs leading-5 text-[#766d83]">
          Informe o total do mês. O sistema preserva os valores já registrados e distribui somente a diferença entre aulas diárias sem agregadores informados. A estimativa fica identificada por aula e pode ser desfeita.
        </p>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className={labelClass}>Mês e ano
            <input type="month" value={month} onChange={(event) => changeMonth(event.target.value)} className={inputClass} data-testid="input-monthly-aggregator-month" />
          </label>
          <label className={labelClass}>Modalidade <span className="font-medium normal-case tracking-normal text-[#a39dab]">(opcional)</span>
            <select value={modalityId} onChange={(event) => changeModality(event.target.value)} className={inputClass} data-testid="select-monthly-aggregator-modality">
              <option value="">Todas as modalidades</option>
              {modalities.map((modality) => <option key={modality.id} value={modality.id}>{modality.name}</option>)}
            </select>
          </label>
          <label className={labelClass}>Total de agregadores no mês
            <input type="number" min="0" max="2147483647" step="1" inputMode="numeric" value={target} onChange={(event) => changeTarget(event.target.value)} placeholder="Informe o total" className={inputClass} data-testid="input-monthly-aggregator-target" />
          </label>
        </div>

        {adjustmentQuery.isLoading && <p className="text-xs text-[#766d83]" role="status">Carregando ajuste salvo…</p>}
        {adjustmentQuery.isError && <p className="rounded-lg bg-[#fff3f1] px-3 py-2 text-xs font-semibold text-[#8e3d33]" role="alert" data-testid="error-monthly-aggregator-load">
          {errorMessage(adjustmentQuery.error)} Se a migração aditiva ainda não foi aplicada neste ambiente, o recurso ficará indisponível até sua instalação.
        </p>}
        {savedAdjustment && <p className={`rounded-lg px-3 py-2 text-xs font-semibold ${savedAdjustment.active ? 'bg-[#eff6e5] text-[#55772c]' : 'bg-[#f4f1f7] text-[#766d83]'}`} role="status" data-testid="status-saved-monthly-aggregator-adjustment">
          {savedAdjustment.active
            ? `Ajuste salvo para ${formatMonthKey(month)}${savedAdjustment.modalityName ? ` · ${savedAdjustment.modalityName}` : ' · todas as modalidades'}: ${countFormat.format(savedAdjustment.targetPresences)} agregadores.`
            : `O último ajuste deste recorte foi desfeito. Histórico preservado.`}
        </p>}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void requestPreview()}
            disabled={busy || targetCount === null || adjustmentQuery.isError || adjustmentQuery.isLoading}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-[#d9cce8] bg-white px-4 py-2 text-xs font-extrabold text-[#5d4a78] hover:bg-[#f7f3fb] disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="button-preview-monthly-aggregator-adjustment"
          >
            {previewMutation.isPending ? 'Calculando…' : 'Pré-visualizar ajuste'}
          </button>
          {savedAdjustment?.active && <button
            type="button"
            onClick={() => setUndoOpen(true)}
            disabled={busy}
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-[#ead5d1] bg-white px-4 py-2 text-xs font-bold text-[#9a4f44] hover:bg-[#fff5f3] disabled:opacity-50"
            data-testid="button-undo-monthly-aggregator-adjustment"
          >
            <RotateCcw size={14} /> Desfazer ajuste
          </button>}
        </div>

        {preview && <div className="space-y-4 rounded-2xl border border-[#e8e0ee] bg-[#fcfbfd] p-3 sm:p-4" data-testid="preview-monthly-aggregator-adjustment">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h3 className="text-sm font-extrabold text-[#40374e]">Prévia · {formatMonthKey(preview.month)}</h3>
              <p className="mt-1 text-[11px] leading-4 text-[#766d83]">{preview.message}</p>
            </div>
            <span className="text-[10px] font-semibold text-[#817b89]">{preview.modalityName ?? 'Todas as modalidades'}</span>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
            {[
              ['Total de check-ins', preview.totalPresences],
              ['Agregadores já informados', preview.recordedAggregatorPresences],
              ['Total mensal informado', preview.targetPresences],
              ['A distribuir', Math.max(0, preview.remainingToDistribute)],
              ['Demais check-ins', preview.otherPresences],
            ].map(([label, value]) => <div key={String(label)} className="rounded-xl border border-[#eee9f2] bg-white px-3 py-2.5">
              <p className="text-[9px] font-bold uppercase tracking-[.08em] text-[#817b89]">{label}</p>
              <p className="mt-1 text-sm font-extrabold tabular-nums text-[#443d50]">{value === null ? '—' : countFormat.format(Number(value))}</p>
            </div>)}
          </div>
          {preview.previousEstimatedPresences > 0 && <p className="rounded-lg bg-[#f2edf8] px-3 py-2 text-[11px] text-[#5d4a78]">
            O ajuste anterior contribuiu com {countFormat.format(preview.previousEstimatedPresences)} agregadores. Esses valores serão recalculados, sem serem somados novamente.
          </p>}

          {preview.allocations.length > 0 && <div className="overflow-hidden rounded-xl border border-[#ece7ee] bg-white">
            <div className="border-b border-[#ece7ee] px-3 py-2 text-[10px] font-extrabold uppercase tracking-[.08em] text-[#766d83]">
              Distribuição estimada · {preview.candidateClassCount} aula(s)
            </div>
            <div className="max-h-64 overflow-auto">
              <table className="w-full min-w-[620px] border-collapse text-left text-[11px]" data-testid="table-monthly-aggregator-preview">
                <thead className="sticky top-0 bg-[#f7f3fb] text-[9px] uppercase tracking-[.07em] text-[#766d83]">
                  <tr><th className="px-3 py-2">Data / aula</th><th className="px-3 py-2">Modalidade</th><th className="px-3 py-2 text-right">Presenças</th><th className="px-3 py-2 text-right">Antes</th><th className="px-3 py-2 text-right">Estimativa</th></tr>
                </thead>
                <tbody className="divide-y divide-[#f0edf1]">
                  {preview.allocations.map((allocation) => <tr key={allocation.recordId}>
                    <td className="px-3 py-2 font-semibold text-[#443d50]">{allocation.date}{allocation.startTime ? ` · ${allocation.startTime}` : ''}{allocation.className ? ` · ${allocation.className}` : ''}</td>
                    <td className="px-3 py-2 text-[#766d83]">{allocation.modalityName}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{countFormat.format(allocation.presences)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{allocation.previousAggregatorPresences === null ? 'Não informado' : countFormat.format(allocation.previousAggregatorPresences)}</td>
                    <td className="px-3 py-2 text-right font-extrabold tabular-nums text-[#65479c]">{countFormat.format(allocation.assignedAggregatorPresences)}</td>
                  </tr>)}
                </tbody>
              </table>
            </div>
          </div>}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" onClick={() => setPreview(null)} disabled={busy} className="min-h-10 rounded-xl border border-[#ded7e7] bg-white px-4 py-2 text-xs font-bold text-[#5d4a78] hover:bg-[#f7f4fa]" data-testid="button-cancel-monthly-aggregator-preview">Cancelar</button>
            <button type="button" onClick={() => void saveAdjustment()} disabled={busy || !preview.canSave} className="min-h-10 rounded-xl bg-[#7656b8] px-4 py-2 text-xs font-extrabold text-white hover:bg-[#65479c] disabled:cursor-not-allowed disabled:opacity-50" data-testid="button-save-monthly-aggregator-adjustment">{saveMutation.isPending ? 'Salvando…' : savedAdjustment?.active ? 'Atualizar ajuste' : 'Salvar ajuste'}</button>
          </div>
        </div>}

        {message && <p className={`rounded-lg px-3 py-2 text-xs font-semibold ${message.kind === 'success' ? 'bg-[#eff6e5] text-[#55772c]' : 'bg-[#fff3f1] text-[#8e3d33]'}`} role={message.kind === 'error' ? 'alert' : 'status'} data-testid="status-monthly-aggregator-adjustment">{message.text}</p>}
      </div>}

      <AlertDialog open={undoOpen} onOpenChange={(value) => { if (!busy) setUndoOpen(value); }}>
        <AlertDialogContent className="rounded-[22px] border-[#e7e1e9] bg-[#fffefc]" data-testid="dialog-undo-monthly-aggregator-adjustment">
          <AlertDialogHeader>
            <AlertDialogTitle>Desfazer ajuste mensal?</AlertDialogTitle>
            <AlertDialogDescription>
              Somente os valores marcados como estimativa deste ajuste serão removidos. Agregadores já informados nas aulas serão preservados, e o histórico da operação continuará registrado.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Manter ajuste</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={(event) => { event.preventDefault(); void undoAdjustment(); }} className="bg-[#7656b8] hover:bg-[#65479c]" data-testid="button-confirm-undo-monthly-aggregator-adjustment">{undoMutation.isPending ? 'Desfazendo…' : 'Desfazer estimativas'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
