const { DynamoDBClient } = require('@aws-sdk/client-dynamodb')
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb')
const { logger } = require('../utils/logger')

const TABLE_NAME = process.env.JOBS_TABLE || 'excel-report-jobs'
const TTL_HOURS = parseInt(process.env.JOB_TTL_HOURS) || 24

class DynamoJobService {
  constructor() {
    const client = new DynamoDBClient({
      region: process.env.REGION || process.env.AWS_REGION || 'us-west-2'
    })
    this.dynamoDb = DynamoDBDocumentClient.from(client)
    this.sequenceCounters = new Map() // Track sequence numbers per job
  }

  async createJob(jobId, idProject, options = {}) {
    const now = new Date()
    const ttl = Math.floor((now.getTime() + (TTL_HOURS * 60 * 60 * 1000)) / 1000)
    
    // Generate unique recordId for primary key (consistent format)
    const timestamp = now.toISOString().replace(/[:.]/g, '_')
    const randomSuffix = Math.random().toString(36).substring(2, 6)
    const recordId = `${jobId}_seq000_${timestamp}_${randomSuffix}`

    const jobRecord = {
      recordId, // Primary key - unique for each record
      jobId, // Regular attribute for filtering
      timestamp: now.toISOString(),
      stepName: 'initializing',
      progress: 0,
      status: 'pending',
      details: {
        idProject,
        recordType: 'main_job',
        sequenceNumber: 0,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        ttl,
        options,
        metadata: {
          totalSteps: 5, // estimation: validate, fetch data, process, generate excel, upload
          currentStep: 0,
          stepName: 'initializing'
        }
      }
    }

    try {
      await this.dynamoDb.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: jobRecord
      }))
      
      logger.info('Job created in DynamoDB', { jobId, idProject, recordId, recordType: 'main_job' })
      return jobRecord
    } catch (error) {
      logger.error('Failed to create job in DynamoDB', { jobId, error: error.message })
      throw error
    }
  }

  async getJob(jobId) {
    try {
      // Query for the main job record by jobId and recordType
      const result = await this.dynamoDb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'jobId = :jobId',
        FilterExpression: 'details.recordType = :recordType',
        ExpressionAttributeValues: {
          ':jobId': jobId,
          ':recordType': 'main_job'
        }
      }))

      logger.info('getJob query result', { 
        jobId, 
        itemsFound: result.Items?.length || 0,
        count: result.Count,
        items: result.Items?.map(item => ({ recordId: item.recordId, recordType: item.recordType }))
      })

      if (!result.Items || result.Items.length === 0) {
        // Try a broader query to see if any records exist for this jobId
        const broadResult = await this.dynamoDb.send(new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: 'jobId = :jobId',
          ExpressionAttributeValues: {
            ':jobId': jobId
          }
        }))
        
        logger.warn('Main job not found, but found other records', {
          jobId,
          allRecordsFound: broadResult.Items?.length || 0,
          recordTypes: broadResult.Items?.map(item => item.details?.recordType || 'unknown')
        })
        
        return null
      }

      return result.Items[0]
    } catch (error) {
      logger.error('Failed to get job from DynamoDB', { jobId, error: error.message })
      throw error
    }
  }

  async updateJobProgress(jobId, progress, stepName = null, additionalData = {}) {
    const now = new Date().toISOString()
    
    try {
      // Get the main job record first to update it (but don't set progress to 100 until completion)
      const job = await this.getJob(jobId)
      if (job && job.recordId) {
        const updateExpression = ['SET details.updatedAt = :updatedAt, #ts = :timestamp']
        const expressionAttributeNames = {
          '#ts': 'timestamp'
        }
        const expressionAttributeValues = {
          ':updatedAt': now,
          ':timestamp': now
        }

        // Only update progress if it's not 100 (completion progress is handled separately)
        if (progress < 100) {
          updateExpression.push('progress = :progress')
          expressionAttributeValues[':progress'] = Math.min(99, Math.max(0, progress))
        }

        if (stepName) {
          updateExpression.push('stepName = :stepName, details.metadata.stepName = :stepName')
          expressionAttributeValues[':stepName'] = stepName
        }

        // Add any additional data to the details object
        Object.entries(additionalData).forEach(([key, value], index) => {
          if (key !== 'timestamp' && key !== 'progress' && key !== 'stepName') {
            const attributeKey = `:extraData${index}`
            updateExpression.push(`details.${key} = ${attributeKey}`)
            expressionAttributeValues[attributeKey] = value
          }
        })

        await this.dynamoDb.send(new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { 
            jobId: jobId,
            recordId: job.recordId 
          },
          UpdateExpression: updateExpression.join(', '),
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues
        }))
      }

      // Get or initialize sequence number for this job
      if (!this.sequenceCounters.has(jobId)) {
        this.sequenceCounters.set(jobId, 1)
      } else {
        this.sequenceCounters.set(jobId, this.sequenceCounters.get(jobId) + 1)
      }
      const sequenceNumber = this.sequenceCounters.get(jobId)

      logger.info('Job progress updated', { jobId, progress, stepName, sequenceNumber, timestamp: now })

      // Create separate progress log entry with sequence number (but don't allow progress 100 here)
      const logProgress = progress >= 100 ? 99 : progress
      await this.createProgressLogEntry(jobId, logProgress, stepName, additionalData, now, sequenceNumber)
      
    } catch (error) {
      logger.error('Failed to update job progress', { jobId, progress, error: error.message })
      // Don't throw error - continue processing even if progress update fails
    }
  }

  async createProgressLogEntry(jobId, progress, stepName, additionalData = {}, timestamp, sequenceNumber = 1) {
    try {
      // Create unique primary key with sequence number, timestamp and random suffix (consistent format)
      const cleanTimestamp = timestamp.replace(/[:.]/g, '_')
      const paddedSequence = sequenceNumber.toString().padStart(3, '0') // e.g., 001, 002, 010
      const randomSuffix = Math.random().toString(36).substring(2, 4) // shorter suffix
      const progressLogId = `${jobId}_seq${paddedSequence}_${cleanTimestamp}_${randomSuffix}`
      const ttl = Math.floor((Date.now() + (TTL_HOURS * 60 * 60 * 1000)) / 1000)
      
      const progressLogEntry = {
        recordId: progressLogId, // Primary key - unique for each record
        jobId, // Regular attribute for filtering
        timestamp,
        stepName: stepName || 'unknown',
        progress: Math.min(99, Math.max(0, progress)), // Never allow 100 here - only in completion
        status: 'processing',
        details: {
          sequenceNumber,
          recordType: 'progress_log',
          ttl,
          ...additionalData
        }
      }
      
      // Remove undefined values to keep DynamoDB clean
      Object.keys(progressLogEntry.details).forEach(key => {
        if (progressLogEntry.details[key] === undefined) {
          delete progressLogEntry.details[key]
        }
      })

      await this.dynamoDb.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: progressLogEntry
      }))

      logger.info('Progress log entry created', { 
        recordId: progressLogId, 
        jobId, 
        progress, 
        stepName, 
        sequenceNumber,
        tableName: TABLE_NAME,
        recordType: 'progress_log'
      })
    } catch (error) {
      logger.error('Failed to create progress log entry', { jobId, progress, sequenceNumber, error: error.message })
      // Don't throw error - this is just logging
    }
  }

  async updateJobStatus(jobId, status, additionalData = {}) {
    try {
      // Get the main job record first
      const job = await this.getJob(jobId)
      if (!job || !job.recordId) {
        logger.error(`Job not found during status update: ${jobId}`, { 
          jobId, 
          status, 
          requestedOperation: 'updateJobStatus' 
        })
        throw new Error(`Job not found: ${jobId}`)
      }

      const updateExpression = ['SET #status = :status, details.updatedAt = :updatedAt']
      const expressionAttributeNames = {
        '#status': 'status'
      }
      const expressionAttributeValues = {
        ':status': status,
        ':updatedAt': new Date().toISOString()
      }

      // Add completion timestamp for finished jobs
      if (status === 'completed' || status === 'failed') {
        updateExpression.push('details.completedAt = :completedAt')
        expressionAttributeValues[':completedAt'] = new Date().toISOString()
      }

      // Add any additional data to the details object
      Object.entries(additionalData).forEach(([key, value], index) => {
        const attributeKey = `:data${index}`
        
        // Skip status since it's already handled above
        if (key === 'status') {
          return
        }
        
        // Handle core fields vs details fields
        if (key === 'progress') {
          updateExpression.push(`progress = ${attributeKey}`)
        } else if (key === 'timestamp') {
          updateExpression.push(`#ts = ${attributeKey}`)
          expressionAttributeNames['#ts'] = 'timestamp'
        } else if (key === 'stepName') {
          updateExpression.push(`stepName = ${attributeKey}`)
        } else if (key === 'result') {
          // Handle 'result' as reserved keyword
          updateExpression.push(`details.#result = ${attributeKey}`)
          expressionAttributeNames['#result'] = 'result'
        } else {
          // Everything else goes into details
          updateExpression.push(`details.${key} = ${attributeKey}`)
        }
        
        expressionAttributeValues[attributeKey] = value
      })

      await this.dynamoDb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { 
          jobId: jobId,
          recordId: job.recordId 
        },
        UpdateExpression: updateExpression.join(', '),
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues
      }))

      logger.info('Job status updated', { jobId, status, recordId: job.recordId })
    } catch (error) {
      logger.error('Failed to update job status', { jobId, status, error: error.message })
      throw error
    }
  }

  async completeJob(jobId, result) {
    const now = new Date().toISOString()
    
    // Ensure imageStats has default values
    const imageStats = result.imageStats || { successful: 0, failed: 0, failedIds: [] }
    
    // Calculate additional useful statistics
    const totalImages = imageStats.successful + imageStats.failed
    const imageSuccessRate = totalImages > 0 ? ((imageStats.successful / totalImages) * 100).toFixed(1) : '0.0'
    
    // Fix processingSpeed calculation - ensure we have valid numbers
    const totalProducts = result.stats?.totalProducts || 0
    const processingTimeSeconds = result.processingTime > 0 ? (result.processingTime / 1000) : 1 // Avoid division by zero
    const processingSpeed = totalProducts > 0 && processingTimeSeconds > 0 ? (totalProducts / processingTimeSeconds).toFixed(2) : '0.00'
    
    const completionData = {
      status: 'completed',
      progress: 100,
      result: {
        // File information
        filename: result.filename,
        s3Key: result.s3Key,
        downloadUrl: result.signedUrl, // 🔥 PRESIGNED URL - Most important!
        
        // Processing metrics
        processingTime: result.processingTime,
        processingTimeFormatted: this.formatProcessingTime(result.processingTime),
        processingSpeed: `${processingSpeed} products/second`,
        
        // Data statistics
        stats: result.stats,
        
        // Image statistics with detailed info
        imageStats: {
          total: totalImages,
          successful: imageStats.successful,
          failed: imageStats.failed,
          failedIds: imageStats.failedIds || [],
          successRate: `${imageSuccessRate}%`,
          hasFailures: imageStats.failed > 0
        },
        
        // Summary
        summary: {
          totalProducts: totalProducts,
          totalImages: totalImages,
          imagesSuccessful: imageStats.successful,
          imagesFailed: imageStats.failed,
          processingTimeSeconds: Math.round(result.processingTime / 1000),
          completedAt: now
        }
      }
    }

    try {
      // Update main job record with completion data (but keep progress at 99%)
      await this.updateJobStatus(jobId, 'completed', {
        result: completionData.result, // Store result data
        progress: 99, // Main job stays at 99% - only completion log gets 100%
        stepName: 'completed', // Keep stepName consistent
        timestamp: now, // Update timestamp
        idProject: result.idProject || 'unknown' // Ensure idProject is included
      })
      
      // Get final sequence number
      if (!this.sequenceCounters.has(jobId)) {
        this.sequenceCounters.set(jobId, 1)
      } else {
        this.sequenceCounters.set(jobId, this.sequenceCounters.get(jobId) + 1)
      }
      const finalSequenceNumber = this.sequenceCounters.get(jobId)

      // Create final completion progress log with all essential info (ONLY this one gets progress=100)
      await this.createCompletionLogEntry(jobId, result, completionData, now, finalSequenceNumber)
      
      logger.info('Job completed successfully', { 
        jobId, 
        filename: result.filename, 
        downloadUrl: result.signedUrl,
        processingTime: result.processingTime,
        totalProducts: result.stats?.totalProducts,
        imagesSuccessful: imageStats.successful,
        imagesFailed: imageStats.failed,
        sequenceNumber: finalSequenceNumber
      })
      
      // Clean up sequence counter to prevent memory leaks
      this.sequenceCounters.delete(jobId)
    } catch (error) {
      logger.error('Failed to complete job', { jobId, error: error.message })
      throw error
    }
  }

  async createCompletionLogEntry(jobId, result, completionData, timestamp, sequenceNumber) {
    try {
      // Create unique primary key for completion record
      const cleanTimestamp = timestamp.replace(/[:.]/g, '_')
      const paddedSequence = sequenceNumber.toString().padStart(3, '0')
      const randomSuffix = Math.random().toString(36).substring(2, 4)
      const completionLogId = `${jobId}_seq${paddedSequence}_${cleanTimestamp}_${randomSuffix}`
      const ttl = Math.floor((Date.now() + (TTL_HOURS * 60 * 60 * 1000)) / 1000)
      
      // Calculate final processing speed with proper values
      const totalProducts = result.stats?.totalProducts || 0
      const processingTimeSeconds = result.processingTime > 0 ? (result.processingTime / 1000) : 1
      const processingSpeed = totalProducts > 0 && processingTimeSeconds > 0 ? (totalProducts / processingTimeSeconds).toFixed(2) : '0.00'
      
      const completionLogEntry = {
        recordId: completionLogId,
        jobId,
        timestamp,
        stepName: 'completed',
        progress: 100, // ONLY completion record gets 100%
        status: 'completed',
        details: {
          sequenceNumber,
          recordType: 'completion_log',
          ttl,
          idProject: result.idProject,
          success: true,
          
          // File information - 🔥 MOST IMPORTANT!
          filename: result.filename,
          s3Key: result.s3Key,
          downloadUrl: result.signedUrl, // 🔥 PRESIGNED URL
          
          // Processing metrics with fixed calculation
          processingTime: result.processingTime,
          processingTimeFormatted: this.formatProcessingTime(result.processingTime),
          processingSpeed: `${processingSpeed} products/second`,
          
          // Statistics
          stats: result.stats,
          imageStats: completionData.result.imageStats,
          summary: completionData.result.summary,
          
          // Status message
          message: `Report generation completed successfully in ${this.formatProcessingTime(result.processingTime)}`,
          
          // Failure details (if any)
          ...(completionData.result.imageStats.failed > 0 && {
            imageFailures: {
              count: completionData.result.imageStats.failed,
              failedProductIds: completionData.result.imageStats.failedIds,
              affectedPercentage: `${((completionData.result.imageStats.failed / completionData.result.imageStats.total) * 100).toFixed(1)}%`
            }
          })
        }
      }

      await this.dynamoDb.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: completionLogEntry
      }))

      logger.info('Completion log entry created', { 
        recordId: completionLogId, 
        jobId, 
        progress: 100,
        stepName: 'completed',
        sequenceNumber,
        downloadUrl: result.signedUrl,
        processingSpeed: `${processingSpeed} products/second`
      })
    } catch (error) {
      logger.error('Failed to create completion log entry', { jobId, sequenceNumber, error: error.message })
      // Don't throw error - this is just logging
    }
  }

  formatProcessingTime(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000)
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = seconds % 60
    
    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`
    } else {
      return `${seconds}s`
    }
  }

  categorizeError(error) {
    if (error.Code === 'NoSuchKey' || error.name === 'NoSuchKey') {
      return 'S3_FILE_NOT_FOUND'
    }
    if (error.Code === 'AccessDenied' || error.message?.includes('Access Denied')) {
      return 'S3_ACCESS_DENIED'
    }
    if (error.name === 'ValidationException') {
      return 'DYNAMODB_VALIDATION_ERROR'
    }
    if (error.name === 'TimeoutError' || error.message?.includes('timeout')) {
      return 'TIMEOUT_ERROR'
    }
    if (error.name === 'SyntaxError' || error.message?.includes('JSON')) {
      return 'DATA_FORMAT_ERROR'
    }
    return 'UNKNOWN_ERROR'
  }

  async failJob(jobId, error, progress = null) {
    const now = new Date().toISOString()
    const failureData = {
      status: 'failed',
      error: {
        message: error.message,
        type: error.constructor.name,
        timestamp: now
      }
    }

    if (progress !== null) {
      failureData.progress = progress
    }

    try {
      // Update main job record with failure data
      try {
        await this.updateJobStatus(jobId, 'failed', failureData)
      } catch (updateError) {
        logger.error('Failed to update main job record during failure', { 
          jobId, 
          updateError: updateError.message 
        })
        // Continue to create progress log even if main job update fails
      }
      
      // Get final sequence number for failure
      if (!this.sequenceCounters.has(jobId)) {
        this.sequenceCounters.set(jobId, 1)
      } else {
        this.sequenceCounters.set(jobId, this.sequenceCounters.get(jobId) + 1)
      }
      const failureSequenceNumber = this.sequenceCounters.get(jobId)

      // Create final failure progress log with error details
      await this.createFailureLogEntry(jobId, error, progress || 0, now, failureSequenceNumber)
      
      logger.error('Job failed', { jobId, error: error.message })
      
      // Clean up sequence counter to prevent memory leaks
      this.sequenceCounters.delete(jobId)
    } catch (updateError) {
      logger.error('Failed to update job failure status', { jobId, error: updateError.message })
      throw updateError
    }
  }

  async createFailureLogEntry(jobId, error, progress, timestamp, sequenceNumber) {
    try {
      // Create unique primary key for failure record
      const cleanTimestamp = timestamp.replace(/[:.]/g, '_')
      const paddedSequence = sequenceNumber.toString().padStart(3, '0')
      const randomSuffix = Math.random().toString(36).substring(2, 4)
      const failureLogId = `${jobId}_seq${paddedSequence}_${cleanTimestamp}_${randomSuffix}`
      const ttl = Math.floor((Date.now() + (TTL_HOURS * 60 * 60 * 1000)) / 1000)
      
      const failureLogEntry = {
        recordId: failureLogId,
        jobId,
        timestamp,
        stepName: 'failed',
        progress: progress || 0,
        status: 'failed',
        details: {
          sequenceNumber,
          recordType: 'failure_log',
          ttl,
          success: false,
          error: {
            message: error.message,
            type: error.constructor.name,
            code: error.Code || error.name,
            stack: error.stack,
            // Add specific S3 error details if available
            ...(error.Code === 'NoSuchKey' && {
              s3Error: {
                missingKey: error.Key,
                bucket: error.Bucket,
                suggestion: 'Check if the input file exists in S3'
              }
            })
          },
          message: `Report generation failed: ${error.message}`,
          failureCategory: this.categorizeError(error)
        }
      }

      await this.dynamoDb.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: failureLogEntry
      }))

      logger.info('Failure log entry created', { 
        recordId: failureLogId, 
        jobId, 
        progress,
        stepName: 'failed',
        sequenceNumber,
        errorMessage: error.message
      })
    } catch (logError) {
      logger.error('Failed to create failure log entry', { jobId, sequenceNumber, error: logError.message })
      // Don't throw error - this is just logging
    }
  }

  async getJobProgressLogs(jobId) {
    try {
      // Query for progress logs for this job
      const result = await this.dynamoDb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'jobId = :jobId',
        FilterExpression: 'details.recordType = :progressType OR details.recordType = :completionType',
        ExpressionAttributeValues: {
          ':jobId': jobId,
          ':progressType': 'progress_log',
          ':completionType': 'completion_log'
        }
      }))
      
      // Sort by sequence number
      const progressLogs = (result.Items || []).sort((a, b) => {
        return (a.details?.sequenceNumber || 0) - (b.details?.sequenceNumber || 0)
      })
      
      logger.info('Retrieved progress logs', { jobId, count: progressLogs.length })
      return progressLogs
    } catch (error) {
      logger.error('Failed to get progress logs', { jobId, error: error.message })
      return []
    }
  }

  async getJobCompletionRecord(jobId) {
    try {
      // Get the completion record specifically (the one with progress=100 and downloadUrl)
      const result = await this.dynamoDb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'jobId = :jobId',
        FilterExpression: 'details.recordType = :completionType AND progress = :progress',
        ExpressionAttributeValues: {
          ':jobId': jobId,
          ':completionType': 'completion_log',
          ':progress': 100
        }
      }))
      
      const completionRecord = result.Items?.[0]
      logger.info('Retrieved completion record', { 
        jobId, 
        found: !!completionRecord,
        hasDownloadUrl: !!completionRecord?.details?.downloadUrl 
      })
      
      return completionRecord
    } catch (error) {
      logger.error('Failed to get completion record', { jobId, error: error.message })
      return null
    }
  }

  async getJobWithProgressLogs(jobId) {
    try {
      const job = await this.getJob(jobId)
      if (!job) return null

      const progressLogs = await this.getJobProgressLogs(jobId)
      
      return {
        ...job,
        progressLogs
      }
    } catch (error) {
      logger.error('Failed to get job with progress logs', { jobId, error: error.message })
      throw error
    }
  }

  async getAllJobRecords(jobId) {
    try {
      // Get all records for this job (main job + progress logs)
      const result = await this.dynamoDb.send(new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'jobId = :jobId',
        ExpressionAttributeValues: {
          ':jobId': jobId
        }
      }))
      
      // Sort by sequence number (main job = 0, progress logs = 1, 2, 3...)
      const allRecords = (result.Items || []).sort((a, b) => {
        return (a.details?.sequenceNumber || 0) - (b.details?.sequenceNumber || 0)
      })
      
      logger.info('Retrieved all job records', { jobId, count: allRecords.length })
      return allRecords
    } catch (error) {
      logger.error('Failed to get all job records', { jobId, error: error.message })
      return []
    }
  }
}

module.exports = { DynamoJobService }