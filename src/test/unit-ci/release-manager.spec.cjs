const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { validate, changelog, verifyAssets } = require('../../build/release/manage.cjs')

const env = {
  RELEASE_VERSION: '1.2.3',
  RELEASE_PLATFORMS: 'windows',
  RELEASE_MODE: 'draft',
  GITHUB_REPOSITORY: 'example/project'
}
test('release inputs reject invalid versions and platform selections', () => {
  assert.equal(validate(env).tag, 'v1.2.3')
  assert.deepEqual(validate({ ...env, RELEASE_PLATFORMS: 'all' }).platforms, ['windows', 'linux', 'macos'])
  for (const version of ['v1.2.3', '1.2', '1.2.3;echo bad', '../1.2.3', '01.2.3']) {
    assert.throws(() => validate({ ...env, RELEASE_VERSION: version }))
  }
  assert.throws(() => validate({ ...env, RELEASE_PLATFORMS: 'invalid' }))
  assert.throws(() => validate({ ...env, RELEASE_MODE: 'publish', RELEASE_VERSION: '1.2.3-beta.1' }))
})

test('notes group commit subjects and include escaped descriptions without author metadata', () => {
  const notes = changelog([
    { hash: 'a'.repeat(40), subject: 'fix: connection', body: 'Details <script> @everyone' },
    { hash: 'b'.repeat(40), subject: 'feat: releases', body: '' }
  ], 'example/project')
  assert.match(notes, /### Fixes/)
  assert.match(notes, /### New features/)
  assert.match(notes, /Commit details/)
  assert.match(notes, /&lt;script&gt; &#64;everyone/)
  assert.doesNotMatch(notes, /<script>|@everyone/)
})

test('release verification rejects partial, mismatched and corrupted builds', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-manager-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const plan = { platforms: ['windows'], version: '1.2.3', sha: 'a'.repeat(40) }
  const files = ['app.exe', 'app.zip'].map(name => {
    const bytes = Buffer.from(name)
    fs.writeFileSync(path.join(dir, name), bytes)
    return { name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
  })
  const manifest = { ...plan, platform: 'windows', arch: 'x64', files }
  const save = value => fs.writeFileSync(path.join(dir, 'build-windows.json'), JSON.stringify(value))
  save(manifest)
  assert.equal(verifyAssets(plan, dir).length, 2)
  save({ ...manifest, files: files.slice(0, 1) })
  assert.throws(() => verifyAssets(plan, dir), /Missing/)
  save({ ...manifest, sha: 'b'.repeat(40) })
  assert.throws(() => verifyAssets(plan, dir), /Mismatched/)
  save(manifest)
  fs.writeFileSync(path.join(dir, 'app.exe'), 'corrupt')
  assert.throws(() => verifyAssets(plan, dir), /Checksum mismatch/)
})

test('planning and package configuration use the selected commit without publishing', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-plan-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const testEnv = {
    ...process.env,
    ...env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    RELEASE_VERSION: '1.0.1',
    RELEASE_MODE: 'artifacts',
    RELEASE_PREVIOUS_TAG: '',
    RELEASE_NOTES: 'Release introduction',
    GITHUB_OUTPUT: path.join(dir, 'outputs'),
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary')
  }
  const git = args => execFileSync('git', args, { cwd: dir, env: testEnv, encoding: 'utf8' }).trim()
  const script = path.resolve(__dirname, '../../build/release/manage.cjs')
  const run = command => execFileSync(process.execPath, [script, command], { cwd: dir, env: testEnv, encoding: 'utf8' })
  git(['init', '-q'])
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.0' }))
  fs.mkdirSync(path.join(dir, 'src/build'), { recursive: true })
  fs.copyFileSync(path.resolve(__dirname, '../../build/electron-builder.json'), path.join(dir, 'src/build/electron-builder.json'))
  git(['add', '.'])
  git(['commit', '-qm', 'Initial version'])
  git(['tag', 'v1.0.0'])
  fs.writeFileSync(path.join(dir, 'change.txt'), 'test')
  git(['add', '.'])
  git(['commit', '-qm', 'fix: terminal buffering', '-m', 'Preserve the menu while waiting for SFTP.'])
  run('plan')
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'release-plan/plan.json')))
  assert.equal(plan.previous, 'v1.0.0')
  assert.equal(plan.sha, git(['rev-parse', 'HEAD']))
  const notes = fs.readFileSync(path.join(dir, 'release-plan/notes.md'), 'utf8')
  assert.match(notes, /fix: terminal buffering/)
  assert.match(notes, /Preserve the menu/)
  assert.doesNotMatch(notes, /Initial version|test@example/)
  run('configure')
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'))).version, '1.0.1')
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'electron-builder.json')))
  assert.equal(config.publish, null)
  assert.equal(config.mac.notarize, false)
  assert.equal(config.win.publish, undefined)
  fs.mkdirSync(path.join(dir, 'dist'))
  fs.writeFileSync(path.join(dir, 'dist/app.exe'), 'installer')
  fs.writeFileSync(path.join(dir, 'dist/app.zip'), 'archive')
  testEnv.RELEASE_PLATFORM = 'windows'
  run('collect')
  run('release')
  assert.equal(git(['tag']), 'v1.0.0', 'artifacts mode must not create a tag')
  testEnv.RELEASE_VERSION = '1.0.0'
  assert.throws(() => run('plan'), /already exists/)
})
