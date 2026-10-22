import { useMemo, useRef, useState } from "react";
import { AlertCircle, Check, FileSpreadsheet, LoaderCircle, Upload, X } from "lucide-react";
import {
  useCommitOccupancyImport,
  useGetOccupancyModalities,
  usePreviewOccupancyImport,
  type OccupancyImportPreviewRow,
  type OccupancyImportRowInput,
} from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { parseOccupancySpreadsheet, type ParsedOccupancyImport } from "@/lib/occupancy-import";

type Props = { open: boolean; onOpenChange: (open: boolean) => void; onImported: () => void };
type PreviewItem = {
  local: ParsedOccupancyImport["entries"][number];
  remote?: OccupancyImportPreviewRow;
  conflictUpdate: boolean;
  keepBothConfirmed: boolean;
  included: boolean;
};
type ScaleChoice = "fraction" | "percent";

const button = "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl px-4 text-xs font-extrabold transition disabled:cursor-not-allowed disabled:opacity-50";
const formatPeriod = (period: string | null) => {
  if (!period) return "—";
  const [year, month, day] = period.split("-");
  return day ? `${day}/${month}/${year}` : `${month}/${year}`;
};
const pct = (value: number | null) => value === null ? "—" : `${value.toLocaleString("pt-BR", { maximumFractionDigits: 8 })}%`;
const statusLabel = (status?: string) => ({
  new: "Novo", already_imported: "Já importado", conflict: "Conflito",
  duplicate_in_file: "Duplicado no arquivo", ready: "Pronto", pending: "Pendente", ignored: "Ignorado",
}[status ?? ""] ?? "Aguardando prévia");

