const xl = require('excel4node')
const fs = require('fs')
const path = require('path')
const { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')
const axios = require('axios')

// Environment detection for temp directory
const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME
const TEMP_DIR = isLambda ? '/tmp' : __dirname

class ReportConfiguration {
  constructor(idProject, options = {}) {
    // Required parameter
    if (!idProject) {
      throw new Error('idProject is required')
    }
    this.idProject = idProject

    // Optional parameters with defaults
    this.largeDataSet = options.largeDataSet || false
    this.isAoi = options.isAoi || false
    this.isFinal = options.isFinal !== undefined ? options.isFinal : true
    this.hasFindability = options.hasFindability !== undefined ? options.hasFindability : true
    this.largeDatasetThreshold = options.largeDatasetThreshold || 1000000
    this.priceThreshold = options.priceThreshold || 0.5

    // hasPrices can be explicitly set, or will be auto-calculated later
    this._hasPricesExplicit = options.hasPrices !== undefined
    this._hasPricesValue = options.hasPrices

    // Static configurations
    this.commonHeads = ['Survey ID', 'SF ID', 'Cell ID']
    this.productsHeaders = [
      { head: 'Image', property: 'url' },
      { head: 'Cells', property: 'cells' },
      { head: 'Product ID', property: 'idProduct' },
      { head: 'Index', property: 'index_pd' },
      { head: 'Name', property: 'description' },
    ]
  }

  getPartner() {
    return this.idProject.slice(0, 3)
  }

  get hasPrices() {
    return this._hasPricesValue
  }

  set hasPrices(value) {
    this._hasPricesValue = value
    this._hasPricesExplicit = true
  }

  detectHasPrices(products) {
    if (!products || products.length === 0) {
      console.log('📊 Price detection: No products found, defaulting to false')
      return false
    }

    const totalProducts = products.length
    let productsWithValidPrices = 0
    let productsWithZeroPrices = 0
    let productsWithNullPrices = 0
    let priceSum = 0
    let maxPrice = 0
    let minPrice = Infinity

    for (const product of products) {
      const price = parseFloat(product.price)

      if (product.price === null || product.price === undefined) {
        productsWithNullPrices++
      } else if (isNaN(price)) {
        productsWithNullPrices++
      } else if (price === 0) {
        productsWithZeroPrices++
      } else if (price > 0) {
        productsWithValidPrices++
        priceSum += price
        maxPrice = Math.max(maxPrice, price)
        minPrice = Math.min(minPrice, price)
      }
    }

    const percentageWithValidPrices = productsWithValidPrices / totalProducts
    const hasPricing = percentageWithValidPrices >= this.priceThreshold

    console.log('📊 Price detection analysis:')
    console.log(`   Total products: ${totalProducts.toLocaleString()}`)
    console.log(`   Products with valid prices (>0): ${productsWithValidPrices.toLocaleString()} (${(percentageWithValidPrices * 100).toFixed(1)}%)`)
    console.log(`   Products with zero prices: ${productsWithZeroPrices.toLocaleString()}`)
    console.log(`   Products with null/invalid prices: ${productsWithNullPrices.toLocaleString()}`)
    console.log(`   Threshold: ${(this.priceThreshold * 100).toFixed(1)}%`)

    if (productsWithValidPrices > 0) {
      const avgPrice = priceSum / productsWithValidPrices
      console.log(`   Price range: $${minPrice.toFixed(2)} - $${maxPrice.toFixed(2)}`)
      console.log(`   Average price: $${avgPrice.toFixed(2)}`)
    }

    console.log(`   Decision: ${hasPricing ? '✅ Include pricing data' : '❌ Exclude pricing data'}`)

    return hasPricing
  }

  autoConfigurePricing(products) {
    if (this._hasPricesExplicit) {
      console.log(`💰 Pricing mode: Explicitly set to ${this._hasPricesValue}`)
      return this._hasPricesValue
    }

    console.log('💰 Pricing mode: Auto-detecting from product data...')
    const detected = this.detectHasPrices(products)
    this._hasPricesValue = detected
    return detected
  }

  getDate() {
    const date = new Date()
    const day = ('0' + date.getDate()).slice(-2)
    const month = ('0' + (date.getMonth() + 1)).slice(-2)
    const year = date.getFullYear()
    const hours = ('0' + date.getHours()).slice(-2)
    const minutes = ('0' + date.getMinutes()).slice(-2)
    return `${month}${day}${year}-${hours}.${minutes}`
  }

  getS3Locations() {
    return {
      products: `report/input/${this.idProject}/${this.idProject}-products.json`,
      scv: `report/input/${this.idProject}/${this.idProject}-scv.json`,
      findability: `report/input/${this.idProject}/${this.idProject}-find.json`,
      heatmaps: `report/input/${this.idProject}/${this.idProject}-heatmapsData.json`
    }
  }
}

class S3DataService {
  constructor() {
    this.s3Client = new S3Client({
      region: process.env.AWS_REGION || process.env.REGION,
      ...(process.env.ACCESS_KEY_ID && {
        credentials: {
          accessKeyId: process.env.ACCESS_KEY_ID,
          secretAccessKey: process.env.SECRET_ACCESS_KEY,
        }
      })
    })
  }

  async getJsonFromS3(key) {
    console.log(`Fetching S3 object: ${key}`)
    const params = {
      Bucket: process.env.BUCKET,
      Key: key
    }

    try {
      const command = new GetObjectCommand(params)
      const response = await this.s3Client.send(command)
      const bodyContents = await this.streamToString(response.Body)
      const data = JSON.parse(bodyContents)
      console.log(`Successfully parsed JSON data from ${key}`)
      return data
    } catch (error) {
      console.error(`Error fetching ${key} from S3:`, error)
      throw error
    }
  }

  streamToString(stream) {
    return new Promise((resolve, reject) => {
      const chunks = []
      stream.on('data', (chunk) => chunks.push(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    })
  }

  async uploadFileToS3(filePath, s3Key) {
    try {
      console.log(`Uploading file to S3: ${s3Key}`)
      const fileContent = fs.readFileSync(filePath)

      const params = {
        Bucket: process.env.BUCKET,
        Key: s3Key,
        Body: fileContent,
        ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      }

      const command = new PutObjectCommand(params)
      await this.s3Client.send(command)
      console.log(`File uploaded successfully to S3: ${s3Key}`)

      const getObjectParams = {
        Bucket: process.env.BUCKET,
        Key: s3Key
      }
      const getCommand = new GetObjectCommand(getObjectParams)
      const signedUrl = await getSignedUrl(this.s3Client, getCommand, { expiresIn: 604800 })

      fs.unlinkSync(filePath)
      console.log(`Local file deleted: ${filePath}`)

      return signedUrl
    } catch (error) {
      console.error(`Error uploading file to S3: ${error.message}`)
      throw error
    }
  }
}

class ImageProcessor {
  constructor() {
    this.tempDir = path.join(TEMP_DIR, 'temp_images')
    this.ensureTempDirectory()
  }

  ensureTempDirectory() {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true })
    }
  }

  async downloadImage(url, productId) {
    console.log(`Attempting to download image for product ${productId}...`)
    try {
      const response = await axios({
        method: 'get',
        url: url,
        responseType: 'stream',
        timeout: 10000
      })

      const localPath = path.join(this.tempDir, `${productId}-1_tn.jpg`)
      const writer = fs.createWriteStream(localPath)

      response.data.pipe(writer)

      return new Promise((resolve, reject) => {
        writer.on('finish', () => {
          console.log(`Successfully downloaded image for product ${productId}`)
          resolve(localPath)
        })
        writer.on('error', (err) => {
          console.error(`Error writing image for product ${productId}:`, err.message)
          reject(err)
        })
      })
    } catch (error) {
      console.error(`Error downloading image for product ${productId}:`, error.message)
      return null
    }
  }

  cleanupTempImages() {
    if (fs.existsSync(this.tempDir)) {
      const files = fs.readdirSync(this.tempDir)
      for (const file of files) {
        fs.unlinkSync(path.join(this.tempDir, file))
      }
    }
  }
}

