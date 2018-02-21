// eslint-disable-next-line import/no-dynamic-require
const conf = require(`${__dirname}/config/${
  process.env.NODE_ENV ? process.env.NODE_ENV : 'development'
}.js`);

module.exports = {
  get: key => conf[key],
};
