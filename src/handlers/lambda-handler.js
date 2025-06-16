const { createExcelReportService } = require('../excel-service')
const { validateInput, createResponse, createErrorResponse, generateJobId } = require('../utils/lambda-utils')
const { DynamoJobService } = require('../services/dynamo-service')
const { logger } = require('../utils/logger')
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda')

/**
 * AWS Lambda handler for Excel report generation
 * Receives requests from API Gateway and processes them asynchronously
 */
exports.handler = async (event, context) => {
  const requestId = context.awsRequestId
  logger.info('Lambda invocation started', { requestId, event })

  try {
    // Check if this is an async processing request (Lambda self-invocation)
    if (event.action === 'processReport') {
      const { jobId, idProject, options } = event
      logger.info('Processing async report request', { requestId, jobId, idProject })
      await processReportAsync(jobId, idProject, options, requestId)
      return { statusCode: 200, body: 'Async processing completed' }
    }

    // Parse request body for API Gateway requests
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
    
    // Start async processing via Lambda self-invocation
    try {
      const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME
      const region = process.env.AWS_REGION || 'us-west-2'
      
      logger.info('Starting Lambda self-invocation', { 
        jobId, 
        functionName, 
        region,
        hasLambdaFunctionName: !!functionName 
      })
      
      if (!functionName) {
        throw new Error('AWS_LAMBDA_FUNCTION_NAME environment variable is not set')
      }
      
      const lambdaClient = new LambdaClient({ region })
      const payload = {
        action: 'processReport',
        jobId,
        idProject,
        options,
        requestId
      }
      
      const invokeParams = {
        FunctionName: functionName,
        InvocationType: 'Event', // Asynchronous invocation
        Payload: JSON.stringify(payload)
      }
      
      logger.info('Lambda invocation payload', { jobId, payload })
      
      const result = await lambdaClient.send(new InvokeCommand(invokeParams))
      logger.info('Async processing Lambda invoked successfully', { 
        jobId, 
        statusCode: result.StatusCode,
        payload: result.Payload 
      })
      
    } catch (error) {
      logger.error('Failed to invoke async processing Lambda', { jobId, error: error.message })
      // Mark job as failed since we couldn't start async processing
      try {
        await jobService.failJob(jobId, new Error(`Failed to start async processing: ${error.message}`))
      } catch (updateError) {
        logger.error('Failed to update job failure status', { jobId, updateError: updateError.message })
      }
      
      return createErrorResponse(500, 'Failed to start report generation', {
        jobId,
        error: error.message,
        requestId,
        timestamp: new Date().toISOString()
      })
    }

    // ALWAYS return job ID immediately - frontend polls DynamoDB for progress/results
    return createResponse(202, {
      success: true,
      message: 'Report generation started',
      data: {
        jobId,
        idProject,
        status: 'pending',
        progress: 0,
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
    
    // Initialize sequence counter and update job status to processing
    await jobService.updateJobProgress(jobId, 10, 'starting', { idProject })
    
    // Create progress callback for the report service
    const progressCallback = async (progress, stepName, additionalData = {}) => {
      await jobService.updateJobProgress(jobId, progress, stepName, {
        ...additionalData,
        idProject // Include idProject in all progress updates
      })
    }
    
    // Create service instance with progress callback
    const reportService = createExcelReportService(idProject, { ...options, progressCallback })
    
    // Generate report
    const startTime = Date.now()
    const result = await reportService.generateReport()
    const processingTime = Date.now() - startTime
    
    // Complete the job
    await jobService.completeJob(jobId, { ...result, processingTime, idProject })
    
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
    
    // Get progress logs for additional context
    const progressLogs = await jobService.getJobProgressLogs(jobId)
    
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
        result: job.result, // 🔥 Contains downloadUrl (presigned URL) and all statistics
        error: job.error,
        
        // Additional useful information
        progressHistory: progressLogs.map(log => ({
          sequenceNumber: log.sequenceNumber,
          progress: log.progress,
          stepName: log.stepName,
          timestamp: log.timestamp,
          ...(log.imagesProcessed && { imagesProcessed: log.imagesProcessed }),
          ...(log.totalImages && { totalImages: log.totalImages })
        })),
        
        // Quick access to key information
        ...(job.result && {
          downloadUrl: job.result.downloadUrl, // 🔥 Direct access to presigned URL
          processingTime: job.result.processingTimeFormatted,
          imageStats: job.result.imageStats,
          summary: job.result.summary
        })
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