class ColumnCalculator {
  static salesColumns(products, numberCommonHeads, hasPrices) {
    const partner = products[0].idProject.slice(0, 3)
    const numberOfProducts = products.length
    const baseColumns = ['Total Items Purchased', 'Total Basket Items']
    if (partner === 'niq') {
      baseColumns.push('Avg Basket Price', 'Avg Products Purchased')
    }
    const indexedColumnsNames = [
      'Purchased-Product Index:',
      'Quantity-Product Index:',
      'Sequence Index:',
      'Dwell Time Index:',
    ]

    if (hasPrices) {
      baseColumns.push('Total Spend')
      indexedColumnsNames.push('Price-Product Index:')
    }

    const sIniColumns = baseColumns.length
    const sStartIndexColumn = indexedColumnsNames.length

    const salesTotalColumns =
      numberCommonHeads + sIniColumns + numberOfProducts * sStartIndexColumn
    const firstIndexedColumn = numberCommonHeads + sIniColumns + 1
    return {
      tc: salesTotalColumns,
      fxc: firstIndexedColumn,
      bc: baseColumns,
      icn: indexedColumnsNames,
    }
  }

  static clicksColumns(products, numberCommonHeads) {
    const partner = products[0].idProject.slice(0, 3)
    const numberOfProducts = products.length
    const baseColumns = [
      'First Selection',
      'Time First Selection',
      'Total Products Selected',
    ]
    if (partner === 'niq') {
      baseColumns.push('Avg Interactions Per Product')
    }
    const indexedColumns = ['Selected-Product Index:', 'Dwell-Time Index:']
    const clicksTotalColumns =
      numberCommonHeads +
      baseColumns.length +
      numberOfProducts * indexedColumns.length
    return {
      tc: clicksTotalColumns,
      fxc: numberCommonHeads + baseColumns.length + 1,
      bc: baseColumns,
      icn: indexedColumns,
    }
  }

  static viewsColumns(numberOfProducts, numberCommonHeads) {
    const viewsTotalColumns = numberCommonHeads + numberOfProducts * 2
    return {
      tc: viewsTotalColumns,
      fxc: numberCommonHeads + 1,
      bc: [],
      icn: ['Viewed-Product Index:', 'Time-Viewed Index:'],
    }
  }

