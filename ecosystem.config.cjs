// PM2 ecosystem — AlohaScan Scanner V2 (.cjs: CommonJS explicit)
// Singurul process manager (SystemD eliminat — rula simultan cu PM2 → conflict port 3000).
// Pornire: pm2 start /root/scannerv2/ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [{
    name: 'alohascan',
    script: '/root/scannerv2/server.js',
    interpreter: '/snap/bin/node',   // runtime mandat (CLAUDE.md)
    cwd: '/root/scannerv2',
    instances: 1,
    max_memory_restart: '800M',
    env_file: '/root/scannerv2/.env',
    error_file: '/root/.pm2/logs/alohascan-error.log',
    out_file: '/root/.pm2/logs/alohascan-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    restart_delay: 3000,
    max_restarts: 10,
    watch: false,
    autorestart: true,
  }],
};
