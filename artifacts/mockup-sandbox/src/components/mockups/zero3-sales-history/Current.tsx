import { Edit3, History, X } from "lucide-react";
import "./_group.css";

type PreviewSale = {
  id: string;
  status: "active" | "cancelled";
  saleDate: string;
  productName: string;
  customerName: string;
  notes: string;
  cancellationReason: string | null;
  quantity: number;
  totalCents: number;
};

const previewSales: PreviewSale[] = [
  {
    id: "sale-long-active",
    status: "active",
    saleDate: "2026-10-05",
    productName: "Plano Anual Performance Premium de Treinamento Funcional",
    customerName: "Alexandre de Albuquerque Cavalcanti de Oliveira Filho",
    notes: "Renovação para o próximo ciclo anual com acompanhamento personalizado.",
    cancellationReason: null,
    quantity: 2,
    totalCents: 359800,
  },
  {
    id: "sale-long-cancelled",
    status: "cancelled",
    saleDate: "2026-10-03",
    productName: "Programa Especial de Condicionamento Físico e Mobilidade",
    customerName: "Fernanda Cristina de Souza Albuquerque",
    notes: "Registro preservado no histórico.",
    cancellationReason: "A cliente solicitou o cancelamento do pacote.",
    quantity: 1,
    totalCents: 189900,
  },
];

function formatDate(value: string) {
  return new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatCents(cents: number) {
  const whole = Math.floor(cents / 100);
  const fraction = String(cents % 100).padStart(2, "0");
  return `R$\u00a0${whole.toLocaleString("pt-BR")},${fraction}`;
}

export function Current() {
  return (
    <div className="min-h-screen bg-[#f7f5f1] p-4 sm:px-7 lg:px-10">
      <div className="mx-auto max-w-[1440px]">
        <section className="grid items-start gap-5 xl:grid-cols-[minmax(350px,.83fr)_minmax(0,1.17fr)]">
          <aside className="hidden min-h-[340px] rounded-[24px] border border-[#e9e4ec] bg-white p-6 shadow-[0_7px_28px_rgba(47,38,63,.035)] xl:block">
            <p className="text-[9px] font-bold uppercase tracking-[.1em] text-[#8b8494]">novo registro</p>
            <h2 className="mt-1 text-lg font-bold tracking-[-.035em]">Lançar uma venda</h2>
            <div className="mt-5 space-y-4">
              <div className="h-10 rounded-xl border border-[#e7e2ea] bg-[#fcfbfd]" />
              <div className="h-10 rounded-xl border border-[#e7e2ea] bg-[#fcfbfd]" />
              <div className="h-24 rounded-xl border border-[#e7e2ea] bg-[#fcfbfd]" />
              <div className="h-11 rounded-xl bg-[#7656b8]" />
            </div>
          </aside>

          <details open className="group min-w-0 rounded-[24px] border border-[#e9e4ec] bg-white p-5 shadow-[0_7px_28px_rgba(47,38,63,.035)] md:p-6">
            <summary className="flex list-none items-center justify-between gap-3">
              <div>
                <p className="text-[9px] font-bold uppercase tracking-[.1em] text-[#8b8494]">histórico</p>
                <h2 className="mt-1 text-lg font-bold tracking-[-.035em] text-[#332d40]">Histórico de vendas</h2>
              </div>
              <span className="rounded-xl border border-[#e9e4ec] px-3 py-2 text-xs font-bold text-[#6848a9]">Ver detalhes</span>
            </summary>

            <div className="mt-5">
              <div className="space-y-2">
                {previewSales.map((sale) => <SaleRow key={sale.id} sale={sale} />)}
              </div>
            </div>
          </details>
        </section>
      </div>
    </div>
  );
}

function SaleRow({ sale }: { sale: PreviewSale }) {
  const cancelled = sale.status === "cancelled";
  const labelClass = "mb-1 block text-[9px] font-bold uppercase tracking-[.09em] text-[#91899a]";

  return (
    <article className={`min-w-0 rounded-2xl border px-3 py-3 transition sm:px-4 ${cancelled ? "border-[#ede8e9] bg-[#fcfafa]" : "border-[#f0edf2] bg-white hover:border-[#e5dfeb] hover:bg-[#fdfcfe]"}`}>
      <div className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <div className="min-w-0">
          <span className={labelClass}>Data</span>
          <span className="block text-[11px] font-medium text-[#6f6879]">{formatDate(sale.saleDate)}</span>
        </div>
        <div className="min-w-0">
          <span className={labelClass}>Tipo</span>
          <span className="block text-[11px] font-bold text-[#81798b]">{cancelled ? "Cancelamento" : "Venda"}</span>
        </div>
        <div className="col-span-2 min-w-0">
          <span className={labelClass}>Produto</span>
          <p className={`break-words [overflow-wrap:anywhere] text-sm font-bold ${cancelled ? "text-[#77717f]" : "text-[#353044]"}`}>{sale.productName}</p>
        </div>
        <div className="col-span-2 min-w-0">
          <span className={labelClass}>Cliente</span>
          <p className="break-words [overflow-wrap:anywhere] text-[11px] font-medium text-[#5d4a78]">{sale.customerName || "Não informado"}</p>
        </div>
        <div className="min-w-0">
          <span className={labelClass}>Quantidade</span>
          <span className="block break-words text-[11px] text-[#746d7b]">{sale.quantity} un.</span>
        </div>
        <div className="min-w-0">
          <span className={labelClass}>Valor</span>
          <span className={`block break-words text-sm font-bold tabular-nums ${cancelled ? "text-[#817b86] line-through decoration-[#b38b86]" : "text-[#403650]"}`}>{formatCents(sale.totalCents)}</span>
        </div>
        <div className="min-w-0">
          <span className={labelClass}>Situação</span>
          <span className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold ${cancelled ? "bg-[#f2ecec] text-[#796565]" : "bg-[#eff6e5] text-[#55772c]"}`}>{cancelled ? "Cancelada" : "Ativa"}</span>
        </div>
      </div>
      {(sale.notes || (cancelled && sale.cancellationReason)) && <div className="mt-3 space-y-1 border-t border-[#efebf0] pt-2.5">
        {sale.notes && <p className="break-words [overflow-wrap:anywhere] text-[10px] leading-4 text-[#81798b]"><span className="font-bold">Observação:</span> {sale.notes}</p>}
        {cancelled && sale.cancellationReason && <p className="break-words [overflow-wrap:anywhere] text-[10px] leading-4 text-[#9a625b]"><span className="font-bold">Motivo:</span> {sale.cancellationReason}</p>}
      </div>}
      <div className="mt-3 flex min-w-0 flex-wrap items-center justify-end gap-1 border-t border-[#efebf0] pt-2">
        <button type="button" aria-label="Ver histórico" className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-[#776b88] transition hover:bg-[#f1edf7] hover:text-[#6848a9]"><History size={15} /></button>
        {!cancelled && <>
          <button type="button" aria-label="Editar venda" className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[11px] font-bold text-[#716a79] transition hover:bg-[#f0ebf7] hover:text-[#6848a9]"><Edit3 size={14} className="shrink-0" /> Editar</button>
          <button type="button" aria-label="Cancelar venda" className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[11px] font-bold text-[#98706b] transition hover:bg-[#fff0ed] hover:text-[#a84940]"><X size={14} className="shrink-0" /> Cancelar</button>
        </>}
        {cancelled && <span className="px-2.5 py-2 text-[10px] font-medium text-[#8a8491]">Registro preservado</span>}
      </div>
    </article>
  );
}