  static funnelColumns(numberOfProducts, numberCommonHeads) {
    const baseColumns = ['Total Conversion Rate']
    const indexedColumns = ['Conversion Funnel Index:']
    const totalColumns =
      numberCommonHeads +
      baseColumns.length +
      numberOfProducts * indexedColumns.length
    return {
      tc: totalColumns,
      fxc: numberCommonHeads + baseColumns.length + 1,
      bc: baseColumns,
      icn: indexedColumns,
    }
  }

  static nonPurchaseColumns(numberOfProducts, numberCommonHeads) {
    const baseColumns = ['Total Not Purchased']
    const indexedColumns = ['Product-Not-Purchased Index:', 'Sequence Index:']
    const totalColumns =
      numberCommonHeads +
      baseColumns.length +
      numberOfProducts * indexedColumns.length
    return {
      tc: totalColumns,
      fxc: numberCommonHeads + baseColumns.length + 1,
      bc: baseColumns,
      icn: indexedColumns,
    }
  }

  static getColumnIndex(currentProductIndex, columns, nIndexColumn) {
    return currentProductIndex * columns.icn.length + columns.fxc + nIndexColumn
  }
}

class WorksheetManager {
  constructor(config) {
    this.config = config
    this.workbook = this.createWorkbook()
    this.worksheets = this.createWorksheets()
    this.headsStyle = this.createHeadStyle()
  }

  createWorkbook() {
    return new xl.Workbook({
      defaultFont: {
        size: 10,
        name: 'Work Sans',
        color: '000000',
      },
      dateFormat: 'm/d/yy hh:mm:ss',
      workbookView: {
        firstSheet: 0,
      },
      author: 'Shopperfacts Inc. DP team',
    })
  }

  createWorksheets() {
    const worksheets = {
      products: this.workbook.addWorksheet('Products List'),
      sales: this.workbook.addWorksheet('Sales'),
      clicks: this.workbook.addWorksheet('Stopping Power (clicks)'),
      views: this.workbook.addWorksheet('View-ability'),
      timers: this.workbook.addWorksheet('Store Timers'),
      findability: this.workbook.addWorksheet('Findability')
    }

    if (this.config.idProject && this.config.idProject.startsWith('niq')) {
      worksheets.funnel = this.workbook.addWorksheet('Conversion Funnel')
      worksheets.nonPurchase = this.workbook.addWorksheet('Products Not Purchased')
    }

    return worksheets
  }

  createHeadStyle() {
    return this.workbook.createStyle({
      font: {
        name: 'Work Sans Medium',
        size: 12,
      },
    })
  }

  async writeFile(filename) {
    return new Promise((resolve, reject) => {
      this.workbook.write(filename, (err) => {
        if (err) {
          reject(err)
        } else {
          console.log(`Excel file written successfully: ${filename}`)
          resolve()
        }
      })
    })
  }
}

class ProductsPopulator {
  constructor(config, imageProcessor, worksheetManager) {
    this.config = config
    this.imageProcessor = imageProcessor
    this.worksheetManager = worksheetManager
  }

  async populate(products, worksheet) {
    console.log('Starting to populate products worksheet...')
    const namesArray = products.map((product) => product.description.length)
    const namesMaxLength = Math.max(...namesArray)
    worksheet.column(5).setWidth(namesMaxLength)

    const cellsArray = products.map((product) => {
      let cells = product.cells.split(',')
      cells = [...new Set(cells)]
      cells = cells.join(';')
      return cells.length
    })
    const cellsMaxLength = Math.max(...cellsArray)
    worksheet.column(2).setWidth(cellsMaxLength)

    worksheet.cell(2, 3, products.length + 1, 4).style({
      alignment: {
        horizontal: 'center',
      },
    })

    const headsStyle = this.worksheetManager.headsStyle || worksheet._workbook.createStyle({
      font: {
        name: 'Work Sans Medium',
        size: 12,
      },
    })

    worksheet.cell(1, 1, 1, this.config.productsHeaders.length).style(headsStyle)
    worksheet.cell(2, 2, products.length + 1, this.config.productsHeaders.length).style({
      alignment: {
        vertical: 'center',
      },
    })
    worksheet.cell(2, 1, products.length + 1, 1).style({
      fill: {
        type: 'none',
        bgColor: 'FFFFFF',
      },
    })

    const idProductsArray = products.map(
      (product) => product.idProduct.toString().length
    )
    console.log(`Processing ${products.length} products with images...`)

    for (let i = 0; i < this.config.productsHeaders.length; i++) {
      const column = i + 1
      worksheet.cell(1, column).string(this.config.productsHeaders[i].head)
      if (this.config.productsHeaders[i].property === 'idProduct') {
        idProductsArray.push(this.config.productsHeaders[i].head.length)
      }

      worksheet.column(1).setWidth(18.5)
      for (let j = 0; j < products.length; j++) {
        const row = j + 2
        const product = products[j]
        const property = this.config.productsHeaders[i].property
        if (column === 1) {
          worksheet.row(row).setHeight(112.5)

          const imageUrl = `https://${process.env.IMAGES_BUCKET}.s3.${process.env.IMAGES_REGION}.amazonaws.com/images/${this.config.idProject}/${product.idProduct}-1_tn.jpg`
          console.log(`Processing image for product ${product.idProduct} (${j+1}/${products.length})`)

          try {
            const localImagePath = await this.imageProcessor.downloadImage(imageUrl, product.idProduct)

            if (localImagePath) {
              console.log(`Adding image to worksheet for product ${product.idProduct}`)
              worksheet.addImage({
                path: localImagePath,
                type: 'picture',
                position: {
                  type: 'oneCellAnchor',
                  from: {
                    col: 1,
                    colOff: '3mm',
                    row,
                    rowOff: '3mm',
                  },
                },
              })
            } else {
              console.log(`No image available for product ${product.idProduct}`)
            }
          } catch (error) {
            console.error(`Error processing image for product ${product.idProduct}:`, error.message)
          }
        } else if (column === 2) {
          let val = product[property].split(',')
          val = [...new Set(val)]
          val = val.join(';')
          worksheet.cell(row, column).string(val.toString())
        } else {
          const val = product[property]
          worksheet.cell(row, column).string(val.toString())
        }
      }
    }
    const idProductsMaxLength = Math.max(...idProductsArray)
    worksheet.column(3).setWidth(idProductsMaxLength + 4)
    worksheet.row(1).filter()
  }
}

