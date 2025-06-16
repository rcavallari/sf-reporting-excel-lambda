const { DynamoDBClient } = require('@aws-sdk/client-dynamodb')
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb')
const { logger } = require('../utils/logger')

const TABLE_NAME = process.env.JOBS_TABLE || 'excel-report-jobs'
const TTL_HOURS = parseInt(process.env.JOB_TTL_HOURS) || 24

class DynamoJobService {
  constructor() {
    const client = new DynamoDBClient({
      region: process.env.REGION || process.env.AWS_REGION || 'us-west-2'
    })
    this.dynamoDb = DynamoDBDocumentClient.from(client)
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
    const updateExpression = ['SET progress = :progress, updatedAt = :updatedAt']
    const expressionAttributeValues = {
      ':progress': Math.min(100, Math.max(0, progress)),
      ':updatedAt': new Date().toISOString()
    }

    if (stepName) {
      updateExpression.push('metadata.stepName = :stepName')
      expressionAttributeValues[':stepName'] = stepName
    }

    // Add any additional data to the update
    Object.entries(additionalData).forEach(([key, value], index) => {
      const attributeKey = `:data${index}`
      updateExpression.push(`${key} = ${attributeKey}`)
      expressionAttributeValues[attributeKey] = value
    })

    try {
      await this.dynamoDb.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { jobId },
        UpdateExpression: updateExpression.join(', '),
        ExpressionAttributeValues: expressionAttributeValues
      }))

      logger.info('Job progress updated', { jobId, progress, stepName })
    } catch (error) {
      logger.error('Failed to update job progress', { jobId, progress, error: error.message })
      throw error
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
      updateExpression.push(`${key} = ${attributeKey}`)
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
      await this.updateJobStatus(jobId, 'completed', completionData)
      logger.info('Job completed successfully', { jobId, filename: result.filename })
    } catch (error) {
      logger.error('Failed to complete job', { jobId, error: error.message })
      throw error
    }
  }

  async failJob(jobId, error, progress = null) {
    const failureData = {
      status: 'failed',
      error: {
        message: error.message,
        type: error.constructor.name,
        timestamp: new Date().toISOString()
      }
    }

    if (progress !== null) {
      failureData.progress = progress
    }

    try {
      await this.updateJobStatus(jobId, 'failed', failureData)
      logger.error('Job failed', { jobId, error: error.message })
    } catch (updateError) {
      logger.error('Failed to update job failure status', { jobId, error: updateError.message })
      throw updateError
    }
  }
}

module.exports = { DynamoJobService }