import type { LucideIcon } from 'lucide-react'

export type StatCardAccent = 'blue' | 'green' | 'yellow' | 'red'

const accentMap: Record<
  StatCardAccent,
  {
    borderTop: string
    value: string
    iconWrap: string
    glow: string
  }
> = {
  blue: {
    borderTop: 'border-t-4 border-google-blue',
    value: 'text-google-blue',
    iconWrap: 'rounded-2xl bg-blue-100 text-blue-600 ring-1 ring-blue-200/80',
    glow: 'from-google-blue/20 via-transparent to-transparent',
  },
  green: {
    borderTop: 'border-t-4 border-google-green',
    value: 'text-google-green',
    iconWrap: 'rounded-2xl bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200/80',
    glow: 'from-google-green/20 via-transparent to-transparent',
  },
  yellow: {
    borderTop: 'border-t-4 border-google-yellow',
    value: 'text-amber-700',
    iconWrap: 'rounded-2xl bg-amber-100 text-amber-700 ring-1 ring-amber-200/80',
    glow: 'from-google-yellow/25 via-transparent to-transparent',
  },
  red: {
    borderTop: 'border-t-4 border-google-red',
    value: 'text-google-red',
    iconWrap: 'rounded-2xl bg-red-100 text-red-600 ring-1 ring-red-200/80',
    glow: 'from-google-red/15 via-transparent to-transparent',
  },
}

type StatCardProps = {
  title: string
  value: string
  subtitle?: string
  icon: LucideIcon
  trend?: string
  trendPositive?: boolean
  /** Cor do “color block” (borda superior, número e ícone). Padrão: azul Google. */
  accent?: StatCardAccent
}

export function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  trend,
  trendPositive = true,
  accent = 'blue',
}: StatCardProps) {
  const a = accentMap[accent]

  return (
    <article
      className={`group relative overflow-hidden rounded-2xl border border-zinc-200/90 bg-white shadow-md shadow-zinc-900/5 ring-1 ring-zinc-100/80 transition hover:shadow-lg ${a.borderTop}`}
    >
      <div
        className={`pointer-events-none absolute -right-8 -top-8 h-36 w-36 rounded-full bg-gradient-to-br ${a.glow} blur-2xl`}
      />
      <div className="relative p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-zinc-500">{title}</p>
            <p className={`mt-2 text-4xl font-bold tabular-nums tracking-tight ${a.value}`}>
              {value}
            </p>
            {subtitle ? (
              <p className="mt-1.5 text-sm leading-snug text-zinc-600">{subtitle}</p>
            ) : null}
          </div>
          <span
            className={`inline-flex h-12 w-12 shrink-0 items-center justify-center shadow-inner transition group-hover:scale-105 ${a.iconWrap}`}
          >
            <Icon className="h-6 w-6" aria-hidden />
          </span>
        </div>
        {trend ? (
          <p
            className={`mt-4 text-sm font-medium ${
              trendPositive ? 'text-emerald-600' : 'text-rose-600'
            }`}
          >
            {trend}
          </p>
        ) : null}
      </div>
    </article>
  )
}
