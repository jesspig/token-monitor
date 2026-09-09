import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { init } from 'echarts/core'
import type { EChartsType } from 'echarts/core'
import { registerECharts, type ChartOption } from '../components/chart-theme'

const SET_OPTION_OPTS = { replaceMerge: 'series' } as const

export function useECharts(
  containerRef: RefObject<HTMLDivElement | null>,
  option: ChartOption
): RefObject<EChartsType | null> {
  const chartRef = useRef<EChartsType | null>(null)
  const optionRef = useRef(option)

  useEffect(() => {
    registerECharts()
    const container = containerRef.current
    if (!container) return

    const ensureChart = (): void => {
      if (chartRef.current) return
      if (container.clientWidth <= 0 || container.clientHeight <= 0) return
      try {
        const chart = init(container)
        chart.setOption(optionRef.current, SET_OPTION_OPTS)
        chartRef.current = chart
      } catch (error) {
        chartRef.current = null
        console.warn('[useECharts] init 失败，待容器具备尺寸后重试', error)
      }
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (!entry || entry.contentRect.width <= 0 || entry.contentRect.height <= 0) {
        return
      }
      ensureChart()
      const chart = chartRef.current
      if (!chart) return
      try {
        chart.resize()
      } catch (error) {
        console.warn('[useECharts] resize 失败', error)
      }
    })

    observer.observe(container)
    ensureChart()

    return () => {
      observer.disconnect()
      const chart = chartRef.current
      chartRef.current = null
      if (chart) {
        try {
          chart.dispose()
        } catch (error) {
          console.warn('[useECharts] dispose 失败', error)
        }
      }
    }
  }, [containerRef])

  useEffect(() => {
    optionRef.current = option
    const chart = chartRef.current
    if (!chart) return
    try {
      chart.setOption(option, SET_OPTION_OPTS)
    } catch (error) {
      console.warn('[useECharts] setOption 失败', error)
    }
  }, [option])

  return chartRef
}
