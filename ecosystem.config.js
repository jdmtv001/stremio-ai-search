const path = require("path");

module.exports = {
  apps: [
    {
      name: "stremio-ai-addon",
      script: "./server.js",
      cwd: ".",
      env: {
        NODE_ENV: "production",
        PORT: 7000,
      },
      max_memory_restart: "999M", // Restart if memory exceeds 300MB
      instances: 1, // Changed to 1 instance to avoid port conflicts
      exec_mode: "fork", // Changed to fork mode
      log_date_format: "YYYY-MM-DD HH:mm:ss [Australia/Melbourne]",
      error_file: "./logs/error.log",
      out_file: "./logs/out.log",
      merge_logs: true,
      autorestart: true, // Auto restart if app crashes
      restart_delay: 4000, // Delay between automatic restarts
      max_restarts: 10, // Number of times to restart before stopping
      exp_backoff_restart_delay: 100, // Delay between restarts
      min_uptime: "30s",
      listen_timeout: 8000,
      kill_timeout: 5000,
    },
  ],
};