import type { ImportSourceRow } from "@/lib/sales-import-source";

export function ImportSourceDetails({ source }: { source: ImportSourceRow }) {
  return <details className="mt-1 text-[10px] font-normal text-[#655579]">
    <summary className="cursor-pointer">Consultar células originais</summary>
    <ul className="mt-1 space-y-1 break-words rounded-lg bg-[#f8f6fa] p-2">
      {source.sourceCells.filter((cell) => String(cell.value ?? "").trim() || cell.formula).map((cell) =>
        <li key={cell.address}>
          <strong>{cell.address}</strong>: {String(cell.value ?? "") || "(vazia)"}
          {cell.formula && <span> · fórmula: {cell.formula}{!String(cell.value ?? "").trim() ? " · sem resultado utilizável" : ""}</span>}
          {cell.format && <span> · formato: {cell.format}</span>}
          {cell.hiddenColumn && <span> · coluna oculta</span>}
        </li>,
      )}
    </ul>
  </details>;
}
