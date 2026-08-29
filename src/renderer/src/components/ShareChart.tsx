import { memo } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { EmptyState } from './EmptyState'

export interface ShareDatum {
  name: string
  value: number
  color?: string
}

const DEFAULT_PALETTE = [
  '#34d399',
  '#60a5fa',
  '#f472b6',
  '#fbbf24',
  '#a78bfa',
  '#22d3ee',
  '#fb7185',
  '#a3e635',
  '#f59e0b',
  '#818cf8'
]

interface ShareChartProps {
  data: ShareDatum[]
  type?: 'pie' | 'bar'
  height?: number
  valueLabel?: (v: number) => string
}

function colorFor(d: ShareDatum, index: number): string {
  return d.color ?? DEFAULT_PALETTE[index % DEFAULT_PALETTE.length]
}

function ShareChartImpl({
  data,
  type = 'pie',
  height = 260,
  valueLabel
}: ShareChartProps) {
  const format = (v: number) => (valueLabel ? valueLabel(v) : String(v))

  if (!data || data.length === 0) {
    return <EmptyState title="暂无占比数据" description="当前筛选条件下没有可展示的占比记录。" />
  }

  const tooltipStyle = {
    background: '#171717',
    border: '1px solid #262626',
    borderRadius: 8,
    fontSize: 12
  }
  const labelStyle = { color: '#d4d4d4' }

  if (type === 'bar') {
    const palette = data.map((d, i) => colorFor(d, i))
    const stackedData = [
      data.reduce(
        (acc, d, i) => ({ ...acc, [`seg${i}`]: d.value, [`name${i}`]: d.name }),
        { name: '费用' } as Record<string, any>
      )
    ]
    return (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={stackedData} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#262626" vertical={false} />
          <XAxis dataKey="name" tick={{ fill: '#737373', fontSize: 11 }} tickLine={false} axisLine={{ stroke: '#262626' }} />
          <YAxis tick={{ fill: '#737373', fontSize: 11 }} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => (valueLabel ? valueLabel(v) : String(v))} />
          <Tooltip
            contentStyle={tooltipStyle}
            labelStyle={labelStyle}
            formatter={(value: number, name: string) => {
              const idx = Number(name.replace('seg', ''))
              const d = data[idx]
              return [format(value), d ? d.name : name]
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 11, color: '#d4d4d4' }}
            formatter={(value: string) => {
              const idx = Number(value.replace('seg', ''))
              const d = data[idx]
              return d ? d.name : value
            }}
          />
          {data.map((d, i) => (
            <Bar key={d.name} dataKey={`seg${i}`} stackId="cost" fill={palette[i]} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    )
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          innerRadius="45%"
          outerRadius="70%"
          paddingAngle={2}
          isAnimationActive={false}
          labelLine={false}
          label={({ percent }: { percent: number }) => (percent > 0.08 ? `${(percent * 100).toFixed(0)}%` : '')}
        >
          {data.map((d, i) => (
            <Cell key={d.name} fill={colorFor(d, i)} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={tooltipStyle}
          labelStyle={labelStyle}
          formatter={(v: number) => format(v)}
        />
        <Legend wrapperStyle={{ fontSize: 12, color: '#d4d4d4' }} />
      </PieChart>
    </ResponsiveContainer>
  )
}

export const ShareChart = memo(ShareChartImpl)
export default ShareChart
