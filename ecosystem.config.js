const path = require('path');

module.exports = {
  apps: [
    {
      name: 'stremio-ai-addon',
      script: './api/server.js',
      cwd: '.',
      env: {
        NODE_ENV: 'production',
        PORT: 7000,
      },
      max_memory_restart: '999M',
      instances: 1,
      exec_mode: 'fork',
      log_date_format: 'YYYY-MM-DD HH:mm:ss [Australia/Melbourne]',
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      merge_logs: true,
      autorestart: true,
      restart_delay: 4000,
      max_restarts: 10,
      exp_backoff_restart_delay: 100,
      min_uptime: '30s',
      listen_timeout: 8000,
      kill_timeout: 5000,
    },
  ],
};