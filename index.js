/**
 * Main entry point for the Excel Report Lambda function
 * Routes API Gateway requests to appropriate handlers
 */

const { handler, jobStatus, healthCheck } = require('./src/handlers/lambda-handler')

// Main handler that routes requests based on path
exports.handler = async (event, context) => {
  // Handle different routes based on the path
  const path = event.path || event.requestContext?.path || '/'
  const httpMethod = event.httpMethod || event.requestContext?.httpMethod || 'POST'

  // Health check endpoint
  if (path === '/health' && httpMethod === 'GET') {
    return healthCheck(event, context)
  }

  // Job status endpoint
  if (path.startsWith('/jobs/') && httpMethod === 'GET') {
    // Extract job ID from path
    const jobId = path.split('/jobs/')[1]
    event.pathParameters = { jobId }
    return jobStatus(event, context)
  }

  // Default report generation endpoint
  return handler(event, context)
}

// Export additional handlers for direct invocation
module.exports = {
  handler: exports.handler,
  jobStatus,
  healthCheck
}