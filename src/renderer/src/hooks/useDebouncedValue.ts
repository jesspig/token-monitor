import { useEffect, useState } from 'react'

/** 高频输入（如搜索框）驱动的重查询防抖：值安静 delayMs 后才对外发布 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}
