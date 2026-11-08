/**
 * Frame codec for the container filesystem RPC.
 *
 * The wire form is the one DSH's SSH helper uses
 * (\`packages/ssh/ssh/src/protocol.ts\`, \`SSH_PROTOCOL_VERSION = 3\`): a four-byte
 * big-endian unsigned length header followed by one UTF-8 JSON document. The
 * host client writes \`request\` and \`cancel\` frames; the container helper writes
 * \`result\` and \`error\` frames. Both directions carry the same four frame types.
 * @module @banzhe/dsh-devcontainer/rpc/frames
 */

/** Wire version, pinned to DSH's SSH helper protocol. */
export const RPC_PROTOCOL_VERSION = 3

/** Largest single frame either side accepts, header included. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024

/** Bytes of the big-endian length header that opens every frame. */
export const FRAME_HEADER_BYTES = 4

/** The structured failure a `error` frame carries. */
export interface RpcErrorDetail {
  /** The remote error's class name. */
  readonly name: string
  /** The remote error's message. */
  readonly message: string
  /** A filesystem failure code (`FS_*`) when the remote failure has one. */
  readonly code?: string
}

/** One request awaiting a response. */
export interface RpcRequestFrame {
  readonly type: 'request'
  readonly id: string
  readonly method: string
  readonly params: unknown
}

/** The successful answer to one request. */
export interface RpcResultFrame {
  readonly type: 'result'
  readonly id: string
  readonly value: unknown
}

/** The failed answer to one request. */
export interface RpcErrorFrame {
  readonly type: 'error'
  readonly id: string
  readonly error: RpcErrorDetail
}

/** Cancellation of one in-flight request; the peer stops the work and answers nothing. */
export interface RpcCancelFrame {
  readonly type: 'cancel'
  readonly id: string
}

/** One frame on the wire. */
export type RpcFrame = RpcRequestFrame | RpcResultFrame | RpcErrorFrame | RpcCancelFrame

/**
 * Encode one frame as a length header plus its JSON body.
 * @param frame - the frame to encode.
 * @returns the bytes to write to the pipe.
 * @throws Error when the encoded body is empty or larger than {@link MAX_FRAME_BYTES}.
 */
export function encodeFrame(frame: RpcFrame): Buffer {
  const body = Buffer.from(JSON.stringify(frame), 'utf8')
  if (body.length === 0 || body.length > MAX_FRAME_BYTES) {
    throw new Error(`devcontainer: refusing to send a ${body.length}-byte RPC frame`)
  }
  const bytes = Buffer.allocUnsafe(FRAME_HEADER_BYTES + body.length)
  bytes.writeUInt32BE(body.length, 0)
  body.copy(bytes, FRAME_HEADER_BYTES)
  return bytes
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate one decoded frame.
 * @param value - the parsed JSON document.
 * @returns the frame, typed.
 * @throws Error when the document is not one of the four frame shapes.
 */
export function parseFrame(value: unknown): RpcFrame {
  if (!isRecord(value)) throw new Error('devcontainer: RPC frame is not an object')
  const { type, id } = value
  if (typeof id !== 'string' || id.length === 0) throw new Error('devcontainer: RPC frame carries no request id')
  if (type === 'request') {
    if (typeof value.method !== 'string' || value.method.length === 0) {
      throw new Error('devcontainer: RPC request frame carries no method')
    }
    return { type, id, method: value.method, params: value.params }
  }
  if (type === 'result') return { type, id, value: value.value }
  if (type === 'cancel') return { type, id }
  if (type === 'error') {
    const error = value.error
    if (!isRecord(error) || typeof error.message !== 'string') {
      throw new Error('devcontainer: RPC error frame carries no message')
    }
    return {
      type,
      id,
      error: {
        name: typeof error.name === 'string' ? error.name : 'Error',
        message: error.message,
        ...typeof error.code === 'string' ? { code: error.code } : {},
      },
    }
  }
  throw new Error(`devcontainer: unknown RPC frame type "${String(type)}"`)
}

/**
 * Buffered decoder: pipe chunks arrive at arbitrary boundaries, frames do not.
 *
 * The header of a frame in progress is retained across chunks, and so is its
 * body, so a peer may split a frame anywhere.
 */
export class FrameDecoder {
  private header = Buffer.alloc(FRAME_HEADER_BYTES)
  private headerBytes = 0
  private payload: Buffer | undefined
  private payloadBytes = 0

  /**
   * Consume one chunk.
   * @param chunk - bytes read from the pipe.
   * @returns every frame the chunk completed, in arrival order.
   * @throws Error when a frame declares an impossible length or is not JSON.
   */
  push(chunk: Buffer): RpcFrame[] {
    const frames: RpcFrame[] = []
    let offset = 0
    while (offset < chunk.length) {
      if (this.payload === undefined) {
        const count = Math.min(FRAME_HEADER_BYTES - this.headerBytes, chunk.length - offset)
        chunk.copy(this.header, this.headerBytes, offset, offset + count)
        this.headerBytes += count
        offset += count
        if (this.headerBytes < FRAME_HEADER_BYTES) continue
        const size = this.header.readUInt32BE(0)
        if (size === 0 || size > MAX_FRAME_BYTES) {
          throw new Error(`devcontainer: peer announced an invalid ${size}-byte RPC frame`)
        }
        this.payload = Buffer.alloc(size)
        this.payloadBytes = 0
      }
      const count = Math.min(this.payload.length - this.payloadBytes, chunk.length - offset)
      chunk.copy(this.payload, this.payloadBytes, offset, offset + count)
      this.payloadBytes += count
      offset += count
      if (this.payloadBytes === this.payload.length) {
        const body = this.payload.toString('utf8')
        this.payload = undefined
        this.headerBytes = 0
        let decoded: unknown
        try {
          decoded = JSON.parse(body)
        } catch (error: unknown) {
          throw new Error('devcontainer: peer sent a frame that is not JSON', { cause: error })
        }
        frames.push(parseFrame(decoded))
      }
    }
    return frames
  }

  /**
   * Whether bytes of an unfinished frame are buffered.
   * @returns true when the peer stopped mid-frame.
   */
  get pending(): boolean {
    return this.headerBytes > 0 || this.payload !== undefined
  }

  /**
   * The buffered header bytes read as text, when they are printable ASCII.
   *
   * A runtime that cannot start the helper answers the pipe with its own exec
   * diagnostic instead of frames, and those first four bytes decode as a length
   * far above {@link MAX_FRAME_BYTES}. No accepted length can look like this:
   * every frame under the limit starts with a byte below `0x05`, and the rest of
   * the printable range begins at `0x20`.
   * @returns the printable prefix buffered so far, or undefined when the bytes are a frame header.
   */
  get proseHeader(): string | undefined {
    if (this.headerBytes === 0) return undefined
    const bytes = this.header.subarray(0, this.headerBytes)
    for (const byte of bytes) {
      const blank = byte === 0x09 || byte === 0x0a || byte === 0x0d
      if (!blank && (byte < 0x20 || byte > 0x7e)) return undefined
    }
    return bytes.toString('utf8')
  }
}
