# Excel Report Service

A serverless AWS Lambda service for generating Excel reports from S3 data with intelligent pricing detection and auto-optimization for large datasets.

## 🏗️ Architecture

The service provides **two entry points**:

1. **🚀 AWS Lambda Handler** - For API Gateway integration (production)
2. **💻 Manual Script** - For local execution with hardcoded parameters (development)

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- AWS CLI configured
- Serverless Framework (optional, for deployment)

### Installation

```bash
cd excel-report-service
yarn install
```

### Environment Setup

```bash
# Copy environment template
cp .env .env

# Edit .env file with your configuration
AWS_REGION=us-east-1
BUCKET=your-data-bucket
IMAGES_BUCKET=your-images-bucket
```

## 📝 Usage

### Method 1: Manual Script (Recommended for Development)

**Step 1:** Edit `scripts/generate-report.js` to configure your projects:

```javascript
const PROJECTS = {
  'your_project': {
    idProject: 'your_project_id',
    options: {
      isFinal: true,          // Generate final dataset
      hasPrices: undefined,   // Auto-detect pricing
      hasFindability: true,   // Include findability data
      largeDataSet: false     // Standard mode
    }
  }
}

const PROJECT_TO_RUN = 'your_project' // Select which project to run
```

**Step 2:** Run the script:

```bash
yarn start                    # Run configured project
yarn run dev                  # Run in development mode
node scripts/generate-report.js --help  # Show help
node scripts/generate-report.js --list  # List available projects
```

### Method 2: AWS Lambda (Production)

**Step 1:** Deploy the service:

```bash
yarn run deploy:dev      # Deploy to development
yarn run deploy:prod     # Deploy to production
```

**Step 2:** Call the API:

```bash
curl -X POST https://your-api-gateway-url/generate-report \
  -H "Content-Type: application/json" \
  -d '{
    "idProject": "mlab_superdairy_usa_2",
    "options": {
      "isFinal": true,
      "hasPrices": false,
      "largeDataSet": false
    }
  }'
```

**API Response:**
```json
{
  "success": true,
  "message": "Excel report generated successfully",
  "data": {
    "idProject": "mlab_superdairy_usa_2",
    "filename": "mlab_superdairy_usa_2-final_data_set-12152024-14.30.xlsx",
    "downloadUrl": "https://s3.amazonaws.com/signed-url...",
    "processingTime": 45000,
    "stats": {
      "products": 198,
      "users": 1250,
      "hasPrices": true,
      "datasetMode": "standard"
    }
  }
}
```

## ⚙️ Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `idProject` | string | **required** | Project identifier |
| `isFinal` | boolean | `true` | Generate final vs interim dataset |
| `hasPrices` | boolean | auto-detect | Include pricing data |
| `hasFindability` | boolean | `true` | Include findability data |
| `isAoi` | boolean | `false` | AOI mode |
| `largeDataSet` | boolean | `false` | Large dataset optimization |
| `largeDatasetThreshold` | number | `1000000` | Auto-optimization threshold |
| `priceThreshold` | number | `0.5` | Price detection threshold (0-1) |

## 🧠 Intelligent Features

### 💰 Automatic Pricing Detection

- **≥50% valid prices** → Enable pricing features
- **<50% valid prices** → Disable pricing features  
- **Detailed analytics** with price ranges and statistics
- **Configurable threshold** via `priceThreshold`

### 📊 Large Dataset Optimization

- **Proactive detection** of large datasets
- **Automatic retry** with optimization if generation fails
- **Memory efficient** processing for large data volumes

## 🧪 Testing

### Test Manual Script
```bash
yarn start
```

### Test Lambda Locally (with Serverless)
```bash
yarn run invoke:local
```

### Test Health Endpoint
```bash
curl https://your-api-gateway-url/health
```

## 📁 Project Structure

```
excel-report-service/
├── src/
│   ├── handlers/
│   │   └── lambda-handler.js     # 🚀 AWS Lambda entry point
│   ├── utils/
│   │   ├── lambda-utils.js       # Lambda utilities
│   │   └── logger.js            # Structured logging
│   └── excel-service.js         # Core service logic
├── scripts/
│   └── generate-report.js       # 💻 Manual script entry point
├── test/
│   └── sample-event.json        # Test data
├── package.json
├── serverless.yml              # AWS deployment config
└── .env.example               # Environment template
```

## 🔧 Development

### Adding New Projects

Edit the `PROJECTS` object in `scripts/generate-report.js`:

```javascript
const PROJECTS = {
  'new_project': {
    idProject: 'new_project_id',
    options: {
      isFinal: true,
      hasPrices: undefined, // Auto-detect
      // ... other options
    }
  }
}
```

### Extending Excel Generation

The current implementation includes a basic Excel generator. To add the full logic from the original system:

1. Copy the worksheet generation classes from the original `excel-helpers.js`
2. Integrate them into the `ExcelReportService.generateExcelFile()` method
3. Maintain the same intelligent features (pricing detection, retry logic)

## 🚀 Deployment

### Environment Variables

Set these in your deployment environment:

```bash
# Required
BUCKET=your-s3-bucket
AWS_REGION=us-east-1

# Optional
IMAGES_BUCKET=your-images-bucket
LOG_LEVEL=INFO
```

### Deploy Commands

```bash
yarn run deploy:dev      # Development environment
yarn run deploy:prod     # Production environment
```

## 📊 Monitoring

- **CloudWatch Logs**: Structured JSON logging
- **Health Check**: `GET /health` endpoint
- **Request Tracing**: Unique request IDs
- **Error Handling**: Comprehensive error responses

## 🔒 Security

- **IAM Roles**: Least privilege S3 and CloudWatch access
- **Input Validation**: Comprehensive request validation
- **Error Sanitization**: No sensitive data in error responses
- **CORS Configuration**: Configurable cross-origin policies

## 🎯 Key Benefits

✅ **Two Entry Points**: Manual script + Lambda API  
✅ **Intelligent Pricing**: Auto-detects pricing availability  
✅ **Large Dataset Support**: Auto-optimization for performance  
✅ **AWS Best Practices**: Proper logging, monitoring, security  
✅ **Easy Deployment**: Serverless Framework integration  
✅ **Developer Friendly**: Clear documentation and examples  

## 🤝 Usage Examples

### Quick Start Example
```javascript
// Manual script usage
const PROJECT_TO_RUN = 'mlab_superdairy_usa_2'

// API usage
{
  "idProject": "mlab_superdairy_usa_2",
  "options": {
    "isFinal": true,
    "hasPrices": false
  }
}
```

### Advanced Configuration
```javascript
{
  "idProject": "large_niq_project",
  "options": {
    "isFinal": false,
    "largeDataSet": true,
    "priceThreshold": 0.3,
    "largeDatasetThreshold": 500000
  }
}
```

This service provides a robust, scalable solution for Excel report generation with intelligent features and AWS best practices! 🎉
