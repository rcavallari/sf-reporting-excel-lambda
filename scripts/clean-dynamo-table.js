#!/usr/bin/env node

const { DynamoDBClient, DeleteTableCommand, CreateTableCommand, DescribeTableCommand, ListTablesCommand } = require('@aws-sdk/client-dynamodb')

const TABLE_NAME = process.env.JOBS_TABLE || 'excel-report-jobs'
const REGION = process.env.REGION || process.env.AWS_REGION || 'us-west-2'

const client = new DynamoDBClient({ region: REGION })

async function cleanDynamoTable() {
  console.log('🧹 Starting DynamoDB table cleanup...')
  console.log(`📋 Table: ${TABLE_NAME}`)
  console.log(`🌍 Region: ${REGION}`)

  try {
    // Check if table exists
    const listResult = await client.send(new ListTablesCommand({}))
    const tableExists = listResult.TableNames?.includes(TABLE_NAME)
    
    if (!tableExists) {
      console.log(`⚠️  Table '${TABLE_NAME}' does not exist`)
    } else {
      console.log(`✅ Table '${TABLE_NAME}' found. Deleting...`)
      
      // Delete the table
      await client.send(new DeleteTableCommand({
        TableName: TABLE_NAME
      }))
      
      console.log(`🗑️  Table '${TABLE_NAME}' deletion initiated`)
      
      // Wait for table to be fully deleted
      console.log('⏳ Waiting for table deletion to complete...')
      let tableDeleted = false
      let attempts = 0
      const maxAttempts = 30 // 5 minutes max wait
      
      while (!tableDeleted && attempts < maxAttempts) {
        try {
          await client.send(new DescribeTableCommand({ TableName: TABLE_NAME }))
          console.log(`   Still deleting... (attempt ${attempts + 1}/${maxAttempts})`)
          await new Promise(resolve => setTimeout(resolve, 10000)) // Wait 10 seconds
          attempts++
        } catch (error) {
          if (error.name === 'ResourceNotFoundException') {
            tableDeleted = true
            console.log(`✅ Table '${TABLE_NAME}' successfully deleted`)
          } else {
            throw error
          }
        }
      }
      
      if (!tableDeleted) {
        console.log(`⚠️  Table deletion is taking longer than expected. Please check AWS console.`)
        return
      }
    }

    // Create a fresh table with the new optimized structure
    console.log(`🚀 Creating fresh table '${TABLE_NAME}' with optimized structure...`)
    
    const createParams = {
      TableName: TABLE_NAME,
      KeySchema: [
        {
          AttributeName: 'jobId',
          KeyType: 'HASH' // Partition key
        },
        {
          AttributeName: 'recordId',
          KeyType: 'RANGE' // Sort key
        }
      ],
      AttributeDefinitions: [
        {
          AttributeName: 'jobId',
          AttributeType: 'S'
        },
        {
          AttributeName: 'recordId',
          AttributeType: 'S'
        }
      ],
      BillingMode: 'PAY_PER_REQUEST', // On-demand pricing
      StreamSpecification: {
        StreamEnabled: false
      },
      TableClass: 'STANDARD'
    }

    await client.send(new CreateTableCommand(createParams))
    
    // Wait for table to be active
    console.log('⏳ Waiting for table to become active...')
    let tableActive = false
    attempts = 0
    const maxAttemptsActive = 30 // Reset counter for table activation
    
    while (!tableActive && attempts < maxAttemptsActive) {
      try {
        const describeResult = await client.send(new DescribeTableCommand({ TableName: TABLE_NAME }))
        if (describeResult.Table?.TableStatus === 'ACTIVE') {
          tableActive = true
          console.log(`✅ Table '${TABLE_NAME}' is now active and ready to use!`)
        } else {
          console.log(`   Table status: ${describeResult.Table?.TableStatus} (attempt ${attempts + 1}/${maxAttemptsActive})`)
          await new Promise(resolve => setTimeout(resolve, 5000)) // Wait 5 seconds
          attempts++
        }
      } catch (error) {
        console.error(`❌ Error checking table status:`, error.message)
        break
      }
    }
    
    if (!tableActive) {
      console.log(`⚠️  Table creation is taking longer than expected. Please check AWS console.`)
      return
    }

    console.log('🎉 DynamoDB table cleanup and recreation completed successfully!')
    console.log('')
    console.log('📊 New table structure:')
    console.log('   • Partition Key: jobId (string)')
    console.log('   • Sort Key: recordId (string)')
    console.log('   • Billing Mode: Pay per request')
    console.log('   • Optimized for Query operations by jobId')
    console.log('')
    console.log('✨ Ready for the new cleaner record structure!')

  } catch (error) {
    console.error('❌ Error during table cleanup:', error.message)
    if (error.name === 'ResourceNotFoundException') {
      console.log('💡 This usually means the table doesn\'t exist, which is fine for a fresh start.')
    }
    throw error
  }
}

// Run the cleanup
if (require.main === module) {
  cleanDynamoTable()
    .then(() => {
      console.log('✅ Script completed successfully')
      process.exit(0)
    })
    .catch((error) => {
      console.error('❌ Script failed:', error.message)
      process.exit(1)
    })
}

module.exports = { cleanDynamoTable }