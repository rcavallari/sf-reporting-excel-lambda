# GitHub Workflows for Excel Report Service

This directory contains GitHub Actions workflows for the Excel Report Service. These workflows provide comprehensive CI/CD, testing, and maintenance automation.

## Workflows Overview

### 1. CI Pipeline (`ci.yml`)
**Triggers**: Push/PR to `main` or `develop` branches

**Features**:
- Multi-version Node.js testing (20.x, 22.x)
- Dependency installation with yarn
- Code linting with ESLint
- Unit tests execution
- Security vulnerability scanning
- Serverless packaging validation

### 2. Development Deployment (`deploy-dev.yml`)
**Triggers**: Push to `develop` branch, manual dispatch

**Features**:
- Automated deployment to development environment
- Post-deployment health checks
- Configurable force deployment option
- Environment-specific configuration

### 3. Production Deployment (`deploy-prod.yml`)
**Triggers**: Push to `main` branch, version tags, manual dispatch

**Features**:
- Enhanced security checks before deployment
- Production-grade health checks with retries
- Automatic GitHub release creation for tagged versions
- Separate production AWS credentials

### 4. Scheduled Health Checks (`scheduled-tests.yml`)
**Triggers**: Every 6 hours, manual dispatch

**Features**:
- Regular health checks for both environments
- Security audits
- Artifact management
- Automated issue creation for maintenance

### 5. Cleanup and Maintenance (`cleanup.yml`)
**Triggers**: Weekly schedule, manual dispatch

**Features**:
- CloudWatch logs cleanup (30-day retention)
- GitHub artifacts cleanup
- Dependency update monitoring
- Automated maintenance issue creation

### 6. Hotfix Deployment (`hotfix.yml`)
**Triggers**: Manual dispatch only

**Features**:
- Emergency deployment capabilities
- Configurable test skipping for critical situations
- Deployment tracking and documentation
- Automated rollback instructions

## Setup Instructions

### 1. Repository Secrets

Configure the following secrets in your GitHub repository:

#### Development Environment
```
AWS_ACCESS_KEY_ID          # AWS access key for dev environment
AWS_SECRET_ACCESS_KEY      # AWS secret key for dev environment
```

#### Production Environment
```
PROD_AWS_ACCESS_KEY_ID     # AWS access key for production
PROD_AWS_SECRET_ACCESS_KEY # AWS secret key for production
```

#### GitHub
```
GITHUB_TOKEN               # Automatically provided by GitHub
```

### 2. Repository Variables

Configure the following variables in your GitHub repository:

```
AWS_REGION                 # AWS region (default: us-east-1)
DEV_BUCKET                 # S3 bucket for development
DEV_IMAGES_BUCKET          # S3 images bucket for development
PROD_BUCKET                # S3 bucket for production
PROD_IMAGES_BUCKET         # S3 images bucket for production
```

### 3. Environment Protection Rules

Set up environment protection rules for:
- **development**: Require branch to be up to date
- **production**: Require reviews from code owners

### 4. Branch Protection Rules

Configure the following branch protection rules:

#### `main` branch:
- Require pull request reviews
- Require status checks to pass
- Require branches to be up to date
- Include administrators

#### `develop` branch:
- Require status checks to pass
- Require branches to be up to date

## Usage Guide

### Standard Development Flow

1. **Feature Development**:
   ```bash
   git checkout develop
   git checkout -b feature/your-feature
   # Make changes
   git push origin feature/your-feature
   ```
   - Create PR to `develop`
   - CI workflow runs automatically
   - Merge triggers development deployment

2. **Production Release**:
   ```bash
   git checkout main
   git merge develop
   git tag v1.0.0
   git push origin main --tags
   ```
   - Production deployment runs automatically
   - GitHub release created for tagged versions

### Emergency Hotfix Flow

1. **Create Hotfix Branch**:
   ```bash
   git checkout main
   git checkout -b hotfix/critical-fix
   # Make minimal changes
   git push origin hotfix/critical-fix
   ```

2. **Deploy Hotfix**:
   - Go to Actions → Hotfix Deployment
   - Click "Run workflow"
   - Fill in required parameters:
     - Branch: `hotfix/critical-fix`
     - Environment: `production`
     - Reason: "Critical security fix"
     - Skip tests: Only if absolutely necessary

3. **Post-Hotfix**:
   - Monitor deployment
   - Merge hotfix back to `main` and `develop`
   - Create proper release

### Manual Operations

#### Force Development Deployment
```yaml
# In deploy-dev.yml workflow
inputs:
  force_deploy: true
```

#### Run Health Checks
- Go to Actions → Scheduled Health Checks
- Click "Run workflow"

#### Cleanup Operations
- Go to Actions → Cleanup and Maintenance
- Select cleanup type: logs, artifacts, dependencies, or all

## Monitoring and Alerts

### Health Check Monitoring
- Endpoints tested every 6 hours
- Failed health checks will fail the workflow
- Check workflow logs for detailed error information

### Security Monitoring
- Dependencies scanned for vulnerabilities
- Critical vulnerabilities block production deployments
- Weekly security audit reports generated

### Maintenance Tracking
- Automated issues created for dependency updates
- CloudWatch logs automatically managed
- Old artifacts cleaned up regularly

## Troubleshooting

### Common Issues

1. **Deployment Failures**:
   - Check AWS credentials and permissions
   - Verify environment variables are set
   - Review CloudFormation stack status

2. **Health Check Failures**:
   - Verify Lambda function is deployed
   - Check API Gateway configuration
   - Review Lambda logs in CloudWatch

3. **Permission Errors**:
   - Ensure IAM roles have necessary permissions
   - Check S3 bucket policies
   - Verify cross-account access if applicable

### Getting Help

1. Check workflow logs in GitHub Actions
2. Review CloudWatch logs for Lambda errors
3. Verify AWS resource status in Console
4. Check serverless.yml configuration

## Security Considerations

1. **Credentials Management**:
   - Use separate AWS accounts/roles for prod/dev
   - Rotate access keys regularly
   - Enable CloudTrail for audit logging

2. **Branch Protection**:
   - Require code reviews for all changes
   - Protect main and develop branches
   - Use signed commits where possible

3. **Dependency Security**:
   - Regular security audits
   - Automated vulnerability scanning
   - Block deployments with critical issues

## Maintenance

### Regular Tasks

1. **Weekly**:
   - Review dependency update issues
   - Check security audit results
   - Verify backup and cleanup operations

2. **Monthly**:
   - Rotate AWS access keys
   - Review and update workflow configurations
   - Test disaster recovery procedures

3. **Quarterly**:
   - Update Node.js versions in workflows (currently using 22.x as default)
   - Review and update security policies
   - Conduct workflow performance review