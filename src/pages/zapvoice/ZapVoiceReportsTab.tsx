import { useCallback, useEffect, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { FileSpreadsheet, FileText, Loader2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import * as XLSX from 'xlsx'
import { jsPDF } from 'jspdf'

type CampaignLite = { id: string; name: string }

type Props = {
  userId: string
  campaigns: CampaignLite[]
}

type RowStat = {
  campaign_id: string | null
  lead_id: string | null
  status: string | null
  last_error: string | null
}

export function ZapVoiceReportsTab({ userId, campaigns }: Props) {
  const [campaignId, setCampaignId] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [leads, setLeads] = useState(0)
  const [triggers, setTriggers] = useState(0)
  const [fails, setFails] = useState(0)
  const [chartData, setChartData] = useState<{ name: string; value: number }[]>([])

  const load = useCallback(async () => {
    if (!campaignId) {
      setLeads(0)
      setTriggers(0)
      setFails(0)
      setChartData([])
      return
    }
    setLoading(true)
    try {
      const { data, error: e } = await supabase
        .from('scheduled_messages')
        .select('zv_campaign_id, lead_id, status, last_error')
        .eq('user_id', userId)
        .eq('zv_campaign_id', campaignId)
      if (e) throw new Error(e.message)
      const rows = (data ?? []) as RowStat[]
      const leadSet = new Set<string>()
      for (const r of rows) {
        if (r.lead_id) leadSet.add(r.lead_id)
      }
      const failCount = rows.filter((r) =>
        ['failed', 'error'].includes((r.status ?? '').toLowerCase()),
      ).length
      const { count: progCount, error: pe } = await supabase
        .from('lead_campaign_progress')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('campaign_id', campaignId)
      if (pe) throw new Error(pe.message)
      setLeads(leadSet.size)
      setTriggers(progCount ?? 0)
      setFails(failCount)
      setChartData([
        { name: 'Leads alcançados', value: leadSet.size },
        { name: 'Progressos (fluxo)', value: progCount ?? 0 },
        { name: 'Falhas na fila', value: failCount },
      ])
    } catch (err) {
      console.error(err)
      setLeads(0)
      setTriggers(0)
      setFails(0)
      setChartData([])
    } finally {
      setLoading(false)
    }
  }, [userId, campaignId])

  useEffect(() => {
    void load()
  }, [load])

  const exportCsv = () => {
    const pick = campaigns.find((c) => c.id === campaignId)
    if (!pick) return
    const ws = XLSX.utils.aoa_to_sheet([
      ['Métrica', 'Valor'],
      ['Campanha', pick.name],
      ['Leads alcançados', leads],
      ['Progressos (fluxo)', triggers],
      ['Falhas (fila)', fails],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Resumo')
    XLSX.writeFile(wb, `zapvoice-relatorio-${pick.id.slice(0, 8)}.xlsx`)
  }

  const exportPdf = () => {
    const pick = campaigns.find((c) => c.id === campaignId)
    if (!pick) return
    const doc = new jsPDF()
    doc.setFontSize(16)
    doc.text('Zap Voice — Relatório', 14, 20)
    doc.setFontSize(11)
    doc.text(`Campanha: ${pick.name}`, 14, 32)
    doc.text(`Leads alcançados: ${leads}`, 14, 42)
    doc.text(`Progressos (fluxo acionado): ${triggers}`, 14, 50)
    doc.text(`Falhas na fila: ${fails}`, 14, 58)
    doc.save(`zapvoice-relatorio-${pick.id.slice(0, 8)}.pdf`)
  }

  return (
    <div className="space-y-5 rounded-2xl border border-zinc-200/90 bg-white p-6 shadow-sm ring-1 ring-zinc-100/80">
      <div>
        <h3 className="text-lg font-semibold text-zinc-900">Relatórios de campanha</h3>
        <p className="mt-1 text-sm text-zinc-600">
          Selecione uma campanha para ver indicadores e exportar.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px]">
          <label className="mb-1 block text-xs font-medium text-zinc-700">Campanha</label>
          <select
            value={campaignId}
            onChange={(e) => setCampaignId(e.target.value)}
            className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
          >
            <option value="">Selecione…</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={!campaignId || loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Atualizar
        </button>
        <button
          type="button"
          onClick={exportCsv}
          disabled={!campaignId}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          <FileSpreadsheet className="h-3.5 w-3.5" />
          Exportar XLSX
        </button>
        <button
          type="button"
          onClick={exportPdf}
          disabled={!campaignId}
          className="inline-flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-2 text-xs font-semibold text-white hover:bg-zinc-900 disabled:opacity-50"
        >
          <FileText className="h-3.5 w-3.5" />
          Exportar PDF
        </button>
      </div>

      {campaignId && !loading ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-4">
            <p className="text-[11px] font-semibold uppercase text-zinc-500">Leads alcançados</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-zinc-900">{leads}</p>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-4">
            <p className="text-[11px] font-semibold uppercase text-zinc-500">Fluxo acionado</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-zinc-900">{triggers}</p>
            <p className="mt-0.5 text-[10px] text-zinc-500">Registros em lead_campaign_progress</p>
          </div>
          <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-4">
            <p className="text-[11px] font-semibold uppercase text-rose-700">Falhas (fila)</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-rose-900">{fails}</p>
          </div>
        </div>
      ) : null}

      {campaignId && chartData.length > 0 ? (
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-zinc-200" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} className="text-zinc-600" />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip
                contentStyle={{ borderRadius: 8, border: '1px solid #e4e4e7' }}
                labelStyle={{ color: '#18181b' }}
              />
              <Bar dataKey="value" fill="rgb(106,0,184)" radius={[4, 4, 0, 0]} name="Quantidade" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : null}

      {campaignId && loading ? (
        <p className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Carregando métricas…
        </p>
      ) : null}
    </div>
  )
}
