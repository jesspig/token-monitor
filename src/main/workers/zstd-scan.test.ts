import { describe, it, expect } from 'vitest'
import { MAX_CUT_ATTEMPTS, hasZstdMagicAt, scanZstdFrames } from './zstd-scan'

/**
 * 手工构造最小合法 zstd 帧（fzstd 0.1.1 只提供 decompress 无 compress）：
 * Magic(28 B5 2F FD) + Frame_Header_Description（Single_Segment，无校验/无字典）+
 * Frame_Content_Size + Raw Block 头（last=1 type=00，24-bit LE）+ 载荷。
 * FCS 按载荷大小选择：单字节（flag=00，<256）/ 双字节偏移 256（flag=01，<65280）。
 */
const ZSTD_FRAME_MAGIC = 0xfd2fb528

function makeZstdFrame(payload: Buffer): Buffer {
  if (payload.length >= 65_280) throw new Error('测试帧载荷长度超出双字节 FCS 编码范围')
  const wideFcs = payload.length >= 256
  const fcsBytes = wideFcs ? 2 : 1
  const blockHeaderOffset = 5 + fcsBytes
  const frame = Buffer.alloc(blockHeaderOffset + 3 + payload.length)
  frame.writeUInt32LE(ZSTD_FRAME_MAGIC, 0)
  frame[4] = wideFcs ? 0x60 : 0x20
  if (wideFcs) frame.writeUIntLE(payload.length - 256, 5, 2)
  else frame[5] = payload.length
  frame.writeUIntLE((payload.length << 3) | 1, blockHeaderOffset, 3)
  payload.copy(frame, blockHeaderOffset + 3)
  return frame
}

describe('scanZstdFrames', () => {
  it('拼接流快路径：整段一次解压全部完整帧，consumedEnd 为缓冲区总长', () => {
    const buf = Buffer.concat([makeZstdFrame(Buffer.from('a\n')), makeZstdFrame(Buffer.from('b\n'))])
    const res = scanZstdFrames(buf, 0)
    expect(res).toMatchObject({ ok: true, text: 'a\nb\n', consumedEnd: buf.length })
  })

  it('从指定偏移增量解压：仅消费 from 起的新增帧', () => {
    const chunkA = makeZstdFrame(Buffer.from('a\n'))
    const chunkB = makeZstdFrame(Buffer.from('b\n'))
    const res = scanZstdFrames(Buffer.concat([chunkA, chunkB]), chunkA.length)
    expect(res).toMatchObject({ ok: true, text: 'b\n' })
  })

  it('EOF 尾部半帧：consumedEnd 收敛到最后完整帧边界，半帧文本不产出', () => {
    const complete = makeZstdFrame(Buffer.from('a\n'))
    const half = makeZstdFrame(Buffer.from('b\n')).subarray(0, 6) // 截断的半帧
    const buf = Buffer.concat([complete, half])
    const res = scanZstdFrames(buf, 0)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.text).toBe('a\n')
      expect(res.consumedEnd).toBe(complete.length)
    }
  })

  it(`伪 magic 数量超过上限(${MAX_CUT_ATTEMPTS})时放弃：返回 ok:false 防止 O(n) 次 decompress`, () => {
    // magic 后紧跟非法帧头 → 每个切割点前缀解压必失败；数量超过 MAX_CUT_ATTEMPTS 即终止
    const junk = Buffer.concat(
      Array.from({ length: MAX_CUT_ATTEMPTS + 4 }, () => Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xff, 0xff]))
    )
    const res = scanZstdFrames(junk, 0)
    expect(res).toEqual({ ok: false })
  })

  it('无任何 magic 的纯垃圾：ok:false', () => {
    expect(scanZstdFrames(Buffer.from([1, 2, 3, 4, 5]), 0)).toEqual({ ok: false })
  })
})

describe('hasZstdMagicAt', () => {
  const buf = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from([9])])

  it('帧边界命中 / 非魔数偏移不命中 / 越界安全', () => {
    expect(hasZstdMagicAt(buf, 0)).toBe(true)
    expect(hasZstdMagicAt(buf, 2)).toBe(false)
    expect(hasZstdMagicAt(buf, buf.length - 2)).toBe(false)
    expect(hasZstdMagicAt(buf, -1)).toBe(false)
    expect(hasZstdMagicAt(buf, buf.length)).toBe(false)
  })
})
