/**
 * Opt-in compatibility for Warpgate connections.
 * Keep the workaround scoped: other SSH servers retain ssh2's reply handling.
 * The SFTP selector follows Warpgate's completed connection banner, never
 * a shell prompt, and reuses the existing authenticated connection.
 */
const installed = new WeakSet()

function installWarpgateCompatibility (client) {
  if (installed.has(client)) return
  installed.add(client)
  installAutoSftp(client)
  client.on('ready', () => {
    const protocol = client._protocol
    const requestForward = protocol.openssh_agentForward
    protocol.openssh_agentForward = function (remoteId, wantReply) {
      // ssh2 queues reqAgentFwd's continuation immediately before this call.
      // With wantReply=false there will be no CHANNEL_SUCCESS to consume it.
      const channel = Object.values(client._chanMgr._channels)
        .find(channel => channel && channel.outgoing?.id === remoteId)
      if (!wantReply || !channel || !channel._callbacks.length) {
        return requestForward.call(this, remoteId, wantReply)
      }
      const complete = channel._callbacks.pop()
      try {
        requestForward.call(this, remoteId, false)
      } catch (error) {
        channel._callbacks.push(complete)
        throw error
      }
      process.nextTick(complete, false)
    }
  })
}

function installAutoSftp (client) {
  const states = new WeakMap()
  const originalShell = client.shell
  const originalSftp = client.sftp
  const originalConnect = client.connect
  function applies (client) {
    return !/[:#]/.test(client.config.username || '')
  }
  function stateFor (client) {
    let state = states.get(client)
    if (!state) {
      state = { ready: false, pending: new Set() }
      states.set(client, state)
      client.once('close', () => {
        for (const finish of [...state.pending]) finish(new Error('SSH connection closed before SFTP initialization.'))
        states.delete(client)
      })
    }
    return state
  }
  client.connect = function (...args) {
    const state = states.get(this)
    if (state) {
      for (const finish of [...state.pending]) finish(new Error('SSH connection restarted.'))
      states.delete(this)
    }
    return originalConnect.apply(this, args)
  }
  client.shell = function (...args) {
    const index = args.length - 1
    if (!applies(this) || typeof args[index] !== 'function') return originalShell.apply(this, args)
    const callback = args[index]
    const state = stateFor(this)
    args[index] = (error, stream) => {
      if (!error) {
        let received = ''
        const { StringDecoder } = require('node:string_decoder')
        const decoder = new StringDecoder('utf8')
        const originalPush = stream.push
        const observe = chunk => {
          received = (received + (Buffer.isBuffer(chunk) ? decoder.write(chunk) : chunk)).slice(-32768)
          // Strip terminal control sequences, including OSC hyperlinks.
          /* eslint-disable no-control-regex */
          const plain = received
            .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
            .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
          /* eslint-enable no-control-regex */
          // Warpgate's completed connection banner, not its menu or progress line.
          if (/●\s+You\s+─+\s+●\s+Warpgate\s+─+\s+●\s+[^\r\n]+/.test(plain)) {
            state.ready = true
            stream.push = originalPush
            for (const finish of [...state.pending]) finish()
          }
        }
        // Observing data events would start flowing mode before electerm's
        // asynchronous shell initialization attaches its own reader.
        // Observe incoming buffers without consuming them or changing flow.
        stream.push = function (chunk, encoding) {
          if (chunk !== null) observe(chunk)
          return originalPush.call(this, chunk, encoding)
        }
      }
      callback(error, stream)
    }
    return originalShell.apply(this, args)
  }
  client.sftp = function (...args) {
    const callback = args[args.length - 1]
    if (!applies(this) || typeof callback !== 'function') return originalSftp.apply(this, args)
    const state = stateFor(this)
    if (state.ready) return originalSftp.apply(this, args)
    let finished = false
    const finish = error => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      state.pending.delete(finish)
      if (error) callback(error)
      else originalSftp.apply(this, args)
    }
    const timer = setTimeout(() => finish(new Error(
      'Select a node in the Warpgate SSH tab, then reconnect SFTP. ' +
      'If the connection banner has changed, use username:target.'
    )), 120000)
    timer.unref()
    state.pending.add(finish)
    return this
  }
}

module.exports = { installWarpgateCompatibility }
