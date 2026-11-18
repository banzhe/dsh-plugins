/** Local endpoint policy for a client whose host may be Windows: the private temporary directory and a loopback port. */
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The loopback address a per-stream forwarding binds; never a wildcard address. */
export const LOOPBACK_HOST = '127.0.0.1'

/**
 * Create the private directory holding one multiplexing master's control socket and stream sockets.
 * @returns the absolute directory path under the operating system's temporary directory.
 */
export function createTemporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-ssh-'))
}

/**
 * Reserve one unused loopback port for a stream forwarding.
 * The port is released before the SSH client binds it; `ExitOnForwardFailure=yes` turns a lost race into a startup error instead of a silent stream.
 * @returns the reserved port number.
 */
export async function reserveLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => { server.off('error', failed); reject(error) }
    server.once('error', failed)
    server.listen({ host: LOOPBACK_HOST, port: 0 }, () => { server.off('error', failed); resolve() })
  })
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('SSH forwarding port reservation did not return a TCP address')
    return address.port
  } finally {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
}
