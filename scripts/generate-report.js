#!/usr/bin/env node

/**
 * Manual script entry point for Excel report generation
 * Allows running the service locally with hardcoded parameters
 */

const { createExcelReportService } = require('../src/excel-service')
require('dotenv').config()

// ========================================
// CONFIGURATION - EDIT THESE PARAMETERS
// ========================================

const PROJECTS = {
  'mlab_superdairy_usa_2': {
    idProject: 'mlab_superdairy_usa_2',
    options: {
      isFinal: true,
      hasPrices: undefined, // Will auto-detect
      hasFindability: true,
      isAoi: false,
      largeDataSet: false,
      priceThreshold: 0.5
    }
  },
  
  'niq_project_example': {
    idProject: 'niq_project_example',
    options: {
      isFinal: false, // Interim dataset
      hasPrices: true, // Force enable pricing
      hasFindability: false,
      isAoi: false,
      largeDataSet: true, // Use optimized mode
      largeDatasetThreshold: 500000
    }
  },

  'test_project': {
    idProject: 'test_project_123',
    options: {
      isFinal: true,
      hasPrices: false, // Force disable pricing
      hasFindability: true,
      isAoi: true,
      largeDataSet: false
    }
  }
}

// ========================================
// SELECT PROJECT TO RUN
// ========================================

const PROJECT_TO_RUN = 'mlab_superdairy_usa_2' // Change this to run different projects

// ========================================
// MAIN EXECUTION
// ========================================

async function main() {
  try {
    console.log('🚀 Excel Report Generator - Manual Script')
    console.log('=' .repeat(50))

    // Validate project selection
    if (!PROJECTS[PROJECT_TO_RUN]) {
      throw new Error(`Project "${PROJECT_TO_RUN}" not found. Available projects: ${Object.keys(PROJECTS).join(', ')}`)
    }

    const projectConfig = PROJECTS[PROJECT_TO_RUN]
    
    console.log(`📊 Running project: ${PROJECT_TO_RUN}`)
    console.log(`📋 Configuration:`)
    console.log(JSON.stringify(projectConfig, null, 2))
    console.log('')

    // Validate environment variables
    const requiredEnvVars = ['BUCKET']
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName])
    
    if (missingVars.length > 0) {
      throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`)
    }

    console.log(`🔧 Environment:`)
    console.log(`   AWS Region: ${process.env.AWS_REGION || process.env.REGION || 'Not set'}`)
    console.log(`   S3 Bucket: ${process.env.BUCKET}`)
    console.log(`   Images Bucket: ${process.env.IMAGES_BUCKET || 'Not set'}`)
    console.log('')

    // Create service and generate report
    const reportService = createExcelReportService(
      projectConfig.idProject, 
      projectConfig.options
    )

    console.log('⏳ Starting report generation...')
    const startTime = Date.now()
    
    const result = await reportService.generateReport()
    
    const totalTime = (Date.now() - startTime) / 1000

    console.log('')
    console.log('✅ Report generation completed!')
    console.log('=' .repeat(50))
    console.log(`📁 Filename: ${result.filename}`)
    console.log(`🔗 S3 Key: ${result.s3Key}`)
    console.log(`⬇️  Download URL: ${result.signedUrl}`)
    console.log(`⏱️  Total time: ${totalTime}s`)
    console.log(`📊 Statistics:`)
    console.log(`   Products: ${result.stats.products}`)
    console.log(`   Users: ${result.stats.users}`)
    console.log(`   Has Prices: ${result.stats.hasPrices}`)
    console.log(`   Dataset Mode: ${result.stats.datasetMode}`)
    console.log('')
    console.log('🎉 Success! Check the download URL above to access your report.')

  } catch (error) {
    console.error('')
    console.error('❌ Error generating report:')
    console.error(`   Message: ${error.message}`)
    
    if (process.env.NODE_ENV === 'development') {
      console.error(`   Stack: ${error.stack}`)
    }
    
    console.error('')
    console.error('💡 Troubleshooting tips:')
    console.error('   1. Check that all environment variables are set')
    console.error('   2. Verify AWS credentials and permissions')
    console.error('   3. Ensure the project data exists in S3')
    console.error('   4. Check S3 bucket permissions')
    
    process.exit(1)
  }
}

// CLI interface
const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
📊 Excel Report Generator - Manual Script

Usage:
  node scripts/generate-report.js [options]

Options:
  --help, -h     Show this help message
  --list, -l     List available projects

Available Projects:
${Object.keys(PROJECTS).map(key => `  - ${key}`).join('\n')}
`)
  process.exit(0)
}

if (args.includes('--list') || args.includes('-l')) {
  console.log('📋 Available Projects:')
  Object.entries(PROJECTS).forEach(([key, config]) => {
    console.log(`\n🔹 ${key}:`)
    console.log(`   ID: ${config.idProject}`)
    console.log(`   Final: ${config.options.isFinal}`)
    console.log(`   Has Prices: ${config.options.hasPrices ?? 'auto-detect'}`)
    console.log(`   Large Dataset: ${config.options.largeDataSet}`)
  })
  process.exit(0)
}

// Run the main function
if (require.main === module) {
  main()
}

module.exports = { main, PROJECTS }