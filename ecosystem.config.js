module.exports = {
  apps: [{
    name: 'discord-bot',
    script: 'bot.js',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_file: './logs/pm2-combined.log',
    time: true,
    restart_delay: 5000,
    max_restarts: 10,
    min_uptime: '10s',
    autorestart: true,
    kill_timeout: 5000,
    listen_timeout: 3000,
    cron_restart: '0 2 * * *' // Restart daily at 2 AM
  }]
};
