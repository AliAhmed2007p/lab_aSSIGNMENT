'use strict';

const { AppError } = require('../store/db');

// Wraps async route handlers so rejected promises reach the error handler
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function notFound(req, res, next) {
  next(
    new AppError(
      404,
      'Route not found: ' + req.method + ' ' + req.originalUrl,
      'ROUTE_NOT_FOUND'
    )
  );
}

// Express recognises error handlers by their four arguments
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message },
    });
  }

  // Malformed JSON body
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: { code: 'BAD_JSON', message: 'Request body is not valid JSON.' },
    });
  }

  // Body larger than the configured limit
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({
      error: { code: 'BODY_TOO_LARGE', message: 'Request body is too large.' },
    });
  }

  console.error('[error]', err);
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on the server.' },
  });
}

module.exports = { asyncHandler, notFound, errorHandler };