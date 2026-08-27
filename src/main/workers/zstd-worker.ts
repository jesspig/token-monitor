import { parentPort } from 'node:worker_threads'
import { scanZstdFrames } from './zstd-scan'


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
