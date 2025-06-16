const { DynamoDBClient } = require('@aws-sdk/client-dynamodb')
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb')
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
      idProject,
      status: 'pending',
      progress: 0,
      stepName: 'initializing', // Consistent with progress logs
      recordType: 'main_job',
      sequenceNumber: 0, // Main job is sequence 0
      timestamp: now.toISOString(), // Consistent with progress logs
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
      // Scan for the main job record by jobId and recordType
      const result = await this.dynamoDb.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'jobId = :jobId AND recordType = :recordType',
        ExpressionAttributeValues: {
          ':jobId': jobId,
          ':recordType': 'main_job'
        }
      }))

      logger.info('getJob scan result', { 
        jobId, 
        itemsFound: result.Items?.length || 0,
        scannedCount: result.ScannedCount,
        items: result.Items?.map(item => ({ recordId: item.recordId, recordType: item.recordType }))
      })

      if (!result.Items || result.Items.length === 0) {
        // Try a broader scan to see if any records exist for this jobId
        const broadResult = await this.dynamoDb.send(new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: 'jobId = :jobId',
          ExpressionAttributeValues: {
            ':jobId': jobId
          }
        }))
        
        logger.warn('Main job not found, but found other records', {
          jobId,
          allRecordsFound: broadResult.Items?.length || 0,
          recordTypes: broadResult.Items?.map(item => item.recordType)
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
      // Get the main job record first to update it
      const job = await this.getJob(jobId)
      if (job && job.recordId) {
        const updateExpression = ['SET progress = :progress, updatedAt = :updatedAt, #ts = :timestamp']
        const expressionAttributeNames = {
          '#ts': 'timestamp'
        }
        const expressionAttributeValues = {
          ':progress': Math.min(100, Math.max(0, progress)),
          ':updatedAt': now,
          ':timestamp': now
        }

        if (stepName) {
          updateExpression.push('metadata.stepName = :stepName, stepName = :stepNameTop')
          expressionAttributeValues[':stepName'] = stepName
          expressionAttributeValues[':stepNameTop'] = stepName
        }

        // Add any additional data to the main job record
        Object.entries(additionalData).forEach(([key, value], index) => {
          if (key !== 'timestamp' && key !== 'progress' && key !== 'stepName') {
            const attributeKey = `:extraData${index}`
            updateExpression.push(`${key} = ${attributeKey}`)
            expressionAttributeValues[attributeKey] = value
          }
        })

        await this.dynamoDb.send(new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { recordId: job.recordId }, // Use recordId as primary key
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

      // Create separate progress log entry with sequence number
      await this.createProgressLogEntry(jobId, progress, stepName, additionalData, now, sequenceNumber)
      
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
        sequenceNumber,
        timestamp,
        progress: Math.min(100, Math.max(0, progress)),
        stepName: stepName || 'unknown',
        recordType: 'progress_log',
        ttl,
        ...additionalData
      }
      
      // Remove undefined values to keep DynamoDB clean
      Object.keys(progressLogEntry).forEach(key => {
        if (progressLogEntry[key] === undefined) {
          delete progressLogEntry[key]
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

      const updateExpression = ['SET #status = :status, updatedAt = :updatedAt']
      const expressionAttributeNames = {
        '#status': 'status'
      }
      const expressionAttributeValues = {
        ':status': status,
        ':updatedAt': new Date().toISOString()
      }

      // Add completion timestamp for finished jobs
      if (status === 'completed' || status === 'failed') {
        updateExpression.push('completedAt = :completedAt')
        expressionAttributeValues[':completedAt'] = new Date().toISOString()
      }

      // Add any additional data to the update
      Object.entries(additionalData).forEach(([key, value], index) => {
        const attributeKey = `:data${index}`
        
        // Skip status since it's already handled above
        if (key === 'status') {
          return
        }
        
        // Handle reserved keywords and nested objects
        if (key === 'progress') {
          updateExpression.push(`progress = ${attributeKey}`)
        } else if (key === 'result') {
          updateExpression.push(`#result = ${attributeKey}`)
          expressionAttributeNames['#result'] = 'result'
        } else if (key === 'error') {
          updateExpression.push(`#error = ${attributeKey}`)
          expressionAttributeNames['#error'] = 'error'
        } else {
          updateExpression.push(`${key} = ${attributeKey}`)
        }
        
        expressionAttributeValues[attributeKey] = value
      })

      await this.dynamoDb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { recordId: job.recordId }, // Use recordId as primary key
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
    const processingSpeed = result.processingTime > 0 ? ((result.stats?.totalProducts || 0) / (result.processingTime / 1000)).toFixed(2) : '0.00'
    
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
          totalProducts: result.stats?.totalProducts || 0,
          totalImages: totalImages,
          imagesSuccessful: imageStats.successful,
          imagesFailed: imageStats.failed,
          processingTimeSeconds: Math.round(result.processingTime / 1000),
          completedAt: now
        }
      }
    }

    try {
      // Update main job record with comprehensive completion data
      await this.updateJobStatus(jobId, 'completed', {
        ...completionData,
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

      // Create final completion progress log with all essential info
      await this.createProgressLogEntry(jobId, 100, 'completed', {
        // Essential properties that should be in all records
        idProject: result.idProject,
        status: 'completed',
        success: true,
        
        // File information - 🔥 MOST IMPORTANT!
        filename: result.filename,
        s3Key: result.s3Key,
        downloadUrl: result.signedUrl, // 🔥 PRESIGNED URL
        
        // Processing metrics
        processingTime: result.processingTime,
        processingTimeFormatted: this.formatProcessingTime(result.processingTime),
        processingSpeed: `${processingSpeed} products/second`,
        
        // Statistics
        stats: result.stats,
        imageStats: completionData.result.imageStats,
        summary: completionData.result.summary,
        
        // Status
        message: `Report generation completed successfully in ${this.formatProcessingTime(result.processingTime)}`,
        
        // Failure details (if any)
        ...(imageStats.failed > 0 && {
          imageFailures: {
            count: imageStats.failed,
            failedProductIds: imageStats.failedIds,
            affectedPercentage: `${((imageStats.failed / totalImages) * 100).toFixed(1)}%`
          }
        })
      }, now, finalSequenceNumber)
      
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
      await this.createProgressLogEntry(jobId, progress || 0, 'failed', {
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
        // Add failure category for easier debugging
        failureCategory: this.categorizeError(error)
      }, now, failureSequenceNumber)
      
      logger.error('Job failed', { jobId, error: error.message })
      
      // Clean up sequence counter to prevent memory leaks
      this.sequenceCounters.delete(jobId)
    } catch (updateError) {
      logger.error('Failed to update job failure status', { jobId, error: updateError.message })
      throw updateError
    }
  }

  async getJobProgressLogs(jobId) {
    try {
      // Scan for progress logs for this job
      const result = await this.dynamoDb.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'jobId = :jobId AND recordType = :recordType',
        ExpressionAttributeValues: {
          ':jobId': jobId,
          ':recordType': 'progress_log'
        }
      }))
      
      // Sort by sequence number
      const progressLogs = (result.Items || []).sort((a, b) => {
        return (a.sequenceNumber || 0) - (b.sequenceNumber || 0)
      })
      
      logger.info('Retrieved progress logs', { jobId, count: progressLogs.length })
      return progressLogs
    } catch (error) {
      logger.error('Failed to get progress logs', { jobId, error: error.message })
      return []
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
      const result = await this.dynamoDb.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'jobId = :jobId',
        ExpressionAttributeValues: {
          ':jobId': jobId
        }
      }))
      
      // Sort by sequence number (main job = 0, progress logs = 1, 2, 3...)
      const allRecords = (result.Items || []).sort((a, b) => {
        return (a.sequenceNumber || 0) - (b.sequenceNumber || 0)
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