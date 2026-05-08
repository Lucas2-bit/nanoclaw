module.exports = {
  apps: [{
    name: "nanoclaw",
    script: "dist/index.js",
    wait_ready: true,
    listen_timeout: 30000,
    kill_timeout: 15000,
    restart_delay: 5000,
    max_restarts: 10,
    min_uptime: 10000,
    exp_backoff_restart_delay: 1000,
    autorestart: true,
    env: {
      NODE_ENV: "production"
    }
  }]
};
