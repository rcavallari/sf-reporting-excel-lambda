const { createExcelReportService } = require('../excel-service')
const { validateInput, createResponse, createErrorResponse } = require('../utils/lambda-utils')
const { logger } = require('../utils/logger')

/**
 * AWS Lambda handler for Excel report generation
 * Receives requests from API Gateway
 */
exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false
  
  const requestId = context.awsRequestId
  logger.info('Lambda invocation started', { requestId, event })

  try {
    // Parse request body
    let body
    if (typeof event.body === 'string') {
      try {
        body = JSON.parse(event.body)
      } catch (parseError) {
        logger.error('Invalid JSON in request body', { requestId, error: parseError.message })
        return createErrorResponse(400, 'Invalid JSON in request body')
      }
    } else {
      body = event.body || event
    }

    // Validate input
    const validation = validateInput(body)
    if (!validation.isValid) {
      logger.error('Input validation failed', { requestId, errors: validation.errors })
      return createErrorResponse(400, 'Input validation failed', { errors: validation.errors })
    }

    const { idProject, options = {} } = body

    logger.info('Processing Excel report request', { 
      requestId, 
      idProject, 
      options,
      lambdaMemorySize: context.memoryLimitInMB,
      remainingTime: context.getRemainingTimeInMillis()
    })

    // Create service instance
    const reportService = createExcelReportService(idProject, options)
    
    // Generate report
    const startTime = Date.now()
    const result = await reportService.generateReport()
    const processingTime = Date.now() - startTime

    logger.info('Report generated successfully', {
      requestId,
      idProject,
      processingTime,
      filename: result.filename,
      stats: result.stats
    })

    // Return successful response
    return createResponse(200, {
      success: true,
      message: 'Excel report generated successfully',
      data: {
        idProject,
        filename: result.filename,
        s3Key: result.s3Key,
        downloadUrl: result.signedUrl,
        processingTime,
        generatedAt: new Date().toISOString(),
        stats: result.stats
      },
      requestId
    })

  } catch (error) {
    logger.error('Error generating Excel report', {
      requestId,
      error: error.message,
      stack: error.stack
    })

    // Determine error type and status code
    let statusCode = 500
    let message = 'Internal server error'

    if (error.message.includes('idProject is required')) {
      statusCode = 400
      message = 'Missing required parameter: idProject'
    } else if (error.message.includes('not found') || error.message.includes('NoSuchKey')) {
      statusCode = 404
      message = 'Project data not found'
    } else if (error.message.includes('Access Denied') || error.message.includes('Forbidden')) {
      statusCode = 403
      message = 'Access denied to project data'
    }

    return createErrorResponse(statusCode, message, {
      requestId,
      timestamp: new Date().toISOString()
    })
  }
}

/**
 * Health check handler for monitoring
 */
exports.healthCheck = async (event, context) => {
  return createResponse(200, {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.SERVICE_VERSION || '1.0.0',
    environment: process.env.NODE_ENV || 'production'
  })
}