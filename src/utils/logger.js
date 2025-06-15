/**
 * Logger utility for AWS Lambda
 */

const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
}

class Logger {
  constructor(options = {}) {
    this.level = LOG_LEVELS[options.level?.toUpperCase()] ?? LOG_LEVELS.INFO
    this.service = options.service || 'sf-reporting-excel-lambda'
    this.version = options.version || process.env.SERVICE_VERSION || '1.0.0'
  }

  _log(level, message, meta = {}) {
    if (LOG_LEVELS[level] > this.level) {
      return
    }

    const timestamp = new Date().toISOString()
    const logEntry = {
      timestamp,
      level,
      service: this.service,
      version: this.version,
      message,
      ...meta
    }

    console.log(JSON.stringify(logEntry))
  }

  error(message, meta = {}) {
    this._log('ERROR', message, meta)
  }

  warn(message, meta = {}) {
    this._log('WARN', message, meta)
  }

  info(message, meta = {}) {
    this._log('INFO', message, meta)
  }

  debug(message, meta = {}) {
    this._log('DEBUG', message, meta)
  }
}

const logger = new Logger({
  level: process.env.LOG_LEVEL || 'INFO',
  service: 'sf-reporting-excel-lambda'
})

module.exports = {
  Logger,
  logger
}
