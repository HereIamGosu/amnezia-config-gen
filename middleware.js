// middleware.js
const logger = (req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
};

const errorHandler = (err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Что-то пошло не так!');
};

module.exports = { logger, errorHandler };
