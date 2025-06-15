/**
 * Main entry point for the Excel Report Lambda function
 * Exports handlers for API Gateway integration
 */

const { handler, healthCheck } = require('./src/handlers/lambda-handler')

// Export handlers for Lambda runtime
module.exports = {
  handler,
  healthCheck
}