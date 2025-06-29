import { SQSEvent, SQSRecord, Context, SQSBatchResponse, SQSBatchItemFailure, S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });

const VECTOR_METADATA_BUCKET = process.env.VECTOR_METADATA_BUCKET!;
const EMBEDDINGS_BUCKET_NAME = process.env.EMBEDDINGS_BUCKET_NAME!;

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
    console.log(`[${requestId}] Records to process: ${event.Records.length}`);

    const batchItemFailures: SQSBatchItemFailure[] = [];
    
    const processPromises = event.Records.map(async (record) => {
        const recordStartTime = Date.now();
        try {
            console.log(`[${requestId}] Processing SQS record: ${record.messageId}`);
            const processingId = await processVectorTask(record, requestId);
            
            const recordDuration = Date.now() - recordStartTime;
            console.log(`[${requestId}] ✅ Successfully processed record ${record.messageId} (processing id: ${processingId}) in ${recordDuration}ms`);
            return { success: true, messageId: record.messageId, processingId };
            
        } catch (error) {
            const recordDuration = Date.now() - recordStartTime;
            console.error(`[${requestId}] ❌ Failed to process record ${record.messageId} after ${recordDuration}ms:`, error);
            
            batchItemFailures.push({
                itemIdentifier: record.messageId
            });
            
            return { success: false, messageId: record.messageId, error };
        }
    });

    await Promise.allSettled(processPromises);

    console.log(`[${requestId}] === Vector Processor Lambda Completed ===`);

    return {
        batchItemFailures
    };
};

/**
 * Process a single vector storage task from SQS (S3 embedding status object)
 */
async function processVectorTask(record: SQSRecord, requestId: string): Promise<string> {
    const startTime = Date.now();
    
    console.log(`[${requestId}] 🔍 Step 1: Parsing S3 event from SQS...`);
    const s3Event: S3Event = JSON.parse(record.body);

    if (!s3Event.Records || s3Event.Records.length === 0) {
        console.warn(`[${requestId}] SQS record ${record.messageId} does not contain S3 event records.`);
        return "No-S3-Event";
    }

    let documentId = "not-processed";
    for (const s3Record of s3Event.Records) {
        const bucketName = s3Record.s3.bucket.name;
        const objectKey = decodeURIComponent(s3Record.s3.object.key.replace(/\+/g, ' '));
        
        console.log(`[${requestId}] 📋 S3 object details: Bucket: ${bucketName}, Key: ${objectKey}`);

        console.log(`[${requestId}] 🔍 Step 2: Downloading embedding status object...`);
        const statusObject = await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: objectKey }));
        const embeddingStatus = JSON.parse(await statusObject.Body!.transformToString());
        documentId = embeddingStatus.documentId;
        console.log(`[${requestId}] ✅ Step 2 PASSED: Embedding status object downloaded for document ${documentId}`);

        console.log(`[${requestId}] 🔍 Step 3: Creating consolidated vector metadata record...`);
        const vectorId = randomUUID();
        const vectorMetadata = {
            documentId: documentId,
            vectorId: vectorId,
            status: 'indexed',
            processedAt: new Date().toISOString(),
            homeServerDomain: process.env.HOME_SERVER_DOMAIN,
            embeddingSummary: embeddingStatus.summary,
            chunkReferences: embeddingStatus.chunkReferences,
            originalDocument: embeddingStatus.originalDocument,
            metadata: {
                sourceStatusObjectKey: objectKey,
                sourceBucket: bucketName,
                indexedAt: new Date().toISOString(),
                processingTimeMs: Date.now() - startTime
            }
        };

        const metadataKey = `vector-metadata/${documentId}/${vectorId}.json`;
        await s3Client.send(new PutObjectCommand({
            Bucket: VECTOR_METADATA_BUCKET,
            Key: metadataKey,
            Body: JSON.stringify(vectorMetadata, null, 2),
            ContentType: 'application/json'
        }));
        console.log(`[${requestId}] ✅ Step 3 PASSED: Stored vector metadata at ${metadataKey}`);

        console.log(`[${requestId}] 🔍 Step 4: Cleaning up embedding status object...`);
        await s3Client.send(new DeleteObjectCommand({
            Bucket: bucketName,
            Key: objectKey
        }));
        console.log(`[${requestId}] ✅ Step 4 PASSED: Status object cleaned up`);
    }

    const totalDuration = Date.now() - startTime;
    console.log(`[${requestId}] ✅ Vector storage task completed successfully in ${totalDuration}ms`);
    return documentId;
}

// [CLEANUP] The following functions are now obsolete and have been removed:
// - processAllChunksForVectorStorage
// - downloadEmbeddingFile
// - storeVectorIndexEntry 