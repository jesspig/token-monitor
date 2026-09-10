import { decompress } from 'fzstd'


export const ZSTD_MAGIC = 0xfd2fb528
export const ZSTD_MAGIC_LENGTH = 4
export const ZSTD_MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

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
