# Warpgate compatibility

Enable **Warpgate** in the SSH bookmark's authentication settings when connecting
through a Warpgate gateway. It is disabled by default and applies only to that
connection. SSH agent usage and forwarding still require their existing switches.

The mode sends the agent forwarding request without requesting an acknowledgement,
so gateways that do not acknowledge it cannot stall shell initialization.

For a plain username, select a target in the SSH menu. SFTP waits for Warpgate's
completed connection banner and then opens on the same authenticated connection.
The observer preserves terminal buffering, including when the terminal reader is
attached asynchronously, and handles fragmented UTF-8 and terminal escape codes.
An explicit `username:target` (or `username#target`) bypasses this wait.

Selection waits up to two minutes. Closing or restarting the SSH connection
cancels pending SFTP requests. If a Warpgate release changes its connection banner,
use an explicit target username. Running another `ssh` command inside the shell
does not redirect SFTP to that nested connection.

The forwarding adapter uses the pinned `@electerm/ssh2` channel callback queue.
Run the regression tests when updating that dependency:

```sh
node --test src/test/unit-ci/warpgate-compat.spec.js
```

These tests run against a local SSH server with generated host keys and fictitious
users. They do not read personal keys or contact external servers.