class WorksheetStyler {
  static assignIndexColumns(worksheet, columns, currentProductIndex, headsStyle) {
    const nIndexColumns = columns.icn.length
    const index = currentProductIndex + 1
    for (let j = 0; j < nIndexColumns; j++) {
      const currentColumn = ColumnCalculator.getColumnIndex(currentProductIndex, columns, j)
      const headText = columns.icn[j] + index
      worksheet.column(currentColumn).setWidth(headText.length + 5)
      worksheet.cell(1, currentColumn).string(headText).style(headsStyle)
    }
  }
}

class ScvHeadersGenerator {
  constructor(config, worksheetManager) {
    this.config = config
    this.worksheets = worksheetManager.worksheets
    this.headsStyle = worksheetManager.headsStyle
  }

  generate(products, numberOfUsers) {
    const chl = this.config.commonHeads.length
    const pl = products.length
    const headsStyle = this.headsStyle

    // Assign common heads to sheets
    for (let i = 0; i < chl; i++) {
      this.worksheets.sales
        .cell(1, i + 1)
        .string(this.config.commonHeads[i])
        .style(headsStyle)
      this.worksheets.clicks
        .cell(1, i + 1)
        .string(this.config.commonHeads[i])
        .style(headsStyle)
      this.worksheets.views
        .cell(1, i + 1)
        .string(this.config.commonHeads[i])
        .style(headsStyle)
    }

    // Assign sales base heads
    const sc = ColumnCalculator.salesColumns(products, chl, this.config.hasPrices)
    for (let i = 0; i < sc.bc.length; i++) {
      const startColumn = chl + 1
      const textLength = sc.bc[i].length
      this.worksheets.sales.column(startColumn + i).setWidth(textLength + 5)

      this.worksheets.sales
        .cell(1, startColumn + i)
        .string(sc.bc[i])
        .style(headsStyle)
    }

    if (!this.config.largeDataSet) {
      this.worksheets.sales
        .cell(2, sc.fxc, numberOfUsers + 1, sc.tc)
        .number(0)
        .style({
          alignment: {
            horizontal: 'center',
          },
        })
    }

    // Assign clicks base heads
    const cc = ColumnCalculator.clicksColumns(products, chl)
    for (let i = 0; i < cc.bc.length; i++) {
      const startColumn = chl + 1
      const textLength = cc.bc[i].length
      this.worksheets.clicks.column(startColumn + i).setWidth(textLength + 5)
      this.worksheets.clicks
        .cell(1, startColumn + i)
        .string(cc.bc[i])
        .style(headsStyle)
    }

    if (!this.config.largeDataSet) {
      this.worksheets.clicks
        .cell(2, cc.fxc, numberOfUsers + 1, cc.tc)
        .number(0)
        .style({
          alignment: {
            horizontal: 'center',
          },
        })
    }

    const vc = ColumnCalculator.viewsColumns(pl, chl)
    if (!this.config.largeDataSet) {
      this.worksheets.views
        .cell(2, vc.fxc, numberOfUsers + 1, vc.tc)
        .number(0)
        .style({
          alignment: {
            horizontal: 'center',
          },
        })
    }

    // Loop through products to assign heads
    for (let i = 0; i < pl; i++) {
      WorksheetStyler.assignIndexColumns(this.worksheets.sales, sc, i, headsStyle)
      WorksheetStyler.assignIndexColumns(this.worksheets.clicks, cc, i, headsStyle)
      WorksheetStyler.assignIndexColumns(this.worksheets.views, vc, i, headsStyle)
    }

    // Add filters to all sheets
    this.worksheets.sales.row(1).filter()
    this.worksheets.clicks.row(1).filter()
    this.worksheets.views.row(1).filter()
  }
}

class ExcelReportService {
  constructor(config) {
    if (!config || !(config instanceof ReportConfiguration)) {
      throw new Error('ExcelReportService requires a ReportConfiguration instance')
    }

    this.config = config
    this.s3Service = new S3DataService()
    this.imageProcessor = new ImageProcessor()
    this.worksheetManager = new WorksheetManager(this.config)
    this.productsPopulator = new ProductsPopulator(this.config, this.imageProcessor, this.worksheetManager)
    this.scvHeadersGenerator = new ScvHeadersGenerator(this.config, this.worksheetManager)
  }

