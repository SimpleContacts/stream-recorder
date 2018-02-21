module.exports = {
  apps: [
    {
      name: 'orchestration-server',
      script: './server.js --exec babel-node',
      watch: true,
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
