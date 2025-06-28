import { SQSEvent, SQSRecord, Context, SQSBatchResponse, SQSBatchItemFailure } from 'aws-lambda';
import { S3Client, GetObjectCommand, PutObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

// Initialize AWS clients
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });

// Environment variables
const VECTOR_INDEX_BUCKET = process.env.VECTOR_INDEX_BUCKET!;

interface S3EventRecord {
    eventVersion: string;
    eventSource: string;
    eventTime: string;
    eventName: string;
    s3: {
        s3SchemaVersion: string;
        configurationId?: string;
        bucket: {
            name: string;
            arn: string;
        };
        object: {
            key: string;
            size: number;
            eTag: string;
        };
    };
}

interface EmbeddingResult {
    documentId: string;
    processingId: string;
    chunkId: string;
    chunkIndex: number;
    embedding: number[];
    content: string;
    originalDocumentInfo: {
        bucketName: string;
        objectKey: string;
        contentType: string;
        fileSize: number;
    };
    embeddingMetadata: {
        model: string;
        dimensions: number;
        tokenCount: number;
        processingTimeMs: number;
    };
    processedAt: string;
    source: string;
}

interface VectorIndexEntry {
    documentId: string;
    processingId: string;
    chunkId: string;
    chunkIndex: number;
    vector: number[];
    content: string;
    metadata: {
        originalDocumentInfo: {
            bucketName: string;
            objectKey: string;
            contentType: string;
            fileSize: number;
        };
        embeddingMetadata: {
            model: string;
            dimensions: number;
            tokenCount: number;
            processingTimeMs: number;
        };
        indexedAt: string;
        vectorId: string;
        source: string;
    };
}

/**
 * Lambda handler for processing vector storage tasks from SQS (S3 events)
 */
export const handler = async (event: SQSEvent, context: Context): Promise<SQSBatchResponse> => {
    const startTime = Date.now();
    const requestId = context.awsRequestId;
    
    console.log(`[${requestId}] === Vector Processor Lambda Started ===`);
    console.log(`[${requestId}] Function: ${context.functionName}:${context.functionVersion}`);
    console.log(`[${requestId}] Memory limit: ${context.memoryLimitInMB}MB`);
    console.log(`[${requestId}] Remaining time: ${context.getRemainingTimeInMillis()}ms`);
    console.log(`[${requestId}] Records to process: ${event.Records.length}`);

    const batchItemFailures: SQSBatchItemFailure[] = [];
    const maxConcurrency = Math.min(event.Records.length, 8); // Process max 8 vectors in parallel
    
    // Process records in batches with concurrency control
    const processPromises = event.Records.map(async (record) => {
        const recordStartTime = Date.now();
        try {
            console.log(`[${requestId}] Processing SQS record: ${record.messageId}`);
            const vectorId = await processVectorTask(record, requestId);
            
            const recordDuration = Date.now() - recordStartTime;
            console.log(`[${requestId}] ✅ Successfully processed record ${record.messageId} (vector: ${vectorId}) in ${recordDuration}ms`);
            return { success: true, messageId: record.messageId, vectorId };
            
        } catch (error) {
            const recordDuration = Date.now() - recordStartTime;
            console.error(`[${requestId}] ❌ Failed to process record ${record.messageId} after ${recordDuration}ms:`, error);
            
            // Add to batch failures for individual retry
            batchItemFailures.push({
                itemIdentifier: record.messageId
            });
            
            return { success: false, messageId: record.messageId, error };
        }
    });

    // Process with concurrency limit
    const results = [];
    for (let i = 0; i < processPromises.length; i += maxConcurrency) {
        const batch = processPromises.slice(i, i + maxConcurrency);
        const batchResults = await Promise.allSettled(batch);
        results.push(...batchResults);
    }

    const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
    const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success)).length;

    const totalDuration = Date.now() - startTime;
    console.log(`[${requestId}] === Vector Processor Lambda Completed ===`);
    console.log(`[${requestId}] Total execution time: ${totalDuration}ms`);
    console.log(`[${requestId}] Processed: ${successful}/${event.Records.length}`);
    console.log(`[${requestId}] Failed: ${failed}/${event.Records.length}`);
    console.log(`[${requestId}] Batch failures: ${batchItemFailures.length}`);
    console.log(`[${requestId}] Final remaining time: ${context.getRemainingTimeInMillis()}ms`);

    return {
        batchItemFailures
    };
};

/**
 * Process a single vector storage task from SQS (S3 event)
 */
