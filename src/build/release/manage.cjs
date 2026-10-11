const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const targets = {
  windows: { runner: 'windows-2022', flag: '--win', formats: ['nsis', 'zip'], extensions: ['.exe', '.zip'] },
  linux: { runner: 'ubuntu-24.04', flag: '--linux', formats: ['deb', 'tar.gz'], extensions: ['.deb', '.tar.gz'] },
  macos: { runner: 'macos-15-intel', flag: '--mac', formats: ['dmg', 'zip'], extensions: ['.dmg', '.zip'] }
}
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim()
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const readPlan = () => JSON.parse(fs.readFileSync('release-plan/plan.json', 'utf8'))
const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_[\]])/g, '\\$1').replace(/@/g, '&#64;')

function validate (env) {
  const version = env.RELEASE_VERSION || ''
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version)) {
    throw new Error('Use a version such as 5.5.80 or 5.5.80-beta.1 (without v).')
  }
  const choices = { all: Object.keys(targets), 'windows-linux': ['windows', 'linux'] }
  const platforms = choices[env.RELEASE_PLATFORMS] || (targets[env.RELEASE_PLATFORMS] && [env.RELEASE_PLATFORMS])
  if (!platforms) throw new Error('Unknown platform selection.')
  const mode = env.RELEASE_MODE
  if (!['draft', 'artifacts', 'prerelease', 'publish'].includes(mode)) throw new Error('Unknown release mode.')
  if (mode === 'publish' && version.includes('-')) throw new Error('Use prerelease mode for a prerelease version.')
  const repository = env.GITHUB_REPOSITORY
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '')) throw new Error('Invalid GITHUB_REPOSITORY.')
  return { version, tag: `v${version}`, platforms, mode, repository }
}

function changelog (commits, repository) {
  const groups = new Map()
  for (const commit of commits) {
    const subject = commit.subject
    const group = /^feat(?:\(|:|!)/i.test(subject)
      ? 'New features'
      : /^(fix(?:\(|:|!)|fix\b)/i.test(subject)
        ? 'Fixes'
        : /^docs(?:\(|:|!)/i.test(subject) ? 'Documentation' : 'Other changes'
    if (!groups.has(group)) groups.set(group, [])
    let entry = `- ${escape(subject)} ([${commit.hash.slice(0, 8)}](https://github.com/${repository}/commit/${commit.hash}))`
    if (commit.body.trim()) {
      entry += '\n\n  <details><summary>Commit details</summary>\n\n' +
        commit.body.trim().split('\n').map(line => `  ${escape(line)}`).join('\n') + '\n\n  </details>'
    }
    groups.get(group).push(entry)
  }
  return [...groups].map(([title, entries]) => `### ${title}\n\n${entries.join('\n\n')}`).join('\n\n') || 'No new commits in the selected range.'
}

function plan () {
  const result = validate(process.env)
  result.sha = git(['rev-parse', 'HEAD'])
  // Never move an existing tag or silently overwrite a previous release.
  try {
    git(['show-ref', '--verify', '--quiet', `refs/tags/${result.tag}`])
    throw new Error(`Tag ${result.tag} already exists. Choose a new version.`)
  } catch (error) {
    if (error.status !== 1) throw error
  }
  let previous = process.env.RELEASE_PREVIOUS_TAG || ''
  if (previous) {
    git(['check-ref-format', `refs/tags/${previous}`])
    git(['show-ref', '--verify', `refs/tags/${previous}`])
  } else {
    try { previous = git(['describe', '--tags', '--abbrev=0', 'HEAD']) } catch {}
  }
  if (previous) git(['merge-base', '--is-ancestor', `refs/tags/${previous}`, result.sha])
  result.previous = previous
  const range = previous ? `refs/tags/${previous}..${result.sha}` : result.sha
  const hashes = git(['rev-list', '--reverse', range]).split('\n').filter(Boolean)
  if (hashes.length > 300) throw new Error('More than 300 commits: select a more recent previous_tag to keep release notes reviewable.')
  const commits = hashes.map(hash => ({
    hash,
    subject: git(['show', '-s', '--format=%s', hash]),
    body: git(['show', '-s', '--format=%b', hash])
  }))
  const intro = process.env.RELEASE_NOTES || ''
  const body = `## Electerm ${result.version}\n\n${intro ? intro + '\n\n' : ''}` +
    `**Source:** [${result.sha.slice(0, 8)}](https://github.com/${result.repository}/commit/${result.sha})\n\n` +
    `**Platforms:** ${result.platforms.join(', ')} (x64).\n\n` +
    'Builds are unsigned; macOS builds are not notarized. SHA256 files are included with the downloads.\n\n' +
    changelog(commits, result.repository) +
    (previous ? `\n\n[Full comparison](https://github.com/${result.repository}/compare/${encodeURIComponent(previous)}...${result.tag})` : '') + '\n'
  fs.mkdirSync('release-plan', { recursive: true })
  fs.writeFileSync('release-plan/plan.json', JSON.stringify(result, null, 2))
  fs.writeFileSync('release-plan/notes.md', body)
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
    `matrix=${JSON.stringify({ include: result.platforms.map(platform => ({ platform, runner: targets[platform].runner })) })}\n`)
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## Release plan\n\nMode: **${result.mode}**\n\n${body}`)
  }
}

function configure () {
  const plan = readPlan()
  if (git(['rev-parse', 'HEAD']) !== plan.sha) throw new Error('Checkout does not match release plan.')
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  pkg.version = plan.version
  // Generated package metadata must point to this repository, not upstream.
  pkg.repository = { type: 'git', url: `https://github.com/${plan.repository}.git` }
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
  const config = JSON.parse(fs.readFileSync('src/build/electron-builder.json', 'utf8'))
  config.publish = null
  for (const name of ['win', 'mac', 'linux', 'snap']) delete config[name].publish
  config.mac.notarize = false
  config.mac.identity = null
  // Use the normal build config path expected by existing prepare scripts.
  fs.writeFileSync('electron-builder.json', JSON.stringify(config, null, 2))
}

function selectedTarget () {
  const platform = process.env.RELEASE_PLATFORM
  if (!readPlan().platforms.includes(platform) || !targets[platform]) throw new Error('Platform is not in the release plan.')
  return { platform, ...targets[platform] }
}

function build () {
  const target = selectedTarget()
  const { writeSrc, patchNsisKeepShortcuts } = require('../bin/build-common')
  const source = { windows: 'win-x64-installer.exe', linux: 'linux-amd64.deb', macos: 'mac-x64.dmg' }
  writeSrc(source[target.platform])
  if (target.platform === 'windows') patchNsisKeepShortcuts()
  const cli = require.resolve('electron-builder/cli.js')
  execFileSync(process.execPath, [cli, target.flag, ...target.formats, '--x64', '--publish', 'never'], { stdio: 'inherit' })
}

function collect () {
  const target = selectedTarget()
  const plan = readPlan()
  const names = fs.readdirSync('dist').filter(name =>
    fs.statSync(path.join('dist', name)).isFile() && target.extensions.some(ext => name.endsWith(ext)))
  for (const ext of target.extensions) {
    if (!names.some(name => name.endsWith(ext))) throw new Error(`Missing ${ext} installer for ${target.platform}`)
  }
  fs.mkdirSync('release-assets', { recursive: true })
  const files = names.map(name => {
    const bytes = fs.readFileSync(path.join('dist', name))
    fs.writeFileSync(path.join('release-assets', name), bytes)
    return { name, sha256: sha256(bytes), size: bytes.length }
  })
  fs.writeFileSync(`release-assets/SHA256SUMS-${target.platform}.txt`, files.map(f => `${f.sha256}  ${f.name}`).join('\n') + '\n')
  fs.writeFileSync(`release-assets/build-${target.platform}.json`, JSON.stringify({
    version: plan.version, sha: plan.sha, platform: target.platform, arch: 'x64', files
  }, null, 2))
}

function verifyAssets (plan, directory) {
  const files = []
  for (const platform of plan.platforms) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, `build-${platform}.json`), 'utf8'))
    if (manifest.sha !== plan.sha || manifest.version !== plan.version || manifest.platform !== platform || manifest.arch !== 'x64') {
      throw new Error(`Mismatched build for ${platform}`)
    }
    for (const file of manifest.files) {
      if (path.basename(file.name) !== file.name || /[\\/]/.test(file.name)) throw new Error('Invalid asset filename.')
      const bytes = fs.readFileSync(path.join(directory, file.name))
      if (sha256(bytes) !== file.sha256 || bytes.length !== file.size) throw new Error(`Checksum mismatch: ${file.name}`)
      files.push(file)
    }
    for (const ext of targets[platform].extensions) {
      if (!manifest.files.some(file => file.name.endsWith(ext))) throw new Error(`Missing ${platform} ${ext}`)
    }
  }
  return files
}

