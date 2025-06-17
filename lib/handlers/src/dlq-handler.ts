import { Context, SQSEvent } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

// Initialize AWS clients
const s3Client = new S3Client({});
const dynamoClient = new DynamoDBClient({});

// Environment variables
const VECTOR_METADATA_BUCKET_NAME = process.env.VECTOR_METADATA_BUCKET_NAME!;
const VECTOR_INDEX_TABLE_NAME = process.env.VECTOR_INDEX_TABLE_NAME!;

// Interfaces
interface VectorProcessingTask {
    embeddingS3Key: string;
    embeddingS3Bucket: string;
    timestamp: string;
    taskId: string;
}

interface DlqRecord {
    originalTask: VectorProcessingTask;
    errorDetails: {
        errorMessage: string;
        attemptCount: number;
        firstFailureAt: string;
        lastFailureAt: string;
        sqsMessageId: string;
        sqsReceiptHandle: string;
    };
    dlqProcessedAt: string;
    status: 'logged' | 'requires_manual_review';
}

/**
 * Lambda handler for processing failed vector indexing tasks from DLQ
 * Logs failures and updates status for monitoring and potential manual recovery
 */
export const handler = async (event: SQSEvent, context: Context): Promise<void> => {
    const startTime = Date.now();
    const requestId = context.awsRequestId;
    
    console.log(`[${requestId}] === DLQ Handler Started ===`);
    console.log(`[${requestId}] Function: ${context.functionName}:${context.functionVersion}`);
    console.log(`[${requestId}] Processing ${event.Records.length} DLQ messages`);

    const results = [];

    for (const record of event.Records) {
        const messageId = record.messageId;
        try {
            console.log(`[${requestId}] Processing DLQ message: ${messageId}`);
            
            // Parse the original failed task
            const originalTask: VectorProcessingTask = JSON.parse(record.body);
            console.log(`[${requestId}] Original task: ${JSON.stringify(originalTask)}`);

            // Extract error information from SQS attributes
            const receiveCount = parseInt(record.attributes.ApproximateReceiveCount || '1');
            
            // Process the DLQ record
            await processDlqRecord(originalTask, record, receiveCount, requestId);

            results.push({ messageId, status: 'success' });
            console.log(`[${requestId}] ✅ Successfully processed DLQ message: ${messageId}`);
        } catch (error) {
            console.error(`[${requestId}] ❌ Failed to process DLQ message ${messageId}:`, error);
            results.push({ messageId, status: 'failed', error: (error as Error).message });
            // Don't throw - we want to process other messages even if one fails
        }
    }

    const totalDuration = Date.now() - startTime;
    const successCount = results.filter(r => r.status === 'success').length;
    console.log(`[${requestId}] ✅ DLQ processing complete. Processed ${successCount}/${results.length} messages in ${totalDuration}ms`);
};

/**
 * Process a single DLQ record
 */
async function processDlqRecord(
    originalTask: VectorProcessingTask, 
    sqsRecord: any, 
    attemptCount: number, 
    requestId: string
): Promise<void> {
    const dlqStartTime = Date.now();
    
    console.log(`[${requestId}] 🔍 Processing failed vector indexing task...`);
    console.log(`[${requestId}]   Original S3 key: ${originalTask.embeddingS3Key}`);
    console.log(`[${requestId}]   Attempt count: ${attemptCount}`);
    console.log(`[${requestId}]   Task ID: ${originalTask.taskId}`);

    // Create DLQ record
    const dlqRecord: DlqRecord = {
        originalTask,
        errorDetails: {
            errorMessage: `Failed after ${attemptCount} attempts`,
            attemptCount,
            firstFailureAt: originalTask.timestamp,
            lastFailureAt: new Date().toISOString(),
            sqsMessageId: sqsRecord.messageId,
            sqsReceiptHandle: sqsRecord.receiptHandle
        },
        dlqProcessedAt: new Date().toISOString(),
        status: attemptCount >= 3 ? 'requires_manual_review' : 'logged'
    };

    // Store DLQ record in S3 for analysis
    await storeDlqRecord(dlqRecord, requestId);

    // Update DynamoDB status if we can extract document/chunk info
    await updateFailureStatus(originalTask, dlqRecord, requestId);

    const processingDuration = Date.now() - dlqStartTime;
    console.log(`[${requestId}] ✅ Processed DLQ record in ${processingDuration}ms`);
    console.log(`[${requestId}]   Status: ${dlqRecord.status}`);
    console.log(`[${requestId}]   Attempts: ${attemptCount}`);
}

