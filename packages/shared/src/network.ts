import * as net from 'node:net'

/**
 * Check if the machine is online by attempting a TCP connection
 * to a well-known host (Anthropic API).
 * Timeout: 500ms.
 */
export function isOnline(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket()
    const timeout = 500

    socket.setTimeout(timeout)

    socket.on('connect', () => {
      socket.destroy()
      resolve(true)
    })

    socket.on('timeout', () => {
      socket.destroy()
      resolve(false)
    })

    socket.on('error', () => {
      socket.destroy()
      resolve(false)
    })

    socket.connect(443, 'api.anthropic.com')
  })
}
