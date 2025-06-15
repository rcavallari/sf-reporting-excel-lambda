const { createExcelReportService } = require('../src/excel-service')
require('dotenv').config()

// Mock configuration from generate-report.js
const TEST_PROJECT_CONFIG = {
  idProject: 'test_project_123',
  options: {
    isFinal: true,
    hasPrices: false, // Force disable pricing to avoid external dependencies
    hasFindability: false, // Disable to avoid missing S3 files
    isAoi: true,
    largeDataSet: true // Use optimized mode for faster testing
  }
}

describe('Excel Report Service', () => {
  let reportService

  beforeAll(() => {
    // Ensure required environment variables are set for testing
    process.env.NODE_ENV = 'test'
    process.env.BUCKET = process.env.BUCKET || 'test-bucket'
    process.env.IMAGES_BUCKET = process.env.IMAGES_BUCKET || 'test-images-bucket'
    process.env.IMAGES_REGION = process.env.IMAGES_REGION || 'us-east-1'
    process.env.REGION = process.env.REGION || 'us-west-2'
  })

  beforeEach(() => {
    // Create a fresh service instance for each test
    reportService = createExcelReportService(
      TEST_PROJECT_CONFIG.idProject,
      TEST_PROJECT_CONFIG.options
    )
  })

  test('should create Excel report service with valid configuration', () => {
    expect(reportService).toBeDefined()
    expect(reportService.config).toBeDefined()
    expect(reportService.config.idProject).toBe(TEST_PROJECT_CONFIG.idProject)
  })

  test('should have correct project configuration', () => {
    expect(reportService.config.idProject).toBe('test_project_123')
    expect(reportService.config.isFinal).toBe(true)
    expect(reportService.config.hasPrices).toBe(false)
    expect(reportService.config.hasFindability).toBe(false)
    expect(reportService.config.isAoi).toBe(true)
    expect(reportService.config.largeDataSet).toBe(true)
  })

  test('should have required environment variables', () => {
    expect(process.env.BUCKET).toBeDefined()
    expect(process.env.IMAGES_BUCKET).toBeDefined()
    expect(process.env.IMAGES_REGION).toBeDefined()
    expect(process.env.REGION).toBeDefined()
  })

  test('should get correct S3 locations for project', () => {
    const locations = reportService.config.getS3Locations()
    
    expect(locations).toBeDefined()
    expect(locations.products).toBe('report/input/test_project_123/test_project_123-products.json')
    expect(locations.scv).toBe('report/input/test_project_123/test_project_123-scv.json')
    expect(locations.findability).toBe('report/input/test_project_123/test_project_123-find.json')
    expect(locations.heatmaps).toBe('report/input/test_project_123/test_project_123-heatmapsData.json')
  })

  test('should get partner from project ID', () => {
    const partner = reportService.config.getPartner()
    expect(partner).toBe('tes') // First 3 characters of 'test_project_123'
  })

  test('should generate date string in correct format', () => {
    const dateString = reportService.config.getDate()
    expect(dateString).toMatch(/^\d{2}\d{2}\d{4}-\d{2}\.\d{2}$/) // Format: MMDDYYYY-HH.mm
  })

  test('should handle price detection with empty products array', () => {
    const hasPrices = reportService.config.detectHasPrices([])
    expect(hasPrices).toBe(false)
  })

  test('should handle price detection with valid products', () => {
    const mockProducts = [
      { price: '10.99' },
      { price: '5.50' },
      { price: '0' },
      { price: null }
    ]
    
    const hasPrices = reportService.config.detectHasPrices(mockProducts)
    expect(typeof hasPrices).toBe('boolean')
  })

  test('should auto-configure pricing when not explicitly set', () => {
    const mockProducts = [
      { price: '10.99' },
      { price: '5.50' }
    ]
    
    // Reset pricing configuration
    reportService.config._hasPricesExplicit = false
    
    const result = reportService.config.autoConfigurePricing(mockProducts)
    expect(typeof result).toBe('boolean')
  })

  // Integration test (will be skipped in CI/CD without actual S3 data)
  test.skip('should generate report with valid S3 data', async () => {
    // This test requires actual S3 data and AWS credentials
    // Skip in automated testing, but can be run manually with:
    // npm test -- --testNamePattern="should generate report"
    
    const result = await reportService.generateReport()
    
    expect(result).toBeDefined()
    expect(result.success).toBe(true)
    expect(result.filename).toBeDefined()
    expect(result.s3Key).toBeDefined()
    expect(result.signedUrl).toBeDefined()
    expect(result.stats).toBeDefined()
  }, 30000) // 30 second timeout for long-running test
})

describe('Report Configuration Class', () => {
  test('should throw error when idProject is not provided', () => {
    expect(() => {
      createExcelReportService()
    }).toThrow('idProject is required')
  })

  test('should use default options when none provided', () => {
    const service = createExcelReportService('test_project')
    
    expect(service.config.largeDataSet).toBe(false)
    expect(service.config.isAoi).toBe(false)
    expect(service.config.isFinal).toBe(true)
    expect(service.config.hasFindability).toBe(true)
    expect(service.config.largeDatasetThreshold).toBe(1000000)
    expect(service.config.priceThreshold).toBe(0.5)
  })
})