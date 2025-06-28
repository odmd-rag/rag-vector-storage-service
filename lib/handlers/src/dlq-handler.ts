import { SQSEvent, SQSRecord, Context } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// Initialize AWS clients
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });

// Environment variables
const VECTOR_METADATA_BUCKET = process.env.VECTOR_METADATA_BUCKET!;

interface FailedVectorTask {
    messageId: string;
    originalS3Event: any;
    failureReason: string;
    failureTime: string;
    retryCount: number;
    firstFailureTime: string;
}

/**
 * Lambda handler for processing failed vector storage messages from DLQ
 */
export const handler = async (event: SQSEvent, context: Context): Promise<void> => {
    const startTime = Date.now();
    const requestId = context.awsRequestId;
    
    console.log(`[${requestId}] === Vector DLQ Handler Lambda Started ===`);
    console.log(`[${requestId}] Function: ${context.functionName}:${context.functionVersion}`);
    console.log(`[${requestId}] Failed messages to process: ${event.Records.length}`);

    let processedCount = 0;
    let failedCount = 0;

    // Process each failed message
    for (const record of event.Records) {
        const recordStartTime = Date.now();
        try {
            console.log(`[${requestId}] Processing DLQ record: ${record.messageId}`);
            await processDlqMessage(record, requestId);
            processedCount++;
            
            const recordDuration = Date.now() - recordStartTime;
            console.log(`[${requestId}] ✅ Successfully processed DLQ record ${record.messageId} in ${recordDuration}ms`);
            
        } catch (error) {
            failedCount++;
            const recordDuration = Date.now() - recordStartTime;
            console.error(`[${requestId}] ❌ Failed to process DLQ record ${record.messageId} after ${recordDuration}ms:`, error);
            // Continue processing other messages even if one fails
        }
    }

    const totalDuration = Date.now() - startTime;
    console.log(`[${requestId}] === Vector DLQ Handler Lambda Completed ===`);
    console.log(`[${requestId}] Total execution time: ${totalDuration}ms`);
    console.log(`[${requestId}] Processed: ${processedCount}/${event.Records.length}`);
    console.log(`[${requestId}] Failed: ${failedCount}/${event.Records.length}`);
};

/**
 * Process a single failed message from DLQ
 */
async function processDlqMessage(record: SQSRecord, requestId: string): Promise<void> {
    try {
        console.log(`[${requestId}] 🔍 Analyzing failed vector processing message...`);
        
        // Parse the original message
        const originalMessage = JSON.parse(record.body);
        
        // Extract S3 event details
        const s3Event = originalMessage;
        const objectKey = s3Event.s3?.object?.key || 'unknown';
        const bucketName = s3Event.s3?.bucket?.name || 'unknown';
        
        // Extract document and chunk IDs from S3 key if possible
        let documentId = 'unknown';
        let chunkId = 'unknown';
        try {
            const keyParts = objectKey.split('/');
            if (keyParts.length === 3 && keyParts[0] === 'embeddings') {
                documentId = keyParts[1];
                chunkId = keyParts[2].replace('.json', '');
            }
        } catch (error) {
            console.warn(`[${requestId}] Could not parse document/chunk IDs from key: ${objectKey}`);
        }

        console.log(`[${requestId}] 📋 Failed message details:`);
        console.log(`[${requestId}]   Message ID: ${record.messageId}`);
        console.log(`[${requestId}]   S3 bucket: ${bucketName}`);
        console.log(`[${requestId}]   S3 key: ${objectKey}`);
        console.log(`[${requestId}]   Document ID: ${documentId}`);
        console.log(`[${requestId}]   Chunk ID: ${chunkId}`);
        console.log(`[${requestId}]   Receive count: ${record.attributes?.ApproximateReceiveCount || 'unknown'}`);

        // Create failure record
        const failedTask: FailedVectorTask = {
            messageId: record.messageId,
            originalS3Event: originalMessage,
            failureReason: `Vector processing failed after ${record.attributes?.ApproximateReceiveCount || 'unknown'} attempts`,
            failureTime: new Date().toISOString(),
            retryCount: parseInt(record.attributes?.ApproximateReceiveCount || '1'),
            firstFailureTime: record.attributes?.ApproximateFirstReceiveTimestamp 
                ? new Date(parseInt(record.attributes.ApproximateFirstReceiveTimestamp) * 1000).toISOString()
                : new Date().toISOString()
        };

        console.log(`[${requestId}] 🔍 Storing failure record for analysis...`);

        // Store failure record for manual analysis
        const failureKey = `failed-vectors/${documentId}/${chunkId}-${record.messageId}.json`;
        await storeDlqFailureRecord(failureKey, failedTask, requestId);

        console.log(`[${requestId}] ✅ DLQ message processed and failure recorded`);
        console.log(`[${requestId}]   Failure record: s3://${VECTOR_METADATA_BUCKET}/${failureKey}`);
        
    } catch (error) {
        console.error(`[${requestId}] ❌ Failed to process DLQ message:`, error);
        throw error;
    }
}

/**
 * Store DLQ failure record in S3 for manual analysis
 */
async function storeDlqFailureRecord(
    objectKey: string,
    failedTask: FailedVectorTask,
    requestId: string
): Promise<void> {
    console.log(`[${requestId}] 💾 Storing DLQ failure record: ${objectKey}`);

    try {
        await s3Client.send(
            new PutObjectCommand({
                Bucket: VECTOR_METADATA_BUCKET,
                Key: objectKey,
                Body: JSON.stringify(failedTask, null, 2),
                ContentType: 'application/json',
                Metadata: {
                    'record-type': 'dlq-failure',
                    'message-id': failedTask.messageId,
                    'failure-time': failedTask.failureTime,
                    'retry-count': failedTask.retryCount.toString(),
                    'source': 'vector-dlq-handler'
                }
            })
        );

        console.log(`[${requestId}] ✅ DLQ failure record stored successfully`);

    } catch (error) {
        console.error(`[${requestId}] ❌ Failed to store DLQ failure record:`, error);
        throw new Error(`Failed to store DLQ failure record to s3://${VECTOR_METADATA_BUCKET}/${objectKey}: ${error}`);
    }
} 