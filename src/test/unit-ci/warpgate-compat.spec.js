const { test } = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const { Client, Server, utils } = require('@electerm/ssh2')
const { installWarpgateCompatibility } = require('../../app/server/warpgate-compat')

const hostKey = utils.generateKeyPairSync('ed25519').private

async function fixture (t, { enabled = true, username = 'tester' } = {}) {
  const peers = new Set()
  const state = { forwards: [], sftpRequests: 0, selected: username.includes(':') }
  const server = new Server({ hostKeys: [hostKey] }, peer => {
    peers.add(peer)
    peer.on('error', () => {})
    peer.on('authentication', context => context.accept())
    peer.on('ready', () => peer.on('session', accept => {
      const session = accept()
      session.on('pty', accept => accept && accept())
      session.on('auth-agent', accept => {
        state.forwards.push(typeof accept === 'function')
        // Warpgate does not acknowledge this request.
        if (!enabled && accept) accept()
      })
      session.on('shell', accept => {
        const channel = accept()
        channel.write('Welcome to Warpgate\r\nChoose a target\r\n')
        channel.once('data', () => {
          state.selected = true
          // Split UTF-8 characters and ANSI sequences across SSH packets.
          const banner = Buffer.from('\x1b[32m●\x1b[0m You ───── ● Warpgate ───── ● test-node\r\n')
          for (const byte of banner) channel.write(Buffer.from([byte]))
        })
      })
      session.on('sftp', accept => {
        state.sftpRequests++
        assert.equal(state.selected, true, 'SFTP must wait for target selection')
        const sftp = accept()
        sftp.on('REALPATH', id => sftp.name(id, [{
          filename: '/home/tester', longname: '/home/tester', attrs: {}
        }]))
      })
    }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const client = new Client()
  t.after(async () => {
    client.destroy()
    for (const peer of peers) peer.end()
    await new Promise(resolve => server.close(resolve))
  })
  if (enabled) {
    installWarpgateCompatibility(client)
    installWarpgateCompatibility(client) // repeated initialization is harmless
  }
  const ready = once(client, 'ready')
  client.connect({
    host: '127.0.0.1',
    port: server.address().port,
    username,
    // The test server accepts none authentication; no real agent is accessed.
    agent: 'unused-test-agent',
    agentForward: true,
    readyTimeout: 2000
  })
  await ready
  return { client, state }
}

const openSftp = client => new Promise((resolve, reject) => {
  client.sftp((error, sftp) => error ? reject(error) : resolve(sftp))
})
const openShell = client => new Promise((resolve, reject) => {
  client.shell((error, stream) => error ? reject(error) : resolve(stream))
})

test('early SFTP waits for selection without consuming the SSH menu', { timeout: 5000 }, async t => {
  const { client, state } = await fixture(t)
  const pendingSftp = openSftp(client)
  const shell = await openShell(client)
  // Simulate asynchronous terminal initialization after shell() resolves.
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(shell.readableFlowing, null)
  assert.equal(state.sftpRequests, 0)
  const menu = shell.read()?.toString()
  assert.match(menu, /Welcome to Warpgate/)
  shell.resume()
  shell.write('\r')
  const sftp = await pendingSftp
  const home = await new Promise((resolve, reject) => {
    sftp.realpath('.', (error, result) => error ? reject(error) : resolve(result))
  })
  assert.equal(home, '/home/tester')
  assert.deepEqual(state.forwards, [false])
  await openSftp(client) // additional file-transfer channels do not wait again
  assert.equal(state.sftpRequests, 2)
})

test('explicit target usernames do not require a shell', { timeout: 5000 }, async t => {
  const { client, state } = await fixture(t, { username: 'tester:test-node' })
  await openSftp(client)
  assert.equal(state.sftpRequests, 1)
})

test('ordinary SSH sessions retain agent request acknowledgements', { timeout: 5000 }, async t => {
  const { client, state } = await fixture(t, { enabled: false })
  await openShell(client)
  assert.deepEqual(state.forwards, [true])
})

test('closing the connection rejects queued SFTP callbacks once', { timeout: 5000 }, async t => {
  const { client } = await fixture(t)
  let callbacks = 0
  const pending = new Promise(resolve => client.sftp(error => {
    callbacks++
    assert.match(error.message, /closed/)
    resolve()
  }))
  client.destroy()
  await pending
  assert.equal(callbacks, 1)
})