export default function OccupancyImportDialog({ open, onOpenChange, onImported }: Props) {
  const previewMutation = usePreviewOccupancyImport();
  const commitMutation = useCommitOccupancyImport();
  const modalitiesQuery = useGetOccupancyModalities();
  const existingModalities = modalitiesQuery.data ?? [];
  const bytesRef = useRef<ArrayBuffer | null>(null);
  const [filename, setFilename] = useState("");
  const [parsed, setParsed] = useState<ParsedOccupancyImport | null>(null);
  const [items, setItems] = useState<PreviewItem[]>([]);
  const [year, setYear] = useState("");
  const [scales, setScales] = useState<Record<string, ScaleChoice>>({});
  const [modalityMappings, setModalityMappings] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [results, setResults] = useState<Array<{ index: number; status: string; message: string }>>([]);

  const selectedSheets = useMemo(() => new Set(parsed?.sheets.filter((s) => s.selected).map((s) => s.name) ?? []), [parsed]);
  const modalityAssociations = useMemo(() => {
    const names = [...new Set(items.map(({ local }) => local.modalityName).filter((name): name is string => Boolean(name)))];
    return names.flatMap((sourceName) => {
      const candidate = existingModalities.find(({ name }) => isCrossFitAlias(sourceName, name));
      return candidate ? [{ sourceName, target: candidate }] : [];
    });
  }, [items, existingModalities]);
  const duplicateKeyByIndex = useMemo(() => {
    const exactGroups = new Map<string, number[]>();
    const monthlyGroups = new Map<string, Array<{ index: number; kind: "daily" | "monthly" }>>();
    const effectiveName = (name: string) => {
      const mappedId = modalityMappings[name];
      return existingModalities.find(({ id }) => id === mappedId)?.name ?? name;
    };
    for (const { local } of items) {
      if (local.status !== "ready" || !local.kind || !local.period || !local.modalityName) continue;
      const modality = normalizeModality(effectiveName(local.modalityName));
      const className = normalizeModality(local.className ?? "");
      const exact = `${modality}\u0000${local.kind}\u0000${local.period}\u0000${className}\u0000${local.startTime ?? ""}`;
      exactGroups.set(exact, [...(exactGroups.get(exact) ?? []), local.index]);
      const monthScope = `${modality}\u0000${local.period.slice(0, 7)}\u0000${className}`;
      monthlyGroups.set(monthScope, [...(monthlyGroups.get(monthScope) ?? []), { index: local.index, kind: local.kind }]);
    }
    const result = new Map<number, string>();
    for (const [key, indices] of exactGroups) {
      if (indices.length > 1) indices.forEach((index) => result.set(index, `same-scope\u0000${key}`));
    }
    for (const [key, group] of monthlyGroups) {
      if (!group.some((row) => row.kind === "daily") || !group.some((row) => row.kind === "monthly")) continue;
      group.forEach(({ index }) => result.set(index, `daily-monthly\u0000${key}`));
    }
    return result;
  }, [items, modalityMappings, existingModalities]);
  const overlapBlocked = useMemo(() => {
    const groups = new Map<string, PreviewItem[]>();
    for (const item of items) {
      const key = duplicateKeyByIndex.get(item.local.index);
      if (!key || !item.included || !selectedSheets.has(item.local.sourceSheet)) continue;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    const blocked = new Set<number>();
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => a.local.index - b.local.index);
      group.slice(1).filter((item) => !item.keepBothConfirmed).forEach((item) => blocked.add(item.local.index));
    }
    return blocked;
  }, [items, selectedSheets, duplicateKeyByIndex]);
  const counts = {
    new: items.filter((i) => i.remote?.status === "new").length,
    known: items.filter((i) => i.remote?.status === "already_imported").length,
    attention: items.filter((i) => i.local.status === "pending" || i.local.status === "ignored" || i.remote?.status === "conflict" || i.remote?.status === "duplicate_in_file" || overlapBlocked.has(i.local.index)).length,
  };
  const choicesResolved = (!parsed?.missingYear || Boolean(year)) && (parsed?.scaleDecisions ?? []).every((decision) => scales[decision.key]);
  const previewing = previewMutation.isPending || busy;
  const commitReady = items.filter((item) => {
    const { local, remote } = item;
    if (!item.included || !selectedSheets.has(local.sourceSheet) || local.status !== "ready" || overlapBlocked.has(local.index)) return false;
    if (remote?.status === "new") return true;
    if (remote?.status === "conflict") return (item.conflictUpdate
      && !!remote.existingRecord?.id && Number.isFinite(remote.existingRecord.version))
      || (item.keepBothConfirmed && (!remote.existingRecord || (!!remote.existingRecord.id && Number.isFinite(remote.existingRecord.version))));
    return false;
  });

  const clear = () => {
    bytesRef.current = null; setFilename(""); setParsed(null); setItems([]); setYear(""); setScales({});
    setModalityMappings({}); setError(""); setProgress(""); setResults([]); setBusy(false);
  };
  const close = (next: boolean) => { if (!next && !busy) { clear(); onOpenChange(false); } else onOpenChange(next); };

  const runParser = async (
    arrayBuffer: ArrayBuffer,
    name: string,
    options?: { missingYear?: number; scaleDecisions?: Record<string, ScaleChoice> },
    mappings: Record<string, string> = modalityMappings,
  ) => {
    setError(""); setItems([]); setResults([]);
    const result = await parseOccupancySpreadsheet(arrayBuffer, name, options);
    setParsed(result);
    setScales(options?.scaleDecisions ?? {});
    if (!result.missingYear && result.scaleDecisions.length === 0) await runPreview(result, mappings);
  };

  const runPreview = async (data: ParsedOccupancyImport, mappings: Record<string, string> = modalityMappings) => {
    const candidates = data.entries.filter((entry) => entry.status === "ready"
      && data.sheets.some((sheet) => sheet.name === entry.sourceSheet && sheet.selected));
    const remoteByIndex = new Map<number, OccupancyImportPreviewRow>();
    if (!candidates.length) {
      setItems(data.entries.map((local) => ({ local, conflictUpdate: false, keepBothConfirmed: false, included: false })));
      return;
    }
    setBusy(true);
    try {
      for (let start = 0; start < candidates.length; start += 250) {
        setProgress(`Conferindo ${Math.min(start + 250, candidates.length)} de ${candidates.length} linhas…`);
        const entries = candidates.slice(start, start + 250).map((entry) => toPreviewInput(entry, mappings, existingModalities));
        const response = await previewMutation.mutateAsync({ data: { fileHash: data.fileHash, entries } });
        response.rows.forEach((row) => remoteByIndex.set(row.index, row));
      }
      setItems((previous) => data.entries.map((local) => {
        const remote = remoteByIndex.get(local.index);
        const prior = previous.find((item) => item.local.index === local.index);
        return {
          local, remote, conflictUpdate: prior?.conflictUpdate ?? false,
          keepBothConfirmed: prior?.keepBothConfirmed ?? false,
          included: prior?.included ?? remote?.status === "new",
        };
      }));
      setProgress("");
    } catch (e) {
      setError(readError(e, "Não foi possível conferir os registros na base."));
    } finally { setBusy(false); }
  };

  const handleFile = async (file?: File) => {
    if (!file) return;
    clear(); setFilename(file.name); setBusy(true);
    try {
      const bytes = await file.arrayBuffer();
      bytesRef.current = bytes;
      await runParser(bytes, file.name, undefined, {});
    } catch (e) { setError(readError(e, "Não foi possível ler esta planilha.")); }
    finally { setBusy(false); }
  };
  const resolveOptions = async () => {
    if (!bytesRef.current || !filename || !parsed) return;
    if (parsed.missingYear && !/^\d{4}$/.test(year)) { setError("Informe um ano válido com quatro dígitos."); return; }
    if (parsed.scaleDecisions.some((decision) => !scales[decision.key])) { setError("Escolha a escala percentual de cada bloco ambíguo."); return; }
    setBusy(true);
    try {
      const updated = await parseOccupancySpreadsheet(bytesRef.current, filename, {
        ...(parsed.missingYear ? { missingYear: Number(year) } : {}),
        scaleDecisions: scales,
      });
      setParsed(updated);
      await runPreview(updated);
    } catch (e) { setError(readError(e, "Não foi possível atualizar a leitura da planilha.")); }
    finally { setBusy(false); }
  };
  const toggleSheet = (name: string) => {
    if (!parsed) return;
    const sheets = parsed.sheets.map((sheet) => sheet.name === name ? { ...sheet, selected: !sheet.selected } : sheet);
    const next = { ...parsed, sheets };
    setParsed(next);
    setItems((current) => current.map((item) => item.local.sourceSheet === name && item.local.status === "ready" ? { ...item, remote: undefined } : item));
    const eligible = next.entries.some((e) => e.status === "ready" && sheets.some((s) => s.name === e.sourceSheet && s.selected));
    const resolved = (!next.missingYear || /^\d{4}$/.test(year)) && next.scaleDecisions.every((decision) => !!scales[decision.key]);
    if (eligible && resolved) void runPreview(next);
  };
  const toggleConflict = (index: number, checked: boolean) => setItems((current) => current.map((item) => item.local.index === index
    ? { ...item, conflictUpdate: checked, keepBothConfirmed: false, included: checked }
    : item));
  const toggleKeepBoth = (index: number, checked: boolean) => setItems((current) => current.map((item) => item.local.index === index
    ? { ...item, conflictUpdate: false, keepBothConfirmed: checked, included: checked || (item.remote?.status === "new" && item.included) }
    : item));
  const toggleRow = (index: number, checked: boolean) => setItems((current) => current.map((item) => item.local.index === index
    ? { ...item, included: checked, keepBothConfirmed: checked ? item.keepBothConfirmed : false }
    : item));
  const updateModalityMapping = async (sourceName: string, modalityId: string) => {
    const next = { ...modalityMappings, [sourceName]: modalityId };
    setModalityMappings(next);
    setItems((current) => current.map((item) => ({
      ...item, conflictUpdate: false, keepBothConfirmed: false, included: item.remote?.status === "new",
    })));
    if (parsed && !parsed.missingYear && parsed.scaleDecisions.length === 0) await runPreview(parsed, next);
  };

  const commit = async () => {
    if (!parsed || !commitReady.length || !choicesResolved || busy) return;
    setBusy(true); setError(""); setResults([]);
    const output: Array<{ index: number; status: string; message: string }> = [];
    let committedAny = false;
    try {
      for (let start = 0; start < commitReady.length; start += 250) {
        const batch = commitReady.slice(start, start + 250);
        setProgress(`Importando ${Math.min(start + batch.length, commitReady.length)} de ${commitReady.length} linhas…`);
        const response = await commitMutation.mutateAsync({ data: {
          fileHash: parsed.fileHash,
          entries: batch.map((item) => {
            const record = toPreviewInput(item.local, modalityMappings, existingModalities);
            const existing = item.remote?.status === "conflict" ? item.remote.existingRecord : null;
            return {
              record, ...(existing ? { existingRecordId: existing.id, expectedVersion: existing.version } : {}),
              ...(item.keepBothConfirmed ? { keepBothConfirmed: true } : {}),
            };
          }),
        } });
        committedAny = true;
        output.push(...response.rows.map((row) => ({ index: row.index, status: row.status, message: row.message })));
        setResults([...output]);
      }
      setProgress("Importação concluída.");
    } catch (e) {
      setError(readError(e, "A importação foi interrompida. Os resultados parciais estão preservados."));
    } finally {
      if (committedAny) onImported();
      setBusy(false);
    }
  };

  return <Dialog open={open} onOpenChange={close}>
    <DialogContent className="max-h-[92dvh] w-[min(96vw,1100px)] overflow-hidden border-[#e7e1e9] bg-[#fffefc] p-0 text-[#332d40] sm:max-w-[1100px]" aria-describedby="occupancy-import-description">
      <div className="flex max-h-[92dvh] flex-col">
        <DialogHeader className="border-b border-[#ece7ee] px-5 py-5 pr-12 sm:px-7">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#eee8f7] text-[#7656b8]"><FileSpreadsheet size={18}/></span>
            <div><p className="text-[9px] font-bold uppercase tracking-[.12em] text-[#8a8491]">Importação · etapa 3 de 6</p><DialogTitle className="mt-1 text-xl font-extrabold tracking-[-.04em]">Importar ocupação</DialogTitle>
              <DialogDescription id="occupancy-import-description" className="mt-1 text-xs leading-5 text-[#77717f]">A planilha é lida neste navegador. Os bytes não são enviados nem armazenados.</DialogDescription></div>
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="space-y-5 p-4 sm:p-6">
            <label className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-[#cfc4dc] bg-[#faf8fc] px-4 py-5 text-center transition hover:bg-[#f5f1f9]">
              <input className="sr-only" type="file" accept=".xlsx,.csv" disabled={busy} onChange={(event) => void handleFile(event.target.files?.[0])} aria-label="Selecionar planilha XLSX ou CSV"/>
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-white text-[#7656b8] shadow-sm"><Upload size={16}/></span>
              <span className="mt-2 text-xs font-extrabold">{filename || "Selecionar arquivo XLSX ou CSV"}</span>
              <span className="mt-1 text-[10px] text-[#8a8491]">O arquivo permanece somente na memória desta sessão.</span>
            </label>
            {parsed && <>
              <div className="grid grid-cols-3 gap-2" aria-label="Resumo da importação">
                <Count label="Novos" value={counts.new} color="lime"/>
                <Count label="Já importados" value={counts.known} color="violet"/>
                <Count label="Revisar" value={counts.attention} color="rose"/>
              </div>
              <section className="rounded-2xl border border-[#ece7ee] bg-white p-4">
                <div className="flex items-center justify-between gap-2"><div><h3 className="text-xs font-extrabold">Abas da planilha</h3><p className="mt-1 text-[10px] text-[#8a8491]">{parsed.sheets.length} abas · {parsed.blankCount} linhas vazias ignoradas</p></div></div>
                <div className="mt-3 flex flex-wrap gap-2">{parsed.sheets.map((sheet) => <label key={sheet.name} className={`inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border px-3 text-[11px] font-bold ${sheet.selected ? "border-[#c7b7dd] bg-[#f5f1fa] text-[#5d4a78]" : "border-[#ebe7ed] bg-[#fbfafb] text-[#837d89]"}`}>
                  <input type="checkbox" checked={sheet.selected} onChange={() => toggleSheet(sheet.name)} className="accent-[#7656b8]"/>
                  <span>{sheet.name}</span><span className="font-mono text-[9px] opacity-70">{sheet.entryCount}</span>{sheet.hidden && <span className="text-[9px]">oculta</span>}
                </label>)}</div>
              </section>
              {modalityAssociations.length > 0 && <section className="space-y-3 rounded-2xl border border-[#e7def1] bg-[#faf8fc] p-4">
                <div><h3 className="text-xs font-extrabold text-[#51445f]">Confirmar modalidade semelhante</h3><p className="mt-1 text-[10px] leading-4 text-[#817b89]">Nenhuma associação é automática. Se os nomes significarem a mesma modalidade, associe aqui uma vez para este envio.</p></div>
                {modalityAssociations.map(({ sourceName, target }) => <label key={sourceName} className="grid gap-2 text-[10px] font-semibold text-[#5c5367] sm:grid-cols-[1fr_260px] sm:items-center">
                  <span><b>{sourceName}</b> na planilha corresponde a {target.name} já cadastrado?</span>
                  <select value={modalityMappings[sourceName] ?? ""} onChange={(event) => void updateModalityMapping(sourceName, event.target.value)} className="h-10 rounded-lg border border-[#d9cee5] bg-white px-3 text-xs font-semibold text-[#51445f]">
                    <option value="">Manter como modalidade separada</option>
                    <option value={target.id}>Associar a {target.name}</option>
                  </select>
                </label>)}
                {modalitiesQuery.isError && <p role="status" className="text-[10px] text-[#8e3d33]">Não foi possível carregar modalidades existentes; a importação manterá os nomes da planilha separados.</p>}
              </section>}
              {(parsed.missingYear || parsed.scaleDecisions.length > 0) && <section className="space-y-3 rounded-2xl border border-[#e9d9a7] bg-[#fffaf0] p-4">
                <div><h3 className="text-xs font-extrabold text-[#665126]">Confirmações necessárias</h3><p className="mt-1 text-[10px] leading-4 text-[#81724c]">A prévia só libera após resolver todas as escolhas. Nenhum valor será ajustado sem sua confirmação.</p></div>
                {parsed.missingYear && <label className="block text-[10px] font-bold uppercase tracking-[.08em] text-[#81724c]">Ano dos períodos sem ano
                  <input type="number" min="1900" max="2199" value={year} onChange={(e) => setYear(e.target.value)} placeholder={parsed.yearsFound.length ? `Ex.: ${parsed.yearsFound[0]}` : "AAAA"} className="mt-1.5 h-10 w-full max-w-[200px] rounded-lg border border-[#e7dcbf] bg-white px-3 text-sm font-semibold text-[#443d50]"/>
                </label>}
                {parsed.scaleDecisions.map((decision) => <fieldset key={decision.key} className="rounded-xl border border-[#eee4ca] bg-white p-3">
                  <legend className="px-1 text-[10px] font-bold text-[#665126]">{decision.sheet} · coluna {decision.column}</legend>
                  <p className="text-[10px] text-[#81724c]">Exemplo encontrado: <b className="font-mono">{decision.example}</b></p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(["percent", "fraction"] as const).map((choice) => <label key={choice} className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-[10px] font-bold ${scales[decision.key] === choice ? "border-[#9b8757] bg-[#fff8e6]" : "border-[#eee9dd]"}`}>
                      <input type="radio" name={`scale-${decision.key}`} checked={scales[decision.key] === choice} onChange={() => setScales((value) => ({ ...value, [decision.key]: choice }))} className="accent-[#8a7139]"/>
                      {choice === "percent" ? "0–100 representa percentual" : "0–1 representa fração"}
                    </label>)}
                  </div>
                </fieldset>)}
                <button type="button" onClick={() => void resolveOptions()} disabled={!choicesResolved || busy} className={`${button} bg-[#7656b8] text-white hover:bg-[#6748a7]`}>{busy ? <LoaderCircle size={14} className="animate-spin"/> : <Check size={14}/>} Aplicar escolhas e conferir</button>
              </section>}
              <section className="overflow-hidden rounded-2xl border border-[#ece7ee] bg-white">
                <div className="flex flex-col gap-1 border-b border-[#ece7ee] px-4 py-3 sm:flex-row sm:items-center sm:justify-between"><div><h3 className="text-xs font-extrabold">Revisão das linhas</h3><p className="mt-1 text-[10px] text-[#8a8491]">Origem preservada por aba e célula. Linhas pendentes, ignoradas ou sobrepostas nunca são enviadas.</p></div><span className="text-[10px] font-semibold text-[#8a8491]">{items.length} linhas analisadas</span></div>
                <div className="max-h-[min(40dvh,420px)] overflow-auto">
                  <ul className="divide-y divide-[#f0edf1]">
                    {items.map(({ local, remote, conflictUpdate, keepBothConfirmed, included }) => {
                      const blocked = overlapBlocked.has(local.index);
                      const duplicateKey = duplicateKeyByIndex.get(local.index);
                      const localDuplicates = duplicateKey ? items.filter((candidate) => duplicateKeyByIndex.get(candidate.local.index) === duplicateKey) : [];
                      const duplicatePeer = localDuplicates.find((candidate) => candidate.local.index !== local.index);
                      const localDuplicate = localDuplicates.length > 1;
                      const shownStatus = local.status !== "ready" ? local.status
                        : blocked ? "pending"
                          : localDuplicate && remote?.status === "new" ? "duplicate_in_file" : remote?.status;
                      const rowMessage = blocked
                        ? "Há mais de uma linha selecionada para o mesmo escopo. Desmarque uma ou confirme que representam aulas distintas."
                        : localDuplicate && remote?.status === "new"
                          ? `Este escopo também aparece em ${duplicatePeer?.local.sourceSheet} · ${duplicatePeer?.local.sourceCell}. Importe só uma linha ou confirme que são aulas diferentes.`
                          : remote?.message || local.reason || "Aguardando conferência da base.";
                      return <li key={local.index} className="grid gap-2 px-4 py-3 sm:grid-cols-[22px_minmax(130px,.8fr)_minmax(150px,1fr)_minmax(200px,1.5fr)_auto] sm:items-center">
                        <input type="checkbox" aria-label={`Incluir linha ${local.sourceSheet} ${local.sourceCell}`} checked={included} disabled={local.status !== "ready" || !selectedSheets.has(local.sourceSheet) || remote?.status === "already_imported" || remote?.status === "duplicate_in_file"} onChange={(e) => toggleRow(local.index, e.target.checked)} className="accent-[#7656b8]"/>
                        <div className="min-w-0"><p className="truncate text-[11px] font-extrabold">{local.modalityName || "Modalidade não identificada"}</p><p className="mt-1 font-mono text-[9px] text-[#8a8491]">{local.sourceSheet} · {local.sourceCell}</p></div>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-semibold text-[#5c5367]">
                          <span>{formatPeriod(local.period)}</span>
                          <span className="rounded bg-[#f3f0f5] px-1.5 py-0.5">{local.kind === "daily" ? "Diário" : local.kind === "monthly" ? "Mensal" : "Tipo —"}</span>
                          {(local.startTime || local.endTime) && <span className="tabular-nums">{local.startTime || "—"}{local.endTime ? `–${local.endTime}` : ""}</span>}
                          {(local.presences !== null || local.capacity !== null) && <span className="tabular-nums">{local.presences ?? "—"}/{local.capacity ?? "—"}</span>}
                          <span className="tabular-nums">Calc.: {pct(local.percentage)}</span>
                          {local.reportedPercentage !== null && <span className="tabular-nums">Planilha: {pct(local.reportedPercentage)}</span>}
                        </div>
                        <div className="min-w-0"><span className={`inline-flex rounded-full px-2 py-1 text-[9px] font-extrabold ${badgeClass(shownStatus)}`}>{statusLabel(shownStatus)}</span>
                          <p className="mt-1 text-[10px] leading-4 text-[#817b89]">{rowMessage}</p>
                          {remote?.status === "conflict" && remote.existingRecord && <p className="mt-1 text-[10px] text-[#746b7c]">Atual: {remote.existingRecord.modalityName} · {formatPeriod(remote.existingRecord.period)} · {remote.existingRecord.startTime || "sem horário"} · {remote.existingRecord.presences ?? "—"}/{remote.existingRecord.capacity ?? "—"} · {pct(remote.existingRecord.percentage)}</p>}
                        </div>
                        <div className="space-y-2">
                          {remote?.status === "conflict" && local.status === "ready" && <label className="inline-flex items-center gap-2 text-[10px] font-bold text-[#8e3d33]"><input type="checkbox" checked={conflictUpdate} onChange={(e) => toggleConflict(local.index, e.target.checked)} className="accent-[#a24f45]"/> Atualizar registro existente</label>}
                          {local.status === "ready" && (remote?.status === "conflict" || (localDuplicate && remote?.status === "new")) && <label className="flex items-start gap-2 text-[10px] font-bold leading-4 text-[#695287]">
                            <input type="checkbox" checked={keepBothConfirmed} onChange={(e) => toggleKeepBoth(local.index, e.target.checked)} className="mt-0.5 accent-[#7656b8]"/>
                            <span>Confirmo que são aulas distintas; manter ambas</span>
                          </label>}
                        </div>
                      </li>;
                    })}
                    {!items.length && <li className="px-4 py-8 text-center text-xs text-[#8a8491]">{previewing ? "Conferindo planilha…" : "Aplique as confirmações para exibir a prévia."}</li>}
                  </ul>
                </div>
              </section>
            </>}
            {error && <div role="alert" className="flex items-start gap-2 rounded-xl border border-[#f1d0ca] bg-[#fff3f1] px-3.5 py-3 text-xs font-semibold leading-5 text-[#8e3d33]"><AlertCircle size={15} className="mt-0.5 shrink-0"/><span>{error}</span></div>}
            {(progress || results.length > 0) && <div className="rounded-xl bg-[#f5f2f7] px-4 py-3 text-xs" role="status" aria-live="polite"><p className="font-bold text-[#51465f]">{progress || "Importação parcial"}</p>{results.length > 0 && <p className="mt-1 text-[10px] text-[#817b89]">{results.length} respostas processadas · {results.filter((r) => r.status === "inserted").length} novas · {results.filter((r) => r.status === "updated").length} atualizadas · {results.filter((r) => ["conflict", "duplicate_in_batch"].includes(r.status)).length} pendentes</p>}</div>}
          </div>
        </div>
        <div className="flex flex-col-reverse gap-2 border-t border-[#ece7ee] bg-[#fffefc] px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <button type="button" onClick={() => close(false)} disabled={busy} className={`${button} border border-[#ded7e7] bg-white text-[#5d4a78] hover:bg-[#f7f4fa]`}><X size={14}/> Fechar</button>
          <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center"><span className="text-center text-[10px] font-semibold text-[#817b89]">{commitReady.length} linhas prontas para importar</span>
            <button type="button" onClick={() => void commit()} disabled={!commitReady.length || !choicesResolved || busy} aria-busy={busy} className={`${button} bg-[#d7f500] text-[#262b15] hover:bg-[#c9e600]`}>{busy ? <LoaderCircle size={14} className="animate-spin"/> : <Upload size={14}/>} Importar selecionadas</button>
          </div>
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}

function Count({ label, value, color }: { label: string; value: number; color: "lime" | "violet" | "rose" }) {
  const colors = { lime: "bg-[#f1f7df] text-[#526c27]", violet: "bg-[#f2edf8] text-[#624b82]", rose: "bg-[#fff1ee] text-[#985348]" };
  return <div className={`rounded-xl px-3 py-2.5 ${colors[color]}`}><p className="text-[9px] font-bold uppercase tracking-[.09em] opacity-75">{label}</p><p className="mt-0.5 font-mono text-lg font-bold tabular-nums">{value}</p></div>;
}
function badgeClass(status?: string) {
  if (status === "new" || status === "ready") return "bg-[#edf5dc] text-[#58742b]";
  if (status === "already_imported") return "bg-[#f1edf6] text-[#695685]";
  if (status === "conflict" || status === "pending") return "bg-[#fff0ec] text-[#9c5144]";
  return "bg-[#f2f0f2] text-[#77717f]";
}
function toPreviewInput(
  entry: ParsedOccupancyImport["entries"][number],
  mappings: Record<string, string> = {},
  modalities: Array<{ id: string; name: string }> = [],
): OccupancyImportRowInput {
  const modalityId = entry.modalityName ? mappings[entry.modalityName] : undefined;
  const mappedModality = modalities.find((modality) => modality.id === modalityId);
  const hasValidMeasurements = entry.presences !== null && entry.capacity !== null && entry.startTime !== null;
  if (entry.kind === null || entry.period === null || !entry.modalityName || (entry.percentage === null && !hasValidMeasurements)) {
    throw new Error("Uma linha sem dados obrigatórios foi impedida de seguir para a importação.");
  }
  return {
    index: entry.index, kind: entry.kind, period: entry.period,
    modalityName: mappedModality?.name ?? entry.modalityName,
    ...(mappedModality ? { modalityId: mappedModality.id } : {}),
    ...(!hasValidMeasurements && entry.percentage !== null ? { percentage: entry.percentage } : {}),
    ...(entry.reportedPercentage !== null ? { reportedPercentage: entry.reportedPercentage } : {}),
    ...(entry.presences !== null ? { presences: entry.presences } : {}),
    ...(entry.capacity !== null ? { capacity: entry.capacity } : {}),
    ...(hasValidMeasurements && entry.startTime ? { startTime: entry.startTime } : {}),
    ...(hasValidMeasurements && entry.endTime ? { endTime: entry.endTime } : {}),
    ...(entry.className ? { className: entry.className } : {}),
    sourceSheet: entry.sourceSheet, sourceCell: entry.sourceCell, sourceCells: entry.sourceCells,
  };
}
function normalizeModality(value: string) {
  return value.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").replace(/\s+/g, " ");
}
function isCrossFitAlias(a: string, b: string) {
  const left = normalizeModality(a);
  const right = normalizeModality(b);
  return (left === "crossfit" && right === "crossfit presencial")
    || (right === "crossfit" && left === "crossfit presencial");
}
function readError(error: unknown, fallback: string) {
  const value = error && typeof error === "object" ? error as { message?: unknown; data?: { error?: unknown } } : null;
  if (typeof value?.data?.error === "string") return value.data.error;
  if (typeof value?.message === "string") return value.message;
  return fallback;
}
