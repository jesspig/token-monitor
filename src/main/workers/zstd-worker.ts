import { parentPort } from 'node:worker_threads'
import { scanZstdFrames } from './zstd-scan'

/**
 * zstd 帧扫描解压 worker 入口（构建产物 out/main/zstd-worker.js）。
 * dsh 插件把解压从主线程挪到此线程执行，避免大会话文件的同步解压
 * 冻结 Electron 主进程事件循环（表现为整窗未响应）。
 * 协议：请求 { id, buf, from } → 响应 { id, scan }，按 id 关联回响应。
 */

interface ScanRequest {
  id: number
  buf: Buffer
  from: number
}

if (!parentPort) {
  throw new Error('zstd-worker 必须经 worker_threads 作为入口运行')
}

parentPort.on('message', (req: ScanRequest) => {
  parentPort!.postMessage({ id: req.id, scan: scanZstdFrames(req.buf, req.from) })
})
