import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WatcherServiceImpl } from './watcher'

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** 轮询等待条件成立，避免依赖固定延时造成 flaky */
async function waitFor(cond: () => boolean, timeoutMs = 3000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await sleep(stepMs)
  }
}

describe('WatcherServiceImpl', () => {
  let dir: string
  let disposers: Array<() => void>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tm-watcher-'))
    disposers = []
  })

  afterEach(() => {
    for (const dispose of disposers) dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('向临时目录写入文件触发 onChange', async () => {
    const service = new WatcherServiceImpl()
    let changed = 0
    disposers.push(service.registerWatcher(dir, () => { changed++ }))

    // 等待 chokidar 完成初始扫描与事件监听就绪
    await sleep(300)
    writeFileSync(join(dir, 'a.jsonl'), 'line1\n')

    await waitFor(() => changed >= 1)
    expect(changed).toBeGreaterThanOrEqual(1)
  })

  it('debounceMs 合并高频变更', async () => {
    const service = new WatcherServiceImpl()
    let changed = 0
    disposers.push(
      service.registerWatcher(dir, () => { changed++ }, { debounceMs: 200 })
    )

    await sleep(300)
    const file = join(dir, 'b.jsonl')
    writeFileSync(file, '1\n')
    writeFileSync(file, '2\n')
    writeFileSync(file, '3\n')
    // 等待 debounce 窗口完全结束
    await sleep(600)

    expect(changed).toBe(1)
  })

  it('dispose 后不再触发 onChange', async () => {
    const service = new WatcherServiceImpl()
    let changed = 0
    const dispose = service.registerWatcher(dir, () => { changed++ })
    disposers.push(dispose)

    await sleep(300)
    const file = join(dir, 'c.jsonl')
    writeFileSync(file, '1\n')
    await waitFor(() => changed >= 1)
    const afterFirst = changed

    dispose()
    await sleep(200) // 等待 watcher 关闭
    writeFileSync(file, '2\n')
    writeFileSync(file, '3\n')
    await sleep(300)

    expect(changed).toBe(afterFirst)
  })
})
