module.exports = {
  apps: [{
    name: 'alohascan',
    script: '/root/scannerv2/server.js',
    interpreter: '/snap/bin/node',
    env_file: '/root/scannerv2/.env',
    watch: false,
    max_memory_restart: '400M',
    restart_delay: 5000,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/root/.pm2/logs/alohascan-error.log',
    out_file: '/root/.pm2/logs/alohascan-out.log'
  }]
};