  async generateReport() {
    const startTime = new Date().getTime()
    let retryAttempt = 0
    const maxRetries = 1

    while (retryAttempt <= maxRetries) {
      try {
        if (retryAttempt > 0) {
          console.log(`🔄 Retry attempt ${retryAttempt}: Switching to large dataset mode`)
          this.config.largeDataSet = true
        }

        console.log('🚀 Starting Excel report generation...')
        console.log(`📊 Project: ${this.config.idProject}`)
        console.log(`📈 Dataset mode: ${this.config.largeDataSet ? 'Large (optimized)' : 'Standard'}`)

        const locations = this.config.getS3Locations()

        // Fetch products data
        console.log('📦 Fetching products data from S3...')
        let products = await this.s3Service.getJsonFromS3(locations.products)
        console.log(`✅ Retrieved ${products.length} products`)

        // Auto-configure pricing
        this.config.autoConfigurePricing(products)

        // Fetch user data
        console.log('👥 Fetching user data from S3...')
        const users = await this.s3Service.getJsonFromS3(locations.scv)
        console.log(`✅ Retrieved data for ${users.length} users`)

        // Proactive large dataset detection
        if (!this.config.largeDataSet && this.shouldUseLargeDatasetMode(users, products)) {
          console.log(`⚠️ Switching to large dataset mode proactively to avoid Excel generation failure`)
          this.resetForRetry()
        }

        // Generate Excel file
        const filePath = await this.generateExcelFile(products, users)
        const filename = path.basename(filePath)

        // Upload to S3
        const s3Key = `report/output/${this.config.idProject}/${filename}`
        const signedUrl = await this.s3Service.uploadFileToS3(filePath, s3Key)

        const endTime = new Date().getTime()
        const duration = (endTime - startTime) / 1000

        console.log(`✅ Excel report generated successfully in ${duration}s`)

        // Cleanup
        this.imageProcessor.cleanupTempImages()

        return {
          success: true,
          filename,
          s3Key,
          signedUrl,
          duration,
          stats: {
            products: products.length,
            users: users.length,
            hasPrices: this.config.hasPrices,
            datasetMode: this.config.largeDataSet ? 'large' : 'standard'
          }
        }

      } catch (error) {
        console.error(`❌ Error generating report (attempt ${retryAttempt + 1}):`, error.message)

        if (retryAttempt < maxRetries && !this.config.largeDataSet) {
          console.log(`🔄 Retrying with optimized mode...`)
          retryAttempt++
          this.imageProcessor.cleanupTempImages()
        } else {
          this.imageProcessor.cleanupTempImages()
          console.error(`💥 Failed to generate report after ${retryAttempt + 1} attempts`)
          throw error
        }
      }
    }
  }

  async generateExcelFile(products, users) {
    const date = this.config.getDate()
    const datasetType = this.config.isFinal ? 'final_data_set' : 'interim_data_set'
    const filename = `${this.config.idProject}-${datasetType}-${date}.xlsx`
    
    // Use /tmp directory in Lambda environment
    const filePath = isLambda ? path.join('/tmp', filename) : filename

    console.log(`📝 Generating Excel file: ${filename}`)
    console.log(`📂 File path: ${filePath}`)

    // Preprocess products
    products = this.preprocessProducts(products)

    // Populate products worksheet
    console.log('Populating products worksheet...')
    await this.productsPopulator.populate(products, this.worksheetManager.worksheets.products)
    console.log('Products worksheet populated successfully')

    // Generate SCV headers and assign values
    console.log('Generating SCV headers...')
    const numberOfUsers = users.length
    this.scvHeadersGenerator.generate(products, numberOfUsers)

    console.log('Assigning SCV values...')
    this.assignScvValues(users, products)
    console.log('SCV values assigned successfully')

    // Populate state timers
    console.log('Populating state timers...')
    this.populateStateTimers(users)
    console.log('State timers populated successfully')

    // Handle findability data if available
    if (this.config.hasFindability) {
      await this.handleFindability()
    }

    // Handle funnel and non-purchase data for NIQ projects
    if (this.config.idProject && this.config.idProject.startsWith('niq')) {
      console.log('Populating funnel and non-purchase data...')
      this.populateFunnelAndNonPurchase(users, products, numberOfUsers)
      console.log('Funnel and non-purchase data populated successfully')
    }

    // Write file
    await this.worksheetManager.writeFile(filePath)

    return filePath
  }

  preprocessProducts(products) {
    return products.map((product) => {
      let cells = product.cells.split(',')
      cells = [...new Set(cells)]
      cells = cells.join(';')
      product.cells = cells
      return product
    })
  }

  shouldUseLargeDatasetMode(users, products) {
    // Calculate estimated cell count for zero pre-filling
    const estimatedCells = users.length * products.length * 5 // Rough estimate based on worksheets
    const threshold = this.config.largeDatasetThreshold
    
    if (estimatedCells > threshold) {
      console.log(`📊 Dataset analysis:`)
      console.log(`   Users: ${users.length.toLocaleString()}`)
      console.log(`   Products: ${products.length.toLocaleString()}`)
      console.log(`   Estimated cells for pre-filling: ${estimatedCells.toLocaleString()}`)
      console.log(`   Threshold: ${threshold.toLocaleString()}`)
      console.log(`   Recommendation: Use large dataset mode`)
      return true
    }
    
    return false
  }