function release () {
  const plan = readPlan()
  const files = verifyAssets(plan, 'release-assets')
  const downloads = '\n## Downloads\n\n| File | Size |\n| --- | ---: |\n' + files.map(file =>
    `| [${file.name}](https://github.com/${plan.repository}/releases/download/${plan.tag}/${encodeURIComponent(file.name)}) | ${(file.size / 1048576).toFixed(1)} MB |`).join('\n')
  fs.appendFileSync('release-plan/notes.md', downloads + '\n')
  if (plan.mode === 'artifacts') {
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '## Builds verified\n\nDownload the platform artifacts from this workflow run. No tag or release was created.\n')
    return
  }
  const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  // Always create a draft first: a failed upload must never publish a partial release.
  const url = gh(['release', 'create', plan.tag, '--repo', plan.repository, '--target', plan.sha,
    '--title', `Electerm ${plan.version}`, '--notes-file', 'release-plan/notes.md', '--draft',
    ...(plan.mode === 'prerelease' || plan.version.includes('-') ? ['--prerelease'] : [])])
  const assets = fs.readdirSync('release-assets').map(name => path.join('release-assets', name))
  gh(['release', 'upload', plan.tag, '--repo', plan.repository, ...assets])
  if (plan.mode !== 'draft') {
    gh(['release', 'edit', plan.tag, '--repo', plan.repository, '--draft=false',
      '--latest=' + (plan.mode === 'publish' ? 'true' : 'false')])
  }
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Release ready\n\n[Open release](${url})\n\nMode: **${plan.mode}**\n`)
}

module.exports = { validate, changelog, verifyAssets }
if (require.main === module) {
  try {
    const command = { plan, configure, build, collect, release }[process.argv[2]]
    if (!command) throw new Error('Expected plan, configure, build, collect or release.')
    command()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
