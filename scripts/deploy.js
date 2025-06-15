const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');
const execAsync = util.promisify(exec);
const fsPromises = fs.promises;

const LAMBDA_FUNCTION_NAME = process.env.LAMBDA_FUNCTION_NAME || 'report-excel-lambda';
const LAMBDA_REGION = process.env.REGION || process.env.AWS_REGION || 'us-west-2';

async function copyDirectory(source, destination) {
  await fsPromises.mkdir(destination, { recursive: true });
  const entries = await fsPromises.readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath);
    } else {
      await fsPromises.copyFile(sourcePath, destinationPath);
    }
  }
}

async function createDeploymentPackage() {
  try {
    const distPath = path.join(process.cwd(), 'dist');
    const zipPath = path.join(process.cwd(), 'function.zip');

    console.log('📦 Creating deployment package...');

    // Clean up existing dist directory and zip file
    if (fs.existsSync(distPath)) {
      await fsPromises.rm(distPath, { recursive: true, force: true });
    }
    if (fs.existsSync(zipPath)) {
      await fsPromises.rm(zipPath);
    }
    await fsPromises.mkdir(distPath);

    // Copy necessary files for Excel Lambda
    const filesToCopy = [
      'index.js',
      'src',
      'package.json',
      'yarn.lock'
    ];

    console.log('📋 Copying source files...');
    for (const file of filesToCopy) {
      const sourcePath = path.join(process.cwd(), file);
      const destPath = path.join(distPath, file);

      if (fs.existsSync(sourcePath)) {
        if (fs.lstatSync(sourcePath).isDirectory()) {
          await copyDirectory(sourcePath, destPath);
        } else {
          await fsPromises.copyFile(sourcePath, destPath);
        }
        console.log(`   ✓ Copied ${file}`);
      } else {
        console.log(`   ⚠️  ${file} not found, skipping`);
      }
    }

    // Install production dependencies
    console.log('📦 Installing production dependencies...');
    const originalCwd = process.cwd();
    process.chdir(distPath);

    try {
      await execAsync('yarn install --production --frozen-lockfile');
      console.log('   ✓ Dependencies installed');
    } catch (error) {
      console.log('   ℹ️  Yarn failed, trying npm...');
      await execAsync('npm install --production');
      console.log('   ✓ Dependencies installed with npm');
    }

    process.chdir(originalCwd);

    // Create zip file (cross-platform approach)
    console.log('🗜️  Creating ZIP archive...');

    // Try different zip approaches based on platform
    try {
      if (process.platform === 'win32') {
        // Windows - try PowerShell first
        const powershellCommand = `Compress-Archive -Path "${distPath}\\*" -DestinationPath "${zipPath}" -Force`;
        await execAsync(`powershell -Command "${powershellCommand}"`);
      } else {
        // Unix-like systems (Linux, macOS)
        process.chdir(distPath);
        await execAsync(`zip -r "../function.zip" .`);
        process.chdir(originalCwd);
      }
      console.log('   ✓ ZIP file created successfully');
    } catch (error) {
      console.log('   ⚠️  Native zip failed, trying Node.js approach...');
      // Fallback: use Node.js archiver if available
      throw new Error('ZIP creation failed. Please install zip utility or use serverless deploy instead.');
    }

    // Check file size
    const stats = await fsPromises.stat(zipPath);
    const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
    console.log(`   📊 Package size: ${fileSizeMB} MB`);

    if (stats.size > 50 * 1024 * 1024) { // 50MB limit for direct upload
      console.log('   ⚠️  Package size is large. Consider using S3 for deployment.');
    }

    console.log('✅ Deployment package created successfully!');
  } catch (error) {
    console.error('❌ Error creating deployment package:', error);
    process.exit(1);
  }
}