  resetForRetry() {
    console.log('🔄 Resetting components for retry...')
    this.config.largeDataSet = true
    this.worksheetManager = new WorksheetManager(this.config)
    this.productsPopulator = new ProductsPopulator(this.config, this.imageProcessor, this.worksheetManager)
    this.scvHeadersGenerator = new ScvHeadersGenerator(this.config, this.worksheetManager)
    this.imageProcessor.cleanupTempImages()
  }

  async handleFindability() {
    try {
      const locations = this.config.getS3Locations()
      console.log('Fetching findability data from S3...')
      const findability = await this.s3Service.getJsonFromS3(locations.findability)
      console.log('Populating findability worksheet...')
      this.populateFindability(findability)
      console.log('Findability worksheet populated successfully')
    } catch (error) {
      console.log('No findability data found')
      this.config.hasFindability = false
    }
  }

  assignScvValues(users, products) {
    const nCommonHeads = this.config.commonHeads.length
    const partner = this.config.getPartner()
    const worksheets = this.worksheetManager.worksheets

    for (let i = 0; i < users.length; i++) {
      const row = i + 2
      const user = users[i]
      const sheets = [worksheets.sales, worksheets.clicks, worksheets.views]

      //Assign base to all sheets
      for (let j = 0; j < sheets.length; j++) {
        sheets[j].cell(row, 1).string(user.idSurvey.toString())
        sheets[j].cell(row, 2).string(user.idMaster.toString())
        sheets[j].cell(row, 3).string(user.idCell.toString())
      }

      // Assign Sales values
      let sTotalItems = 0
      let sTotalPurchase = 0
      let sTotalCartItems = 0
      const sc = ColumnCalculator.salesColumns(products, nCommonHeads, this.config.hasPrices)

      // Loop through sales
      if(!this.config.isAoi) {
        for (let j = 0; j < user.sales.length; j++) {
          const sale = user.sales[j]

          // Get price from products
          const productPrice = products.find(
            (p) => p.idProduct === sale.idProduct
          )?.price || 0
          sale.price = productPrice ? parseFloat(productPrice) : 0

          // We need to subtract 1 to index to convert to base 0
          const column = ColumnCalculator.getColumnIndex(sale.index - 1, sc, 0)

          // Ensure all values are properly converted to numbers
          worksheets.sales.cell(row, column).number(1)
          worksheets.sales.cell(row, column + 1).number(parseFloat(sale.quantity) || 0)
          worksheets.sales.cell(row, column + 2).number(parseFloat(sale.sequence) || 0)

          // Handle dwellTime
          let dwellTime = -1
          if (sale.dwellTime !== undefined && sale.dwellTime !== null) {
            if (isNaN(parseFloat(sale.dwellTime))) {
              console.log(
                `"error-missing-dwellTime-sale":{ "idProduct":${sale.idProduct}", "idMaster":${user.idMaster}`
              )
            } else {
              dwellTime = parseFloat(sale.dwellTime)
            }
          }
          worksheets.sales.cell(row, column + 3).number(dwellTime)

          // Handle price
          if (this.config.hasPrices) {
            worksheets.sales.cell(row, column + 4).number(parseFloat(sale.price) || 0)
          }

          sTotalItems += parseFloat(sale.quantity) || 0
          sTotalCartItems++
          if (this.config.hasPrices) sTotalPurchase += (parseFloat(sale.quantity) || 0) * (parseFloat(sale.price) || 0)
        }

        // Set totals
        worksheets.sales.cell(row, nCommonHeads + 1).number(sTotalItems)
        worksheets.sales.cell(row, nCommonHeads + 2).number(sTotalCartItems)

        if (this.config.hasPrices) {
          if (partner !== 'niq') {
            worksheets.sales.cell(row, nCommonHeads + 3).number(sTotalPurchase)
          } else if (partner === 'niq') {
            worksheets.sales.cell(row, nCommonHeads + 5).number(sTotalPurchase)
            if (sTotalCartItems > 0 && sTotalPurchase > 0) {
              // Use string formulas instead of direct number values
              worksheets.sales.cell(row, nCommonHeads + 3).formula(`H${row}/D${row}`)
              worksheets.sales.cell(row, nCommonHeads + 4).formula(`D${row}/E${row}`)
            } else {
              worksheets.sales.cell(row, nCommonHeads + 3).number(0)
              worksheets.sales.cell(row, nCommonHeads + 4).number(0)
            }
          }
        }
      }

      // Assign Click values
      const cc = ColumnCalculator.clicksColumns(products, nCommonHeads)
      let firstClick = 0
      let timeFirstClick = 0
      let totalCountClicks = 0
      for (let j = 0; j < user.clicks.length; j++) {
        const click = user.clicks[j]

        totalCountClicks += click['count']
        if (j === 0) {
          firstClick = click.index
          timeFirstClick = click.time
        }
        // We need to subtract 1 to index to convert to base 0
        if (click.index !== -1) {
          const column = ColumnCalculator.getColumnIndex(click.index - 1, cc, 0)
          worksheets.clicks.cell(row, column).number(1)
          if (isNaN(click.dwellTime)) {
            console.log(
              `"error-missing-dwellTime-click":{ "idProduct":${click.idProduct}", "idMaster":${user.idMaster}}`
            )
            click.dwellTime = -1
          }
          worksheets.clicks.cell(row, column + 1).number(click.dwellTime)
        }
      }
      worksheets.clicks.cell(row, nCommonHeads + 1).number(firstClick)
      worksheets.clicks.cell(row, nCommonHeads + 2).number(timeFirstClick)
      worksheets.clicks.cell(row, nCommonHeads + 3).number(user.clicks.length)
      if (partner === 'niq') {
        let averageInteractions = 0
        if (
          !isNaN(user.clicks.length) &&
          !isNaN(totalCountClicks) &&
          user.clicks.length > 0
        ) {
          averageInteractions = totalCountClicks / user.clicks.length
        }
        worksheets.clicks.cell(row, nCommonHeads + 4).number(averageInteractions)
      }

      // Assign View values
      const vc = ColumnCalculator.viewsColumns(products.length, nCommonHeads)
      for (let j = 0; j < user.views.length; j++) {
        const view = user.views[j]
        // We need to subtract 1 to index to convert to base 0
        if (view.index !== -1) {
          const column = ColumnCalculator.getColumnIndex(view.index - 1, vc, 0)
          if (view.timer > 0.4999) {
            worksheets.views.cell(row, column).number(1)
            worksheets.views.cell(row, column + 1).number(view.timer)
          }
        }
      }
    }
  }