async function processVectorTask(record: SQSRecord, requestId: string): Promise<string> {
    const startTime = Date.now();
    
    try {
        console.log(`[${requestId}] 🔍 Step 1: Parsing S3 event from SQS message...`);
        const s3Event: S3EventRecord = JSON.parse(record.body);
        
        console.log(`[${requestId}] ✅ Step 1 PASSED: S3 event parsed successfully`);
        console.log(`[${requestId}] 📋 S3 event details:`);
        console.log(`[${requestId}]   Event: ${s3Event.eventName}`);
        console.log(`[${requestId}]   Bucket: ${s3Event.s3.bucket.name}`);
        console.log(`[${requestId}]   Object key: ${s3Event.s3.object.key}`);
        console.log(`[${requestId}]   Object size: ${s3Event.s3.object.size} bytes`);
        console.log(`[${requestId}]   Event time: ${s3Event.eventTime}`);

        // Extract document and chunk IDs from S3 key (embeddings/documentId/chunkId.json)
        const keyParts = s3Event.s3.object.key.split('/');
        if (keyParts.length !== 3 || keyParts[0] !== 'embeddings') {
            throw new Error(`Invalid S3 key format: ${s3Event.s3.object.key}. Expected: embeddings/documentId/chunkId.json`);
        }
        
        const documentId = keyParts[1];
        const chunkFileName = keyParts[2];
        const chunkId = chunkFileName.replace('.json', '');

        console.log(`[${requestId}] 🔍 Step 2: Downloading embedding file from S3...`);
        
        // Download the embedding file
        const embeddingResult = await downloadEmbeddingFile(
            s3Event.s3.bucket.name,
            s3Event.s3.object.key,
            requestId
        );

        console.log(`[${requestId}] ✅ Step 2 PASSED: Embedding file downloaded`);
        console.log(`[${requestId}]   Document ID: ${embeddingResult.documentId}`);
        console.log(`[${requestId}]   Chunk ID: ${embeddingResult.chunkId}`);
        console.log(`[${requestId}]   Chunk index: ${embeddingResult.chunkIndex}`);
        console.log(`[${requestId}]   Vector dimensions: ${embeddingResult.embedding.length}`);
        console.log(`[${requestId}]   Content length: ${embeddingResult.content.length} chars`);

        console.log(`[${requestId}] 🔍 Step 3: Creating vector index entry...`);
        
        // Create vector index entry
        const vectorId = randomUUID();
        const vectorIndexEntry: VectorIndexEntry = {
            documentId: embeddingResult.documentId,
            processingId: embeddingResult.processingId,
            chunkId: embeddingResult.chunkId,
            chunkIndex: embeddingResult.chunkIndex,
            vector: embeddingResult.embedding,
            content: embeddingResult.content,
            metadata: {
                originalDocumentInfo: embeddingResult.originalDocumentInfo,
                embeddingMetadata: embeddingResult.embeddingMetadata,
                indexedAt: new Date().toISOString(),
                vectorId,
                source: embeddingResult.source
            }
        };

        console.log(`[${requestId}] ✅ Step 3 PASSED: Vector index entry created`);
        console.log(`[${requestId}] 🔍 Step 4: Storing vector index entry...`);

        // Store vector index entry
        const indexKey = `vectors/${embeddingResult.documentId}/${vectorId}.json`;
        await storeVectorIndexEntry(indexKey, vectorIndexEntry, requestId);

        const totalDuration = Date.now() - startTime;
        console.log(`[${requestId}] ✅ Step 4 PASSED: Vector index entry stored`);
        console.log(`[${requestId}] ✅ Vector storage task completed successfully in ${totalDuration}ms`);
        console.log(`[${requestId}]   Vector ID: ${vectorId}`);
        console.log(`[${requestId}]   Dimensions: ${embeddingResult.embedding.length}`);
        console.log(`[${requestId}]   Index location: ${indexKey}`);
        
        return vectorId;
        
    } catch (error) {
        const totalDuration = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[${requestId}] ❌ Failed to process vector task after ${totalDuration}ms:`, error);
        throw error;
    }
}

/**
 * Download embedding file from S3
 */
async function downloadEmbeddingFile(
    bucketName: string,
    objectKey: string,
    requestId: string
): Promise<EmbeddingResult> {
    console.log(`[${requestId}] 📥 Downloading embedding file: s3://${bucketName}/${objectKey}`);

    try {
        const getObjectResponse = await s3Client.send(
            new GetObjectCommand({
                Bucket: bucketName,
                Key: objectKey
            })
        );

        if (!getObjectResponse.Body) {
            throw new Error('Empty response body from S3');
        }

        const embeddingData = await getObjectResponse.Body.transformToString();
        const embeddingResult: EmbeddingResult = JSON.parse(embeddingData);

        console.log(`[${requestId}] ✅ Embedding file downloaded and parsed successfully`);
        console.log(`[${requestId}]   File size: ${embeddingData.length} bytes`);
        console.log(`[${requestId}]   Vector dimensions: ${embeddingResult.embedding.length}`);

        return embeddingResult;

    } catch (error) {
        console.error(`[${requestId}] ❌ Failed to download embedding file:`, error);
        throw new Error(`Failed to download embedding file from s3://${bucketName}/${objectKey}: ${error}`);
    }
}

/**
 * Store vector index entry in S3
 */
async function storeVectorIndexEntry(
    objectKey: string,
    vectorIndexEntry: VectorIndexEntry,
    requestId: string
): Promise<void> {
    console.log(`[${requestId}] 💾 Storing vector index entry: ${objectKey}`);

    try {
        await s3Client.send(
            new PutObjectCommand({
                Bucket: VECTOR_INDEX_BUCKET,
                Key: objectKey,
                Body: JSON.stringify(vectorIndexEntry, null, 2),
                ContentType: 'application/json',
                Metadata: {
                    'processing-status': 'completed',
                    'document-id': vectorIndexEntry.documentId,
                    'chunk-id': vectorIndexEntry.chunkId,
                    'vector-id': vectorIndexEntry.metadata.vectorId,
                    'dimensions': vectorIndexEntry.vector.length.toString(),
                    'indexed-at': vectorIndexEntry.metadata.indexedAt,
                    'source': vectorIndexEntry.metadata.source
                }
            })
        );

        console.log(`[${requestId}] ✅ Vector index entry stored successfully`);

    } catch (error) {
        console.error(`[${requestId}] ❌ Failed to store vector index entry:`, error);
        throw new Error(`Failed to store vector index entry to s3://${VECTOR_INDEX_BUCKET}/${objectKey}: ${error}`);
    }
} 