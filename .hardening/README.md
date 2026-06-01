# Manual apply notes

`mac_host_bridge/config.py` is root-owned (`-rw-r--r--  1 root  staff`),
so the agent could not write to it on the overnight pass.

To apply the prepared patch in the morning:

```bash
sudo patch -p1 < .hardening/mac_host_bridge-config.py.patch
```

Verify the diff with `git diff -- src/mac_host_bridge/config.py` before
committing the result.

Rationale: same as the watchdog change — repoint the dead
`logs/nanoclaw.log` reader at pm2's live per-process out-log so the
host-bridge `get_logs` and `nanoclaw_logs` commands return real data.