/**
 * Store DLQ record in S3 for monitoring and analysis
 */
async function storeDlqRecord(dlqRecord: DlqRecord, requestId: string): Promise<void> {
    try {
        // Generate timestamp-based key for the DLQ record
        const timestamp = new Date().toISOString();
        const taskId = dlqRecord.originalTask.taskId || 'unknown';
        const objectKey = `dlq-records/${timestamp}-${taskId}-dlq.json`;

        console.log(`[${requestId}] Storing DLQ record: ${objectKey}`);

        await s3Client.send(new PutObjectCommand({
            Bucket: VECTOR_METADATA_BUCKET_NAME,
            Key: objectKey,
            Body: JSON.stringify(dlqRecord, null, 2),
            ContentType: 'application/json',
            Metadata: {
                'dlq-processed-at': dlqRecord.dlqProcessedAt,
                'original-s3-key': dlqRecord.originalTask.embeddingS3Key,
                'attempt-count': dlqRecord.errorDetails.attemptCount.toString(),
                'status': dlqRecord.status,
                'task-id': dlqRecord.originalTask.taskId
            }
        }));

        console.log(`[${requestId}] ✅ Stored DLQ record in S3`);
    } catch (error) {
        console.error(`[${requestId}] ❌ Failed to store DLQ record:`, error);
        throw error;
    }
}

/**
 * Update failure status in DynamoDB
 * Attempts to extract document and chunk info from the original task
 */
async function updateFailureStatus(originalTask: VectorProcessingTask, dlqRecord: DlqRecord, requestId: string): Promise<void> {
    try {
        // Try to extract document ID and chunk ID from S3 key pattern
        // Expected pattern: YYYY-MM-DDTHH:mm:ss.sssZ-{hash}.json
        const keyPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)-([a-f0-9]{64})\.json$/;
        const match = originalTask.embeddingS3Key.match(keyPattern);
        
        if (!match) {
            console.log(`[${requestId}] Cannot extract document info from S3 key pattern: ${originalTask.embeddingS3Key}`);
            return;
        }

        // For now, we'll use the S3 key as a fallback identifier
        // In a real implementation, you might need to download the S3 file to get the actual document/chunk IDs
        const fallbackDocumentId = `unknown-doc-${match[2].substring(0, 8)}`;
        const fallbackChunkId = `unknown-chunk-${match[2].substring(8, 16)}`;

        console.log(`[${requestId}] Updating failure status for fallback IDs: doc=${fallbackDocumentId}, chunk=${fallbackChunkId}`);

        await dynamoClient.send(new UpdateItemCommand({
            TableName: VECTOR_INDEX_TABLE_NAME,
            Key: marshall({
                documentId: fallbackDocumentId,
                chunkId: fallbackChunkId
            }),
            UpdateExpression: 'SET indexingStatus = :status, errorMessage = :error, updatedAt = :updated, attemptCount = :attempts',
            ExpressionAttributeValues: marshall({
                ':status': 'failed',
                ':error': dlqRecord.errorDetails.errorMessage,
                ':updated': dlqRecord.dlqProcessedAt,
                ':attempts': dlqRecord.errorDetails.attemptCount
            })
        }));

        console.log(`[${requestId}] ✅ Updated failure status in DynamoDB`);
    } catch (error) {
        console.error(`[${requestId}] ❌ Failed to update failure status:`, error);
        // Don't throw - DLQ record storage is more important than DynamoDB update
    }
} 