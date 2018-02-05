module.exports = {
  apps: [
    {
      name: 'orchestration-server',
      script: './server.js',
      // watch: true,
      // instances: 'max',
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
