import { use } from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type {
  BarSeriesOption,
  LineSeriesOption,
  PieSeriesOption
} from 'echarts/charts'
import type { ComposeOption } from 'echarts/core'
import type {
  DataZoomComponentOption,
  GridComponentOption,
  LegendComponentOption,
  TitleComponentOption,
  TooltipComponentOption
} from 'echarts/components'

export type ChartOption = ComposeOption<
  | BarSeriesOption
  | LineSeriesOption
  | PieSeriesOption
  | GridComponentOption
  | TooltipComponentOption
  | LegendComponentOption
  | DataZoomComponentOption
  | TitleComponentOption
>

export const CHART_PALETTE = [
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

export const TOOLTIP_STYLE = {
  backgroundColor: '#171717',
  borderColor: '#262626',
  borderWidth: 1,
  borderRadius: 8,
  textStyle: { color: '#d4d4d4', fontSize: 12 }
} as const

export const AXIS_LABEL_STYLE = { color: '#737373', fontSize: 11 } as const

export const AXIS_LINE_STYLE = { lineStyle: { color: '#262626' } } as const

export const AXIS_TICK_STYLE = { show: false } as const

export const SPLIT_LINE_STYLE = {
  lineStyle: { color: '#262626', type: 'dashed' }
} as const

export const LEGEND_STYLE = {
  top: 0,
  icon: 'roundRect',
  itemWidth: 14,
  itemHeight: 8,
  textStyle: { color: '#d4d4d4', fontSize: 11 }
} as const

export const GRID_STYLE = {
  left: 8,
  right: 8,
  top: 36,
  bottom: 0,
  containLabel: true
} as const

const X_AXIS_DEFAULTS = {
  axisTick: AXIS_TICK_STYLE,
  axisLine: AXIS_LINE_STYLE,
  axisLabel: AXIS_LABEL_STYLE
}

const Y_AXIS_DEFAULTS = {
  axisTick: AXIS_TICK_STYLE,
  axisLine: { show: false },
  splitLine: SPLIT_LINE_STYLE,
  axisLabel: AXIS_LABEL_STYLE
}

export function buildBaseOption(extra?: ChartOption): ChartOption {
  return {
    color: CHART_PALETTE,
    tooltip: TOOLTIP_STYLE,
    legend: LEGEND_STYLE,
    grid: GRID_STYLE,
    xAxis: X_AXIS_DEFAULTS,
    yAxis: Y_AXIS_DEFAULTS,
    ...extra
  }
}

let registered = false

export function registerECharts(): void {
  if (registered) return
  use([
    LineChart,
    BarChart,
    PieChart,
    GridComponent,
    TooltipComponent,
    LegendComponent,
    DataZoomComponent,
    TitleComponent,
    CanvasRenderer
  ])
  registered = true
}
