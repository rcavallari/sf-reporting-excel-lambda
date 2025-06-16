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

    const jobRecord = {
      jobId,
      idProject,
      status: 'pending',
      progress: 0,
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
      
      logger.info('Job created in DynamoDB', { jobId, idProject })
      return jobRecord
    } catch (error) {
      logger.error('Failed to create job in DynamoDB', { jobId, error: error.message })
      throw error
    }
  }

  async getJob(jobId) {
    try {
      const result = await this.dynamoDb.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { jobId }
      }))

      if (!result.Item) {
        return null
      }

      return result.Item
    } catch (error) {
      logger.error('Failed to get job from DynamoDB', { jobId, error: error.message })
      throw error
    }
  }

  async updateJobProgress(jobId, progress, stepName = null, additionalData = {}) {
    const now = new Date().toISOString()
    
    try {
      // Update main job record
      const updateExpression = ['SET progress = :progress, updatedAt = :updatedAt']
      const expressionAttributeValues = {
        ':progress': Math.min(100, Math.max(0, progress)),
        ':updatedAt': now
      }

      if (stepName) {
        updateExpression.push('metadata.stepName = :stepName')
        expressionAttributeValues[':stepName'] = stepName
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
        Key: { jobId },
        UpdateExpression: updateExpression.join(', '),
        ExpressionAttributeValues: expressionAttributeValues
      }))

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
      // Create unique primary key with sequence number, timestamp and random suffix
      const cleanTimestamp = timestamp.replace(/[:.]/g, '_')
      const paddedSequence = sequenceNumber.toString().padStart(3, '0') // e.g., 001, 002, 010
      const randomSuffix = Math.random().toString(36).substring(2, 4) // shorter suffix
      const progressLogId = `${jobId}_seq${paddedSequence}_${cleanTimestamp}_${randomSuffix}`
      const ttl = Math.floor((Date.now() + (TTL_HOURS * 60 * 60 * 1000)) / 1000)
      
      const progressLogEntry = {
        jobId: progressLogId, // Use progressLogId as the primary key
        originalJobId: jobId, // Keep reference to the original job
        sequenceNumber,
        timestamp,
        progress: Math.min(100, Math.max(0, progress)),
        stepName: stepName || 'unknown',
        recordType: 'progress_log',
        ttl,
        ...additionalData
      }

      await this.dynamoDb.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: progressLogEntry
      }))

      logger.info('Progress log entry created', { 
        progressLogId, 
        jobId, 
        progress, 
        stepName, 
        sequenceNumber,
        tableName: TABLE_NAME,
        recordType: 'progress_log',
        uniqueKey: progressLogId
      })
    } catch (error) {
      logger.error('Failed to create progress log entry', { originalJobId: jobId, progress, sequenceNumber, error: error.message })
      // Don't throw error - this is just logging
    }
  }

  async updateJobStatus(jobId, status, additionalData = {}) {
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

    try {
      await this.dynamoDb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { jobId },
        UpdateExpression: updateExpression.join(', '),
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues
      }))

      logger.info('Job status updated', { jobId, status })
    } catch (error) {
      logger.error('Failed to update job status', { jobId, status, error: error.message })
      throw error
    }
  }

  async completeJob(jobId, result) {
    const now = new Date().toISOString()
    const completionData = {
      status: 'completed',
      progress: 100,
      result: {
        filename: result.filename,
        s3Key: result.s3Key,
        downloadUrl: result.signedUrl,
        stats: result.stats,
        processingTime: result.processingTime
      }
    }

    try {
      // Update main job record with completion data
      await this.updateJobStatus(jobId, 'completed', completionData)
      
      // Get final sequence number
      if (!this.sequenceCounters.has(jobId)) {
        this.sequenceCounters.set(jobId, 1)
      } else {
        this.sequenceCounters.set(jobId, this.sequenceCounters.get(jobId) + 1)
      }
      const finalSequenceNumber = this.sequenceCounters.get(jobId)

      // Create final completion progress log with all essential info
      await this.createProgressLogEntry(jobId, 100, 'completed', {
        filename: result.filename,
        s3Key: result.s3Key,
        downloadUrl: result.signedUrl,
        processingTime: result.processingTime,
        stats: result.stats,
        imageStats: result.imageStats || { successful: 0, failed: 0, failedIds: [] },
        success: true,
        message: 'Report generation completed successfully'
      }, now, finalSequenceNumber)
      
      logger.info('Job completed successfully', { jobId, filename: result.filename, downloadUrl: result.signedUrl })
      
      // Clean up sequence counter to prevent memory leaks
      this.sequenceCounters.delete(jobId)
    } catch (error) {
      logger.error('Failed to complete job', { jobId, error: error.message })
      throw error
    }
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
      await this.updateJobStatus(jobId, 'failed', failureData)
      
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
          stack: error.stack
        },
        message: `Report generation failed: ${error.message}`
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
      // For now, return empty array since we need to set up GSI
      // The main job record will have the current progress
      logger.info('Progress logs query skipped - requires GSI setup', { jobId })
      return []
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
}

module.exports = { DynamoJobService }