import { describe, expect, it } from 'vitest'
import {
  FRAME_HEADER_BYTES,
  FrameDecoder,
  MAX_FRAME_BYTES,
  RPC_PROTOCOL_VERSION,
  encodeFrame,
  parseFrame,
} from '../src/rpc/frames.ts'
import type { RpcFrame } from '../src/rpc/frames.ts'

/** Encode one frame and hand its bytes to a fresh decoder. */
function roundTrip(frame: RpcFrame): RpcFrame[] {
  const decoder = new FrameDecoder()
  return decoder.push(encodeFrame(frame))
}

describe('the frame codec', () => {
  it('pins the wire version to the DSH SSH helper protocol', () => {
    expect(RPC_PROTOCOL_VERSION).toBe(3)
    expect(FRAME_HEADER_BYTES).toBe(4)
  })

  it('writes a big-endian uint32 length header followed by UTF-8 JSON', () => {
    const bytes = encodeFrame({ type: 'request', id: 'a', method: 'ping', params: { x: 1 } })
    const length = bytes.readUInt32BE(0)
    expect(length).toBe(bytes.length - FRAME_HEADER_BYTES)
    expect(JSON.parse(bytes.subarray(FRAME_HEADER_BYTES).toString('utf8'))).toEqual({
      type: 'request', id: 'a', method: 'ping', params: { x: 1 },
    })
  })

  it('measures the header in bytes, not characters', () => {
    const bytes = encodeFrame({ type: 'result', id: 'a', value: '中文' })
    expect(bytes.readUInt32BE(0)).toBe(Buffer.byteLength('{"type":"result","id":"a","value":"中文"}', 'utf8'))
  })

  it('round-trips every frame type', () => {
    expect(roundTrip({ type: 'request', id: '1', method: 'fs.stat', params: {} }))
      .toEqual([{ type: 'request', id: '1', method: 'fs.stat', params: {} }])
    expect(roundTrip({ type: 'result', id: '2', value: null })).toEqual([{ type: 'result', id: '2', value: null }])
    expect(roundTrip({ type: 'error', id: '3', error: { name: 'FsError', message: 'no', code: 'FS_NOT_FOUND' } }))
      .toEqual([{ type: 'error', id: '3', error: { name: 'FsError', message: 'no', code: 'FS_NOT_FOUND' } }])
    expect(roundTrip({ type: 'cancel', id: '4' })).toEqual([{ type: 'cancel', id: '4' }])
  })

  it('reassembles a frame delivered one byte at a time', () => {
    const bytes = encodeFrame({ type: 'result', id: 'x', value: 'hello' })
    const decoder = new FrameDecoder()
    const frames: RpcFrame[] = []
    for (const byte of bytes) frames.push(...decoder.push(Buffer.from([byte])))
    expect(frames).toEqual([{ type: 'result', id: 'x', value: 'hello' }])
    expect(decoder.pending).toBe(false)
  })

  it('returns every frame one chunk carried', () => {
    const decoder = new FrameDecoder()
    const chunk = Buffer.concat([
      encodeFrame({ type: 'result', id: 'a', value: 1 }),
      encodeFrame({ type: 'result', id: 'b', value: 2 }),
    ])
    expect(decoder.push(chunk)).toEqual([
      { type: 'result', id: 'a', value: 1 },
      { type: 'result', id: 'b', value: 2 },
    ])
  })

  it('reports a frame that is still incomplete', () => {
    const bytes = encodeFrame({ type: 'result', id: 'a', value: 'text' })
    const decoder = new FrameDecoder()
    expect(decoder.push(bytes.subarray(0, 2))).toEqual([])
    expect(decoder.pending).toBe(true)
    expect(decoder.push(bytes.subarray(2, 7))).toEqual([])
    expect(decoder.pending).toBe(true)
    expect(decoder.push(bytes.subarray(7))).toHaveLength(1)
    expect(decoder.pending).toBe(false)
  })

  it('rejects an impossible frame length', () => {
    const header = Buffer.alloc(FRAME_HEADER_BYTES)
    header.writeUInt32BE(0, 0)
    expect(() => new FrameDecoder().push(header)).toThrow('invalid 0-byte RPC frame')
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
    expect(() => new FrameDecoder().push(header)).toThrow('invalid')
  })

  it('reads a header that is prose as text instead of a length', () => {
    const decoder = new FrameDecoder()
    // "exec" is 0x65786563 — an invalid frame length the reader would otherwise
    // report as 1702389091 bytes.
    expect(decoder.push(Buffer.from('exe', 'utf8'))).toEqual([])
    expect(decoder.proseHeader).toBe('exe')
    expect(() => decoder.push(Buffer.from('cutable file not found', 'utf8'))).toThrow('invalid')
    expect(decoder.proseHeader).toBe('exec')
  })

  it('does not read a real frame header as text', () => {
    const decoder = new FrameDecoder()
    const bytes = encodeFrame({ type: 'result', id: 'a', value: 'x'.repeat(64) })
    expect(decoder.push(bytes.subarray(0, 2))).toEqual([])
    expect(decoder.proseHeader).toBeUndefined()
    expect(decoder.push(bytes.subarray(2))).toHaveLength(1)
  })

  it('has no prose before any byte arrived', () => {
    expect(new FrameDecoder().proseHeader).toBeUndefined()
  })

  it('rejects a body that is not JSON', () => {
    const body = Buffer.from('not json', 'utf8')
    const header = Buffer.alloc(FRAME_HEADER_BYTES)
    header.writeUInt32BE(body.length, 0)
    expect(() => new FrameDecoder().push(Buffer.concat([header, body]))).toThrow('not JSON')
  })

  it('refuses to encode an oversized frame', () => {
    const value = 'x'.repeat(MAX_FRAME_BYTES + 1)
    expect(() => encodeFrame({ type: 'result', id: 'a', value })).toThrow('refusing to send')
  })
})

describe('frame validation', () => {
  it('rejects a document that is not an object', () => {
    expect(() => parseFrame('x')).toThrow('not an object')
    expect(() => parseFrame(['x'])).toThrow('not an object')
  })

  it('rejects a frame without an id', () => {
    expect(() => parseFrame({ type: 'result', value: 1 })).toThrow('no request id')
    expect(() => parseFrame({ type: 'result', id: '', value: 1 })).toThrow('no request id')
  })

  it('rejects a request without a method and an unknown frame type', () => {
    expect(() => parseFrame({ type: 'request', id: 'a' })).toThrow('no method')
    expect(() => parseFrame({ type: 'nonsense', id: 'a' })).toThrow('unknown RPC frame type')
  })

  it('rejects an error frame without a message and defaults its name', () => {
    expect(() => parseFrame({ type: 'error', id: 'a', error: {} })).toThrow('no message')
    expect(parseFrame({ type: 'error', id: 'a', error: { message: 'boom' } }))
      .toEqual({ type: 'error', id: 'a', error: { name: 'Error', message: 'boom' } })
  })
})
