import { Context } from 'aws-lambda';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

// Initialize AWS clients
const s3Client = new S3Client({});
const sqsClient = new SQSClient({});
const dynamoClient = new DynamoDBClient({});

// Environment variables
const EMBEDDINGS_BUCKET_NAME = process.env.EMBEDDINGS_BUCKET_NAME!;
const VECTOR_PROCESSING_QUEUE_URL = process.env.VECTOR_PROCESSING_QUEUE_URL!;
const CHECKPOINT_TABLE_NAME = process.env.CHECKPOINT_TABLE_NAME!;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '50');
const SERVICE_ID = process.env.SERVICE_ID || 'vector-storage-1';

// Interfaces
interface CheckpointRecord {
    serviceId: string;
    lastProcessedTimestamp: string;
    lastProcessedKey: string;
    updatedAt: string;
}

interface VectorProcessingTask {
    embeddingS3Key: string;
    embeddingS3Bucket: string;
    timestamp: string;
    taskId: string;
}

/**
 * Lambda handler for polling completed embeddings for vector indexing
 * Polls for new embedding files and sends them to SQS for vector indexing into OpenSearch
 */
export const handler = async (event: any, context: Context): Promise<void> => {
    const startTime = Date.now();
    const requestId = context.awsRequestId;
    
    console.log(`[${requestId}] === Vector Indexing Poller Started ===`);
    console.log(`[${requestId}] Function: ${context.functionName}:${context.functionVersion}`);
    console.log(`[${requestId}] Memory limit: ${context.memoryLimitInMB}MB`);
    console.log(`[${requestId}] Remaining time: ${context.getRemainingTimeInMillis()}ms`);
    console.log(`[${requestId}] Batch size: ${BATCH_SIZE}`);

    try {
        // Get current checkpoint
        const checkpoint = await getCheckpoint();
        console.log(`[${requestId}] Current checkpoint:`, checkpoint);

        // List new embedding files from S3
        const newObjects = await listNewEmbeddings(checkpoint);
        console.log(`[${requestId}] Found ${newObjects.length} new embedding files`);

        if (newObjects.length === 0) {
            console.log(`[${requestId}] No new embedding files to process`);
            return;
        }

        let processedCount = 0;
        let lastContiguousKey: string | null = null;
        let lastContiguousTimestamp: string | null = null;

        // Process files sequentially to maintain order
        for (const obj of newObjects) {
            try {
                console.log(`[${requestId}] Queuing embedding file for processing: ${obj.Key}`);

                // Create processing task message
                const task: VectorProcessingTask = {
                    embeddingS3Key: obj.Key!,
                    embeddingS3Bucket: EMBEDDINGS_BUCKET_NAME,
                    timestamp: extractTimestampFromKey(obj.Key!),
                    taskId: `${requestId}-${processedCount}`
                };

                // Send to SQS for processing
                await sendToProcessingQueue(task, requestId);
                
                processedCount++;
                lastContiguousKey = obj.Key!;
                lastContiguousTimestamp = extractTimestampFromKey(obj.Key!);

                console.log(`[${requestId}] ✅ Queued embedding file: ${obj.Key}`);
            } catch (error) {
                console.error(`[${requestId}] ❌ Failed to queue ${obj.Key}:`, error);
                break;
            }
        }

        // Update checkpoint only to the last contiguous processed file
        if (processedCount > 0 && lastContiguousKey) {
            await updateCheckpoint(lastContiguousTimestamp!, lastContiguousKey);
            console.log(`[${requestId}] 📍 Updated checkpoint to: ${lastContiguousTimestamp} (contiguous processing)`);
        }

        const totalDuration = Date.now() - startTime;
        console.log(`[${requestId}] ✅ Embeddings polling complete. Queued ${processedCount}/${newObjects.length} files in ${totalDuration}ms`);

    } catch (error) {
        console.error(`[${requestId}] ❌ Embeddings polling failed:`, error);
        throw error;
    }
};

/**
 * Get the current checkpoint from DynamoDB
 */
