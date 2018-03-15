module.exports = {
  apps: [
    {
      name: 'orchestration-server',
      script: './server/app.js',
      interpreter: './node_modules/.bin/babel-node',
      watch: './server',
    },
    ...(process.env.NODE_ENV !== 'production'
      ? [
          {
            name: 'webpack',
            script: './node_modules/.bin/webpack-dev-server',
            args: `
              client/admin.js
              --mode development
              --port 8080
              --info false
              --public localhost:8088
              --output-filename admin.js
              `.replace('\n', ' '),
          },
        ]
      : []),
  ],
};