  populateFindability(findability) {
    const worksheet = this.worksheetManager.worksheets.findability
    const headsStyle = this.worksheetManager.headsStyle
    let cells = []
    const chl = this.config.commonHeads.length
    const extraHeads = [
      'Target Product(s)',
      'Selected Product',
      'Time to Selection',
      'Validator',
    ]
    for (let i = 0; i < chl; i++) {
      worksheet
        .cell(1, i + 1)
        .string(this.config.commonHeads[i])
        .style(headsStyle)
    }
    for (let i = 0; i < extraHeads.length; i++) {
      worksheet
        .cell(1, chl + i + 1)
        .string(extraHeads[i])
        .style(headsStyle)
    }

    // Width columns
    const targetsColumnLengths = []
    targetsColumnLengths.push(extraHeads[0].length)
    const cellsColumnLengths = []
    cellsColumnLengths.push('Cell ID'.length)

    for (let i = 0; i < findability.length; i++) {
      const row = i + 2
      const user = findability[i]
      worksheet.cell(row, 1).string(user.idSurvey.toString())
      worksheet.cell(row, 2).string(user.idMaster.toString())
      worksheet.cell(row, 3).string(user.idCell.toString())
      cellsColumnLengths.push(user.idCell.length)
      worksheet.cell(row, 4).string(user.targets.toString())
      targetsColumnLengths.push(user.targets.toString().length)
      worksheet.cell(row, 5).string(user.selected.toString())
      worksheet.cell(row, 6).number(user.timerRaw)
      worksheet.cell(row, 7).bool(user.validator)
      cells.push(user.idCell)
    }

    // Width columns
    targetsColumnLengths.push(extraHeads[0].length)
    const maxLengthTargets = Math.max(...targetsColumnLengths)
    const maxLengthCells = Math.max(...cellsColumnLengths)

    worksheet.column(3).setWidth(maxLengthCells + 2)
    worksheet.column(4).setWidth(maxLengthTargets + 2)
    worksheet.column(5).setWidth(extraHeads[1].length + 4)
    worksheet.column(6).setWidth(extraHeads[2].length + 4)
    worksheet.column(7).setWidth(extraHeads[3].length + 4)

    // Counter validator
    cells = [...new Set(cells)].sort((a, b) => a.localeCompare(b))
    const nUsers = findability.length
    worksheet.cell(1, 9).string('cell')
    worksheet.column(9).setWidth(maxLengthCells)
    worksheet.cell(1, 10).bool(true)
    worksheet.cell(1, 11).bool(false)
    for (let i = 0; i < cells.length; i++) {
      const row = i + 2
      worksheet.cell(row, 9).string(cells[i])
      worksheet
        .cell(row, 10)
        .formula(
          `COUNTIFS($C$2:$C$${nUsers + 1},$I${row},$G$2:$G$${nUsers + 1},J$1)`
        )
      worksheet
        .cell(row, 11)
        .formula(
          `COUNTIFS($C$2:$C$${nUsers + 1},$I${row},$G$2:$G$${nUsers + 1},K$1)`
        )
    }
    worksheet.row(1).filter({
      firstColumn: 1,
      lastColumn: 7,
    })
  }

  populateStateTimers(users) {
    const worksheet = this.worksheetManager.worksheets.timers
    const headsStyle = this.worksheetManager.headsStyle
    const chl = this.config.commonHeads.length

    for (let i = 0; i < chl; i++) {
      worksheet
        .cell(1, i + 1)
        .string(this.config.commonHeads[i])
        .style(headsStyle)
    }
    const extraHeads = ['Total time', 'Time shopping']
    for (let i = 0; i < extraHeads.length; i++) {
      worksheet
        .cell(1, chl + i + 1)
        .string(extraHeads[i])
        .style(headsStyle)
      // Set the columns width with head length
      worksheet.column(chl + i + 1).setWidth(extraHeads[i].length + 2)
    }

    // Width columns
    const cellsColumnLengths = []
    cellsColumnLengths.push('Cell ID'.length)

    for (let i = 0; i < users.length; i++) {
      const row = i + 2
      const user = users[i]
      worksheet.cell(row, 1).string(user.idSurvey.toString())
      worksheet.cell(row, 2).string(user.idMaster.toString())
      worksheet.cell(row, 3).string(user.idCell.toString())
      cellsColumnLengths.push(user.idCell.length)
      worksheet.cell(row, 4).number(user.timers.totalTime)
      worksheet.cell(row, 5).number(user.timers.shoppingTime)
    }
    const maxLengthCells = Math.max(...cellsColumnLengths)
    worksheet.column(3).setWidth(maxLengthCells + 2)
    worksheet.row(1).filter()
  }

