import { memo, type ReactElement } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'

export interface TrendPoint {
  label: string
  requests: number
  tokens: number
}

/** 请求 / Token 双轴迷你趋势图（Dashboard 与趋势页共用） */
export const TrendChart = memo(function TrendChart({
  data,
  height = 220
}: {
  data: TrendPoint[]
  height?: number
}): ReactElement {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="trend-requests" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34d399" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="trend-tokens" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#60a5fa" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#60a5fa" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#262626" vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fill: '#737373', fontSize: 11 }}
          tickLine={false}
          axisLine={{ stroke: '#262626' }}
          minTickGap={24}
        />
        <YAxis
          yAxisId="requests"
          tick={{ fill: '#737373', fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={40}
        />
        <YAxis
          yAxisId="tokens"
          orientation="right"
          tick={{ fill: '#737373', fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={46}
        />
        <Tooltip
          contentStyle={{
            background: '#171717',
            border: '1px solid #262626',
            borderRadius: 8,
            fontSize: 12
          }}
          labelStyle={{ color: '#d4d4d4' }}
        />
        <Area
          yAxisId="requests"
          type="monotone"
          dataKey="requests"
          name="请求"
          stroke="#34d399"
          strokeWidth={2}
          fill="url(#trend-requests)"
        />
        <Area
          yAxisId="tokens"
          type="monotone"
          dataKey="tokens"
          name="Tokens"
          stroke="#60a5fa"
          strokeWidth={2}
          fill="url(#trend-tokens)"
        />
      </AreaChart>
    </ResponsiveContainer>
  )
})
