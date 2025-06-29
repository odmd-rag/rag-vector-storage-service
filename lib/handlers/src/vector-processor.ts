import { SQSEvent, SQSRecord, Context, SQSBatchResponse, SQSBatchItemFailure, S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });

const VECTOR_METADATA_BUCKET = process.env.VECTOR_METADATA_BUCKET!;
const HOME_SERVER_DOMAIN = process.env.HOME_SERVER_DOMAIN!;

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
    const maxConcurrency = Math.min(event.Records.length, 8);
    
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
            
            batchItemFailures.push({
                itemIdentifier: record.messageId
            });
            
            return { success: false, messageId: record.messageId, error };
        }
    });

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
 * Process a single vector storage task from SQS (S3 embedding status object)
 */
async function processVectorTask(record: SQSRecord, requestId: string): Promise<string> {
    const startTime = Date.now();
    
    try {
        console.log(`[${requestId}] 🔍 Step 1: Parsing S3 event from SQS...`);
        const s3Event: S3Event = JSON.parse(record.body);

        for (const s3Record of s3Event.Records) {
            const bucketName = s3Record.s3.bucket.name;
            const objectKey = decodeURIComponent(s3Record.s3.object.key.replace(/\+/g, ' '));
            
            console.log(`[${requestId}] ✅ Step 1 PASSED: S3 event parsed successfully`);
            console.log(`[${requestId}] 📋 S3 object details:`);
            console.log(`[${requestId}]   Bucket: ${bucketName}`);
            console.log(`[${requestId}]   Object key: ${objectKey}`);

            // Step 2: Download embedding status object
            console.log(`[${requestId}] 🔍 Step 2: Downloading embedding status object...`);
            const statusObject = await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: objectKey }));
            const embeddingStatus = JSON.parse(await statusObject.Body!.transformToString());

            console.log(`[${requestId}] ✅ Step 2 PASSED: Embedding status object downloaded`);
            console.log(`[${requestId}]   Document ID: ${embeddingStatus.documentId}`);
            console.log(`[${requestId}]   Status: ${embeddingStatus.status}`);
            console.log(`[${requestId}]   Total chunks: ${embeddingStatus.summary.totalChunks}`);
            console.log(`[${requestId}]   Chunk references: ${embeddingStatus.chunkReferences.length}`);

            // Step 3: Process document for vector storage
            console.log(`[${requestId}] 🔍 Step 3: Processing document for vector storage...`);
            const vectorId = await processDocumentForVectorStorage(embeddingStatus, requestId);

            // Step 4: Clean up embedding status object
            console.log(`[${requestId}] 🔍 Step 4: Cleaning up embedding status object...`);
            await s3Client.send(new DeleteObjectCommand({
                Bucket: bucketName,
                Key: objectKey
            }));

            const totalDuration = Date.now() - startTime;
            console.log(`[${requestId}] ✅ Step 4 PASSED: Status object cleaned up`);
            console.log(`[${requestId}] ✅ Vector storage task completed successfully in ${totalDuration}ms`);
            console.log(`[${requestId}]   Document: ${embeddingStatus.documentId}`);
            console.log(`[${requestId}]   Vector processing ID: ${vectorId}`);
            
            return vectorId;
        }
        
        throw new Error("No S3 records found in the event.");
        
    } catch (error) {
        const totalDuration = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[${requestId}] ❌ Failed to process vector task after ${totalDuration}ms:`, error);
        throw error;
    }
}

/**
 * Process a document for vector storage by creating a metadata entry
 */
async function processDocumentForVectorStorage(
    embeddingStatus: any,
    requestId: string
): Promise<string> {
    const startTime = Date.now();
    
    try {
        console.log(`[${requestId}] 🔍 Creating vector storage metadata for document: ${embeddingStatus.documentId}`);
        
        const vectorId = randomUUID();
        const vectorMetadata = {
            documentId: embeddingStatus.documentId,
            vectorId: vectorId,
            status: 'indexed',
            processedAt: new Date().toISOString(),
            homeServerDomain: HOME_SERVER_DOMAIN,
            embeddingSummary: embeddingStatus.summary,
            chunkReferences: embeddingStatus.chunkReferences,
            originalDocument: embeddingStatus.originalDocument,
            metadata: {
                indexedAt: new Date().toISOString(),
                processingTimeMs: Date.now() - startTime
            }
        };

        const metadataKey = `vector-metadata/${embeddingStatus.documentId}/${vectorId}.json`;
        await s3Client.send(new PutObjectCommand({
            Bucket: VECTOR_METADATA_BUCKET,
            Key: metadataKey,
            Body: JSON.stringify(vectorMetadata, null, 2),
            ContentType: 'application/json',
            Metadata: {
                'document-id': embeddingStatus.documentId,
                'vector-id': vectorId,
                'status': 'indexed',
                'indexed-at': new Date().toISOString(),
                'home-server-domain': HOME_SERVER_DOMAIN
            }
        }));

        const totalDuration = Date.now() - startTime;
        console.log(`[${requestId}] ✅ Vector storage metadata created in ${totalDuration}ms`);
        console.log(`[${requestId}]   Vector ID: ${vectorId}`);
        console.log(`[${requestId}]   Metadata location: ${metadataKey}`);
        
        return vectorId;
        
    } catch (error) {
        const totalDuration = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[${requestId}] ❌ Failed to process document for vector storage after ${totalDuration}ms:`, error);
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
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to download embedding file from s3: ${errorMessage}`);
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
                Bucket: VECTOR_METADATA_BUCKET,
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
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to store vector index entry to s3: ${errorMessage}`);
    }
} 