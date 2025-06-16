const { createExcelReportService } = require('../excel-service')
const { validateInput, createResponse, createErrorResponse, generateJobId } = require('../utils/lambda-utils')
const { DynamoJobService } = require('../services/dynamo-service')
const { logger } = require('../utils/logger')

/**
 * AWS Lambda handler for Excel report generation
 * Receives requests from API Gateway and processes them asynchronously
 */
exports.handler = async (event, context) => {
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

    // Generate job ID and create job record
    const jobId = generateJobId()
    const jobService = new DynamoJobService()
    
    // Create job in DynamoDB
    await jobService.createJob(jobId, idProject, options)
    
    // Check if this is a synchronous test or we should process immediately
    const processSync = options.processSync || process.env.PROCESS_SYNC === 'true'
    
    if (processSync) {
      // Process synchronously for testing or immediate processing
      try {
        await processReportAsync(jobId, idProject, options, requestId)
      } catch (error) {
        logger.error('Sync processing failed', { jobId, requestId, error: error.message })
      }
    } else {
      // Start async processing with context handling
      context.callbackWaitsForEmptyEventLoop = false
      
      // Use process.nextTick to defer execution but keep it in same context
      process.nextTick(async () => {
        try {
          await processReportAsync(jobId, idProject, options, requestId)
        } catch (error) {
          logger.error('Async processing failed', { jobId, requestId, error: error.message, stack: error.stack })
        }
      })
    }

    // Return job ID immediately
    return createResponse(202, {
      success: true,
      message: 'Report generation started',
      data: {
        jobId,
        idProject,
        status: 'pending',
        estimatedCompletionTime: '2-5 minutes',
        statusCheckUrl: `/jobs/${jobId}`,
        createdAt: new Date().toISOString()
      },
      requestId
    })

  } catch (error) {
    logger.error('Error starting Excel report generation', {
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
    } else if (error.message.includes('Access Denied') || error.message.includes('Forbidden')) {
      statusCode = 403
      message = 'Access denied'
    }

    return createErrorResponse(statusCode, message, {
      requestId,
      timestamp: new Date().toISOString()
    })
  }
}

/**
 * Async processing function for Excel report generation
 */
async function processReportAsync(jobId, idProject, options, requestId) {
  const jobService = new DynamoJobService()
  
  try {
    logger.info('Starting async report processing', { jobId, idProject })
    
    // Update job status to processing
    await jobService.updateJobProgress(jobId, 10, 'starting')
    
    // Create progress callback for the report service
    const progressCallback = async (progress, stepName) => {
      await jobService.updateJobProgress(jobId, progress, stepName)
    }
    
    // Create service instance with progress callback
    const reportService = createExcelReportService(idProject, { ...options, progressCallback })
    
    // Generate report
    const startTime = Date.now()
    const result = await reportService.generateReport()
    const processingTime = Date.now() - startTime
    
    // Complete the job
    await jobService.completeJob(jobId, { ...result, processingTime })
    
    logger.info('Async report processing completed', {
      jobId,
      idProject,
      processingTime,
      filename: result.filename
    })
    
  } catch (error) {
    logger.error('Async report processing failed', {
      jobId,
      idProject,
      error: error.message,
      stack: error.stack
    })
    
    // Mark job as failed
    await jobService.failJob(jobId, error)
  }
}

/**
 * Job status handler for checking report generation progress
 */
exports.jobStatus = async (event, context) => {
  const requestId = context.awsRequestId
  
  try {
    const jobId = event.pathParameters?.jobId
    if (!jobId) {
      return createErrorResponse(400, 'Job ID is required')
    }
    
    const jobService = new DynamoJobService()
    const job = await jobService.getJob(jobId)
    
    if (!job) {
      return createErrorResponse(404, 'Job not found')
    }
    
    return createResponse(200, {
      success: true,
      data: {
        jobId: job.jobId,
        idProject: job.idProject,
        status: job.status,
        progress: job.progress,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        completedAt: job.completedAt,
        metadata: job.metadata,
        result: job.result,
        error: job.error
      }
    })
    
  } catch (error) {
    logger.error('Error checking job status', {
      requestId,
      error: error.message
    })
    
    return createErrorResponse(500, 'Internal server error', {
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