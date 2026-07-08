module.exports = {
  apps: [{
    name: "nanoclaw",
    script: "npm",
    args: "start",
    env: {
      // Guardrail hook mode: 'enforce' actually blocks matches; 'dryrun' logs
      // WOULD-BLOCK but allows through. Flipped 2026-07-08 after Option A +
      // bashCommandMatches fix (5-case verify passed). Rollback: change to
      // 'dryrun' and `pm2 restart nanoclaw --update-env`.
      GUARDRAIL_HOOK_MODE: "enforce"
    },
    wait_ready: false,
    kill_timeout: 15000,
    restart_delay: 5000,
    max_restarts: 10,
    min_uptime: 10000,
    exp_backoff_restart_delay: 1000,
    max_memory_restart: "1024M",
    autorestart: true
  }, {
    name: "watchdog",
    script: "src/watchdog-v2.cjs",
    autorestart: true,
    max_restarts: 5,
    min_uptime: 30000,
    restart_delay: 10000,
    watch: false
  }]
};
