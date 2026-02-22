module.exports = {
  apps: [{
    name: 'vinted-bot',
    script: 'main.js',
    restart_delay: 30000,  // wait 30s between restarts
    max_restarts: 5,       // max 5 restarts then stop
    min_uptime: 10000      // must run 10s to count as successful start
  }]
};
