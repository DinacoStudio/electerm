// Also loaded into child Node processes so legacy shelljs build scripts cannot
// report success after a failed compiler or dependency installation.
require('shelljs').config.fatal = true

if (require.main === module) {
  const { execFileSync } = require('node:child_process')
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${JSON.stringify(__filename)}`
  }
  for (const step of ['clean', 'build', 'prepare']) {
    execFileSync(process.execPath, [`src/build/bin/${step}.js`], { env, stdio: 'inherit' })
  }
}
