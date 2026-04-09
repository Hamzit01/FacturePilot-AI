// PM2 Ecosystem — FacturePilot AI
// Usage: pm2 start pm2.config.js --env production
module.exports = {
  apps: [{
    name: 'facturepilot-ai',
    script: './server.js',
    instances: 1,              // SQLite requires single instance
    autorestart: true,
    watch: false,
    max_memory_restart: '400M',
    env: {
      NODE_ENV: 'development',
      PORT: 3333,
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3333,
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true,
  }],
};
