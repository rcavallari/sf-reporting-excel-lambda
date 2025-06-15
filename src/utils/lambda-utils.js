/**
 * Lambda utility functions for request/response handling
 */

function validateInput(input) {
  const errors = []

  if (!input || typeof input !== 'object') {
    errors.push('Request body is required and must be an object')
    return { isValid: false, errors }
  }

  if (!input.idProject) {
    errors.push('idProject is required')
  } else if (typeof input.idProject !== 'string') {
    errors.push('idProject must be a string')
  } else if (input.idProject.trim().length === 0) {
    errors.push('idProject cannot be empty')
  }

  if (input.options && typeof input.options !== 'object') {
    errors.push('options must be an object')
  } else if (input.options) {
    const validOptions = [
      'isFinal', 'hasPrices', 'hasFindability', 'isAoi', 
      'largeDataSet', 'largeDatasetThreshold', 'priceThreshold'
    ]
    
    for (const [key, value] of Object.entries(input.options)) {
      if (!validOptions.includes(key)) {
        errors.push(`Unknown option: ${key}`)
      }
      
      if (key === 'largeDatasetThreshold' && typeof value !== 'number') {
        errors.push('largeDatasetThreshold must be a number')
      }
      if (key === 'priceThreshold' && (typeof value !== 'number' || value < 0 || value > 1)) {
        errors.push('priceThreshold must be a number between 0 and 1')
      }
      if (['isFinal', 'hasPrices', 'hasFindability', 'isAoi', 'largeDataSet'].includes(key) && typeof value !== 'boolean') {
        errors.push(`${key} must be a boolean`)
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  }
}

function createResponse(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      ...headers
    },
    body: JSON.stringify(body, null, 2)
  }
}

function createErrorResponse(statusCode, message, details = {}) {
  return createResponse(statusCode, {
    success: false,
    error: {
      message,
      statusCode,
      ...details
    }
  })
}

module.exports = {
  validateInput,
  createResponse,
  createErrorResponse
}