async function getCheckpoint(): Promise<CheckpointRecord | null> {
    try {
        const response = await dynamoClient.send(new GetItemCommand({
            TableName: CHECKPOINT_TABLE_NAME,
            Key: marshall({ serviceId: SERVICE_ID })
        }));

        if (!response.Item) {
            console.log('📍 No existing checkpoint found, starting from beginning');
            return null;
        }

        return unmarshall(response.Item) as CheckpointRecord;
    } catch (error) {
        console.error('❌ Failed to get checkpoint:', error);
        throw error;
    }
}

/**
 * Update the checkpoint in DynamoDB
 */
async function updateCheckpoint(timestamp: string, objectKey: string): Promise<void> {
    try {
        const record: CheckpointRecord = {
            serviceId: SERVICE_ID,
            lastProcessedTimestamp: timestamp,
            lastProcessedKey: objectKey,
            updatedAt: new Date().toISOString()
        };

        await dynamoClient.send(new PutItemCommand({
            TableName: CHECKPOINT_TABLE_NAME,
            Item: marshall(record)
        }));

    } catch (error) {
        console.error('❌ Failed to update checkpoint:', error);
        throw error;
    }
}

/**
 * List new embedding files since the last checkpoint
 */
async function listNewEmbeddings(checkpoint: CheckpointRecord | null): Promise<any[]> {
    try {
        const response = await s3Client.send(new ListObjectsV2Command({
            Bucket: EMBEDDINGS_BUCKET_NAME,
            MaxKeys: BATCH_SIZE,
            StartAfter: checkpoint?.lastProcessedKey
        }));

        if (!response.Contents) {
            return [];
        }

        // Filter to only timestamp-hash format files and sort by timestamp
        const validFiles = response.Contents
            .filter(obj => obj.Key && isTimestampHashKey(obj.Key))
            .sort((a, b) => (a.Key || '').localeCompare(b.Key || ''));

        // If we have a checkpoint, filter to files after the checkpoint timestamp
        if (checkpoint) {
            return validFiles.filter(obj => {
                const fileTimestamp = extractTimestampFromKey(obj.Key!);
                return fileTimestamp > checkpoint.lastProcessedTimestamp;
            });
        }

        return validFiles;
    } catch (error) {
        console.error('❌ Failed to list new embeddings:', error);
        throw error;
    }
}

/**
 * Check if the S3 key follows the timestamp-hash pattern
 */
function isTimestampHashKey(key: string): boolean {
    // Pattern: YYYY-MM-DDTHH:mm:ss.sssZ-{hash}.json
    const timestampHashPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z-[a-f0-9]{64}\.json$/;
    return timestampHashPattern.test(key);
}

/**
 * Extract timestamp from S3 key
 */
function extractTimestampFromKey(key: string): string {
    // Extract timestamp from: YYYY-MM-DDTHH:mm:ss.sssZ-{hash}.json
    const match = key.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)-/);
    if (!match) {
        throw new Error(`Invalid timestamp format in key: ${key}`);
    }
    return match[1];
}

/**
 * Send processing task to SQS queue
 */
async function sendToProcessingQueue(task: VectorProcessingTask, requestId: string): Promise<void> {
    try {
        await sqsClient.send(new SendMessageCommand({
            QueueUrl: VECTOR_PROCESSING_QUEUE_URL,
            MessageBody: JSON.stringify(task),
            MessageAttributes: {
                'embeddings-s3-key': {
                    DataType: 'String',
                    StringValue: task.embeddingS3Key
                },
                'timestamp': {
                    DataType: 'String',
                    StringValue: task.timestamp
                },
                'task-id': {
                    DataType: 'String',
                    StringValue: task.taskId
                }
            }
        }));

        console.log(`[${requestId}] 📤 Sent task to processing queue: ${task.embeddingS3Key}`);
    } catch (error) {
        console.error(`[${requestId}] ❌ Failed to send task to queue:`, error);
        throw error;
    }
} 