# DynamoDB Table Setup

## Overview

This document describes how to create the DynamoDB table with the new clean schema that uses `recordId` as the primary key.

## New Schema Design

### Primary Key Structure
- **Primary Key**: `recordId` (String) - Unique identifier for each record
- **Attributes**: 
  - `jobId` (String) - Filter attribute to group all records for a job
  - `recordType` (String) - Either "main_job" or "progress_log"
  - `sequenceNumber` (Number) - 0 for main job, 1,2,3... for progress logs

### Record Types

#### Main Job Record
```json
{
  "recordId": "job_job_mbzlks74_rfi5i0_1734383256789_abc123",
  "jobId": "job_mbzlks74_rfi5i0",
  "recordType": "main_job",
  "sequenceNumber": 0,
  "idProject": "mlab_bodwassho_usa_3",
  "status": "pending",
  "progress": 0,
  "createdAt": "2025-06-16T21:19:33.789Z",
  "updatedAt": "2025-06-16T21:19:33.789Z",
  "ttl": 1734469656,
  "options": {},
  "metadata": {
    "totalSteps": 5,
    "currentStep": 0,
    "stepName": "initializing"
  }
}
```

#### Progress Log Record
```json
{
  "recordId": "job_mbzlks74_rfi5i0_seq001_2025-06-16_21_20_15_abc",
  "jobId": "job_mbzlks74_rfi5i0",
  "recordType": "progress_log",
  "sequenceNumber": 1,
  "timestamp": "2025-06-16T21:20:15.564Z",
  "progress": 15,
  "stepName": "starting",
  "ttl": 1734469615
}
```

## Steps to Recreate the Table

### 1. Delete Existing Table (if needed)
```bash
aws dynamodb delete-table --table-name excel-report-jobs --region us-west-2
```

### 2. Create New Table
```bash
aws dynamodb create-table \
  --table-name excel-report-jobs \
  --attribute-definitions \
    AttributeName=recordId,AttributeType=S \
  --key-schema \
    AttributeName=recordId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-west-2
```

### 3. Enable TTL (Optional but Recommended)
```bash
aws dynamodb update-time-to-live \
  --table-name excel-report-jobs \
  --time-to-live-specification Enabled=true,AttributeName=ttl \
  --region us-west-2
```

## Benefits of New Schema

1. **Multiple Progress Records**: Each progress update creates a separate DynamoDB item
2. **Sequence Numbers**: Progress messages are numbered 0 (main), 1, 2, 3... for proper ordering
3. **No Overwrites**: Unique `recordId` ensures no data loss
4. **Consistent Structure**: Both main job and progress records use the same key structure
5. **Easy Querying**: Filter by `jobId` to get all records for a job
6. **Scalable**: No GSI needed, simple scan operations

## Querying Examples

### Get Main Job
```javascript
// Scan for main job record
const result = await dynamoDb.scan({
  TableName: 'excel-report-jobs',
  FilterExpression: 'jobId = :jobId AND recordType = :recordType',
  ExpressionAttributeValues: {
    ':jobId': 'job_mbzlks74_rfi5i0',
    ':recordType': 'main_job'
  }
})
```

### Get All Progress Logs
```javascript
// Scan for progress logs, sorted by sequence
const result = await dynamoDb.scan({
  TableName: 'excel-report-jobs',
  FilterExpression: 'jobId = :jobId AND recordType = :recordType',
  ExpressionAttributeValues: {
    ':jobId': 'job_mbzlks74_rfi5i0',
    ':recordType': 'progress_log'
  }
})
const progressLogs = result.Items.sort((a, b) => a.sequenceNumber - b.sequenceNumber)
```

### Get All Records for a Job
```javascript
// Scan for all records for a job
const result = await dynamoDb.scan({
  TableName: 'excel-report-jobs',
  FilterExpression: 'jobId = :jobId',
  ExpressionAttributeValues: {
    ':jobId': 'job_mbzlks74_rfi5i0'
  }
})
const allRecords = result.Items.sort((a, b) => a.sequenceNumber - b.sequenceNumber)
```

## Environment Variables

Make sure these environment variables are set:
- `JOBS_TABLE=excel-report-jobs`
- `JOB_TTL_HOURS=24`