  populateFunnelAndNonPurchase(users, products, numberOfUsers) {
    console.log('Setting up funnel and non-purchase worksheets...')
    const worksheets = this.worksheetManager.worksheets
    const headsStyle = this.worksheetManager.headsStyle
    const commonHeads = this.config.commonHeads

    // Generate headers
    const fc = ColumnCalculator.funnelColumns(products.length, commonHeads.length)
    const npc = ColumnCalculator.nonPurchaseColumns(products.length, commonHeads.length)

    // Add common headers
    for (let i = 0; i < commonHeads.length; i++) {
      worksheets.funnel.cell(1, i + 1).string(commonHeads[i]).style(headsStyle)
      worksheets.nonPurchase.cell(1, i + 1).string(commonHeads[i]).style(headsStyle)
    }

    // Add base headers
    for (let i = 0; i < fc.bc.length; i++) {
      worksheets.funnel.cell(1, commonHeads.length + 1 + i).string(fc.bc[i]).style(headsStyle)
    }
    for (let i = 0; i < npc.bc.length; i++) {
      worksheets.nonPurchase.cell(1, commonHeads.length + 1 + i).string(npc.bc[i]).style(headsStyle)
    }

    // Add indexed headers
    for (let i = 0; i < products.length; i++) {
      WorksheetStyler.assignIndexColumns(worksheets.funnel, fc, i, headsStyle)
      WorksheetStyler.assignIndexColumns(worksheets.nonPurchase, npc, i, headsStyle)
    }

    worksheets.funnel.row(1).filter()
    worksheets.nonPurchase.row(1).filter()

    console.log(`Processing funnel and non-purchase data for ${users.length} users...`)
    for (let i = 0; i < users.length; i++) {
      const sheets = [worksheets.funnel, worksheets.nonPurchase]
      const row = i + 2
      const user = users[i]

      // Log progress periodically
      if (i % 100 === 0) {
        console.log(`Processing user ${i+1}/${users.length}...`)
      }

      //Assign base to all sheets
      for (let j = 0; j < sheets.length; j++) {
        sheets[j].cell(row, 1).string(user.idSurvey.toString())
        sheets[j].cell(row, 2).string(user.idMaster.toString())
        sheets[j].cell(row, 3).string(user.idCell.toString())
      }

      // ---- Funnel ----
      // Assign funnel values
      let totalConversionRate = 0
      let totalPurchase = 0
      // Add null check for user.funnels
      const totalClicks = user.funnels ? user.funnels.length : 0

      // Assign indexed values funnel
      if (user.funnels && Array.isArray(user.funnels)) {
        for (let j = 0; j < user.funnels.length; j++) {
          const funnel = user.funnels[j]

          if (funnel.conversion === 1) {
            totalPurchase++
          }
          // We need to subtract 1 to index to convert to base 0
          if (funnel.index !== -1) {
            const column = ColumnCalculator.getColumnIndex(funnel.index - 1, fc, 0)
            worksheets.funnel.cell(row, column).number(funnel.conversion)
          }
        }
      }

      if (totalClicks > 0) {
        totalConversionRate = totalPurchase / totalClicks
      } else {
        totalConversionRate = 0
      }
      worksheets.funnel.cell(row, commonHeads.length + 1).number(totalConversionRate)
      // --------

      // ---- Non Purchase ----
      // Assign Non Purchase values
      // Add null check for user.notPurchased
      const totalNotPurchase = user.notPurchased ? user.notPurchased.length : 0

      if (user.notPurchased && Array.isArray(user.notPurchased)) {
        for (let j = 0; j < user.notPurchased.length; j++) {
          const nonP = user.notPurchased[j]

          // We need to subtract 1 to index to convert to base 0
          if (nonP.index !== -1) {
            const column = ColumnCalculator.getColumnIndex(nonP.index - 1, npc, 0)
            worksheets.nonPurchase.cell(row, column).number(1)
            worksheets.nonPurchase.cell(row, column + 1).number(j + 1)
          }
        }
      }
      worksheets.nonPurchase.cell(row, commonHeads.length + 1).number(totalNotPurchase)
      // --------
    }
  }
}

// Factory function
function createExcelReportService(idProject, options = {}) {
  const config = new ReportConfiguration(idProject, options)
  return new ExcelReportService(config)
}

module.exports = {
  ExcelReportService,
  ReportConfiguration,
  S3DataService,
  ImageProcessor,
  ColumnCalculator,
  WorksheetManager,
  ProductsPopulator,
  WorksheetStyler,
  ScvHeadersGenerator,
  createExcelReportService
}