async function waitForFunctionUpdate(functionName, region, maxWaitTime = 60000) {
  console.log('   ⏳ Waiting for function to be ready...');
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTime) {
    try {
      const { stdout } = await execAsync(`aws lambda get-function --function-name ${functionName} --region ${region}`);
      const functionInfo = JSON.parse(stdout);

      if (functionInfo.Configuration.State === 'Active' && functionInfo.Configuration.LastUpdateStatus === 'Successful') {
        console.log('   ✅ Function is ready');
        return;
      }

      console.log(`   ⏳ Function state: ${functionInfo.Configuration.State}, Status: ${functionInfo.Configuration.LastUpdateStatus}`);
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
    } catch (error) {
      console.log('   ⏳ Checking function status...');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  throw new Error('Function did not become ready within the timeout period');
}

async function deployToLambda() {
  try {
    console.log('🚀 Deploying to AWS Lambda...');
    const zipPath = path.join(process.cwd(), 'function.zip');

    if (!fs.existsSync(zipPath)) {
      throw new Error('Deployment package (function.zip) not found!');
    }

    console.log(`   📡 Updating function: ${LAMBDA_FUNCTION_NAME}`);
    console.log(`   🌍 Region: ${LAMBDA_REGION}`);

    // Wait for function to be ready before starting
    await waitForFunctionUpdate(LAMBDA_FUNCTION_NAME, LAMBDA_REGION, 30000);

    // Update function code
    console.log('   📦 Updating function code...');
    const updateCodeCommand = `aws lambda update-function-code --function-name ${LAMBDA_FUNCTION_NAME} --zip-file fileb://${zipPath} --region ${LAMBDA_REGION}`;
    const { stdout } = await execAsync(updateCodeCommand);

    // Wait for code update to complete
    await waitForFunctionUpdate(LAMBDA_FUNCTION_NAME, LAMBDA_REGION);

    // Update function configuration
    console.log('   🔧 Updating function configuration...');
    const envVars = {
      NODE_ENV: process.env.NODE_ENV || 'production',
      SERVICE_VERSION: 'report-excel-lambda-v1.0.0',
      LOG_LEVEL: process.env.LOG_LEVEL || 'INFO',
      BUCKET: process.env.BUCKET,
      IMAGES_BUCKET: process.env.IMAGES_BUCKET,
      IMAGES_REGION: process.env.IMAGES_REGION || 'us-east-1',
      REGION: process.env.REGION || LAMBDA_REGION
    };

    // Filter out undefined values
    const validEnvVars = Object.fromEntries(
      Object.entries(envVars).filter(([key, value]) => value !== undefined)
    );

    if (Object.keys(validEnvVars).length > 0) {
      const envString = JSON.stringify({ Variables: validEnvVars }).replace(/"/g, '\\"');
      const updateConfigCommand = `aws lambda update-function-configuration --function-name ${LAMBDA_FUNCTION_NAME} --handler index.handler --timeout 900 --memory-size 4096 --environment "${envString}" --region ${LAMBDA_REGION}`;
      await execAsync(updateConfigCommand);

      // Wait for configuration update to complete
      await waitForFunctionUpdate(LAMBDA_FUNCTION_NAME, LAMBDA_REGION);
    } else {
      // Just update handler and performance settings if no environment variables
      const updateConfigCommand = `aws lambda update-function-configuration --function-name ${LAMBDA_FUNCTION_NAME} --handler index.handler --timeout 900 --memory-size 4096 --region ${LAMBDA_REGION}`;
      await execAsync(updateConfigCommand);

      await waitForFunctionUpdate(LAMBDA_FUNCTION_NAME, LAMBDA_REGION);
    }

    console.log('✅ Deployment successful!');

    // Parse and display deployment info
    try {
      const result = JSON.parse(stdout);
      console.log('');
      console.log('📋 Deployment Details:');
      console.log(`   Function: ${result.FunctionName}`);
      console.log(`   Runtime: ${result.Runtime}`);
      console.log(`   Version: ${result.Version}`);
      console.log(`   Last Modified: ${result.LastModified}`);
      console.log(`   Code Size: ${(result.CodeSize / 1024 / 1024).toFixed(2)} MB`);
    } catch (parseError) {
      console.log('   ℹ️  Deployment completed (response parsing skipped)');
    }

  } catch (error) {
    console.error('❌ Error deploying to Lambda:', error);
    console.error('');
    console.error('💡 Troubleshooting tips:');
    console.error('   1. Check that AWS CLI is installed and configured');
    console.error('   2. Verify the Lambda function exists');
    console.error('   3. Ensure IAM permissions for lambda:UpdateFunctionCode');
    console.error(`   4. Confirm function name: ${LAMBDA_FUNCTION_NAME}`);
    console.error(`   5. Confirm region: ${LAMBDA_REGION}`);
    process.exit(1);
  }
}

async function main() {
  console.log('🚀 Excel Lambda Deployment Script');
  console.log('=' .repeat(50));
  console.log(`Function: ${LAMBDA_FUNCTION_NAME}`);
  console.log(`Region: ${LAMBDA_REGION}`);
  console.log('');

  await createDeploymentPackage();
  console.log('');
  await deployToLambda();

  console.log('');
  console.log('🎉 Deployment completed successfully!');
}

// CLI interface
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
🚀 Excel Lambda Deployment Script

Usage:
  node scripts/deploy.js [options]

Environment Variables:
  LAMBDA_FUNCTION_NAME    Lambda function name (default: report-excel-lambda)
  REGION                  AWS region (default: us-west-2)
  AWS_REGION              Alternative region variable

Options:
  --help, -h              Show this help message

Prerequisites:
  - AWS CLI installed and configured
  - Lambda function already exists
  - IAM permissions for lambda:UpdateFunctionCode
`);
  process.exit(0);
}

// Run the main function
if (require.main === module) {
  main().catch(error => {
    console.error('💥 Deployment failed:', error);
    process.exit(1);
  });
}

module.exports = { main, createDeploymentPackage, deployToLambda };
