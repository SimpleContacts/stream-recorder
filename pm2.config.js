module.exports = {
  apps: [
    {
      name: 'orchestration-server',
      script: './server.js',
      interpreter: './node_modules/.bin/babel-node',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
