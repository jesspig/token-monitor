import { Fragment, memo, useMemo, type ReactElement, type ReactNode } from 'react'
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'

export interface DimensionSeries {
  key: string
  name: string
  color: string
  axis?: 'left' | 'right'
  chartType?: 'area' | 'line' | 'bar'
  stackId?: string
}

interface DimensionChartProps {
  data: Array<Record<string, any>>
  xKey: string
  series: DimensionSeries[]
  height?: number
}

function gradId(series: DimensionSeries): string {
  return `dim-grad-${series.key}`.replace(/[^a-zA-Z0-9_-]/g, '')
}

function DimensionChartImpl({
  data,
  xKey,
  series,
  height = 240
}: DimensionChartProps): ReactElement {
  const hasRight = series.some((s) => s.axis === 'right')

  const defs = useMemo(
    () => (
      <defs>
        {series
          .filter((s) => (s.chartType ?? 'area') === 'area')
          .map((s) => (
            <linearGradient key={s.key} id={gradId(s)} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0} />
            </linearGradient>
          ))}
      </defs>
    ),
    [series]
  )

  const renderSeries = (s: DimensionSeries): ReactNode => {
    const yAxisId = (s.axis ?? 'left') as 'left' | 'right'
    const chartType = s.chartType ?? 'area'
    const common = {
      yAxisId,
      type: 'monotone' as const,
      dataKey: s.key,
      name: s.name,
      stroke: s.color,
      strokeWidth: 2
    }
    if (chartType === 'line') {
      return <Line {...common} dot={false} isAnimationActive={false} />
    }
    if (chartType === 'bar') {
      return (
        <Bar
          yAxisId={yAxisId}
          dataKey={s.key}
          name={s.name}
          fill={s.color}
          fillOpacity={0.8}
          isAnimationActive={false}
          stackId={s.stackId}
        />
      )
    }
    return <Area {...common} stackId={s.stackId} fill={`url(#${gradId(s)})`} fillOpacity={0.9} strokeOpacity={0.9} isAnimationActive={false} />
  }

  const allBar = series.length > 0 && series.every((s) => (s.chartType ?? 'area') === 'bar')
  const allArea = series.length > 0 && series.every((s) => (s.chartType ?? 'area') === 'area')
  const allLine = series.length > 0 && series.every((s) => s.chartType === 'line')

  const chartContent = (
    <>
      {defs}
      <CartesianGrid strokeDasharray="3 3" stroke="#262626" vertical={false} />
      <XAxis
        dataKey={xKey}
        tick={{ fill: '#737373', fontSize: 11 }}
        tickLine={false}
        axisLine={{ stroke: '#262626' }}
        minTickGap={24}
        interval="preserveStartEnd"
      />
      <YAxis
        yAxisId="left"
        domain={['auto', 'auto']}
        allowDecimals={false}
        tick={{ fill: '#737373', fontSize: 11 }}
        tickLine={false}
        axisLine={false}
        width={40}
      />
      {hasRight && (
        <YAxis
          yAxisId="right"
          domain={['auto', 'auto']}
          allowDecimals={false}
          orientation="right"
          tick={{ fill: '#737373', fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={46}
        />
      )}
      <Tooltip
        contentStyle={{
          background: '#171717',
          border: '1px solid #262626',
          borderRadius: 8,
          fontSize: 12
        }}
        labelStyle={{ color: '#d4d4d4' }}
        cursor={{ fill: 'rgba(255,255,255,0.04)' }}
      />
      {series.map((s) => (
        <Fragment key={s.key}>{renderSeries(s)}</Fragment>
      ))}
    </>
  )

  return (
    <ResponsiveContainer width="100%" height={height} debounce={50}>
      {allBar ? (
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="20%" barGap={2}>
          {chartContent}
        </ComposedChart>
      ) : allArea ? (
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          {chartContent}
        </ComposedChart>
      ) : allLine ? (
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          {chartContent}
        </ComposedChart>
      ) : (
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          {chartContent}
        </ComposedChart>
      )}
    </ResponsiveContainer>
  )
}

export const DimensionChart = memo(DimensionChartImpl)
export default DimensionChart
