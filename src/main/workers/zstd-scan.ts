import { decompress } from 'fzstd'

/**
 * zstd 拼接流帧扫描解压（纯函数，主线程与 worker 共用）。
 * 从 dsh.ts 提取以便 worker 线程执行同一实现；fzstd 为纯 JS 依赖，
 * 禁止换用 napi 系 zstd 包以防 ABI 冲突（仓库约束）。
 */

/** zstd 帧魔数（小端 0xFD2FB528，字节序列 28 B5 2F FD） */
export const ZSTD_MAGIC = 0xfd2fb528
export const ZSTD_MAGIC_LENGTH = 4
export const ZSTD_MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 坏帧回退尝试上限：整体解压失败后从尾部向前逐 magic 找切割点重试前缀解压，
 * 最坏 O(n) 次 decompress 接近 O(n²) 字节工作量且全程占用执行线程；
 * 超过上限视为真损坏放弃本轮（调用方空结果、游标不推进，下轮重试）。
 */
export const MAX_CUT_ATTEMPTS = 8

export interface FrameScanSuccess {
  ok: true
  text: string
  consumedEnd: number
}

export interface FrameScanFailure {
  ok: false
}

export type FrameScan = FrameScanSuccess | FrameScanFailure

export function hasZstdMagicAt(buf: Buffer, offset: number): boolean {
  return offset >= 0 && offset + ZSTD_MAGIC_LENGTH <= buf.length && buf.readUInt32LE(offset) === ZSTD_MAGIC
}

/**
 * 从 from 起扫描解压 zstd 拼接流：快路径整段交给 fzstd decompress 内建多帧循环，
 * 其按各帧头声明的帧内容长度逐帧推进，天然免疫帧内容（压缩随机字节）中出现的伪
 * magic；仅整体解压失败时（典型为 EOF 处正在写入的半帧）才从尾部向前用 magic 找
 * 「安全切割点」cut 做前缀解压：cut 为真帧边界则 [from, cut) 全为完整帧必成功，
 * cut 为伪 magic 则真实帧被截断必失败自动跳过，无需显式区分真伪；cut 收敛到 from
 * （无消费进展）同样视为失败继续向前。全部候选耗尽或达到 MAX_CUT_ATTEMPTS 仍失败
 * → ok:false（真损坏），调用方维持现状：空结果、游标不推进。
 */
export function scanZstdFrames(buf: Buffer, from: number): FrameScan {
  const decoder = new TextDecoder('utf-8')
  try {
    return { ok: true, text: decoder.decode(decompress(buf.subarray(from))), consumedEnd: buf.length }
  } catch {}
  let cut = buf.length
  let attempts = 0
  while (cut > from && attempts < MAX_CUT_ATTEMPTS) {
    attempts++
    const candidate = buf.lastIndexOf(ZSTD_MAGIC_BYTES, cut - 1)
    if (candidate < from) return { ok: false }
    try {
      const text = decoder.decode(decompress(buf.subarray(from, candidate)))
      if (candidate > from) {
        return { ok: true, text, consumedEnd: candidate }
      }
    } catch {}
    cut = candidate
  }
  return { ok: false }
}
