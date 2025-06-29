import { SQSEvent, SQSRecord, Context, SQSBatchResponse, SQSBatchItemFailure, S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });

const VECTOR_METADATA_BUCKET = process.env.VECTOR_METADATA_BUCKET!;
const EMBEDDINGS_BUCKET_NAME = process.env.EMBEDDINGS_BUCKET_NAME!;
const HOME_SERVER_DOMAIN = process.env.HOME_SERVER_DOMAIN;

if (!HOME_SERVER_DOMAIN) {
    throw new Error("HOME_SERVER_DOMAIN environment variable is not set.");
}

// Matches the contract of the home-vector-server
interface UpsertRequest {
    documentId: string;
    s3Bucket: string;
    s3Key: string;
    chunkId: string;
    text: string;
    vector: number[];
    metadata: Record<string, any>;
}

// Represents the structure of the embedding-status/{documentId}.json object
interface EmbeddingStatus {
    documentId: string;
    processingId: string;
    originalDocument?: {
        bucket: string;
        key: string;
    };
    summary: {
        totalChunks: number;
        model: string;
        totalTokens: number;
    };
    chunkReferences: {
        chunkId: string;
        chunkIndex: number;
        s3_path_embedding: string;
        s3_path_content: string;
    }[];
}

/**
 * Lambda handler for processing vector storage tasks from SQS.
 */
export const handler = async (event: SQSEvent, context: Context): Promise<SQSBatchResponse> => {
    const requestId = context.awsRequestId;
    console.log(`[${requestId}] Vector Processor Lambda started. Processing ${event.Records.length} records.`);

    const batchItemFailures: SQSBatchItemFailure[] = [];

    for (const record of event.Records) {
        try {
            await processVectorTask(record, requestId);
        } catch (error) {
            console.error(`[${requestId}] Fatal error processing record ${record.messageId}.`, error);
            batchItemFailures.push({ itemIdentifier: record.messageId });
        }
    }

    console.log(`[${requestId}] Vector Processor Lambda finished.`);
    return { batchItemFailures };
};

/**
 * Process a single S3 event notification from an SQS record.
 */
async function processVectorTask(record: SQSRecord, requestId: string): Promise<void> {
    const s3Event: S3Event = JSON.parse(record.body);

    if (!s3Event.Records || s3Event.Records.length === 0) {
        console.warn(`[${requestId}] SQS record ${record.messageId} contains no S3 event records.`);
        return;
    }

    for (const s3Record of s3Event.Records) {
        const sourceBucket = s3Record.s3.bucket.name;
        const sourceKey = decodeURIComponent(s3Record.s3.object.key.replace(/\+/g, ' '));
        console.log(`[${requestId}] Processing S3 object: s3://${sourceBucket}/${sourceKey}`);

        const startTime = Date.now();
        
        try {
            const embeddingStatus = await downloadS3JsonObject<EmbeddingStatus>(sourceBucket, sourceKey, requestId);
            const documentId = embeddingStatus.documentId;
            console.log(`[${requestId}] Successfully downloaded embedding status for document: ${documentId}`);
            console.log(`[${requestId}] Original document info:`, embeddingStatus.originalDocument);

            const upsertPayloads = await prepareUpsertPayloads(embeddingStatus, requestId);
            console.log(`[${requestId}] Prepared ${upsertPayloads.length} chunks for upsert.`);

            const upsertResult = await upsertVectorsToHomeServer(upsertPayloads, requestId);
            console.log(`[${requestId}] Successfully upserted vectors to home server.`);

            const metadataKey = `vector-metadata/${documentId}/${randomUUID()}.json`;
            await createVectorMetadata(metadataKey, embeddingStatus, upsertResult, sourceBucket, sourceKey, startTime, requestId);
            console.log(`[${requestId}] Successfully created vector metadata file: ${metadataKey}`);

            await s3Client.send(new DeleteObjectCommand({ Bucket: sourceBucket, Key: sourceKey }));
            console.log(`[${requestId}] Successfully deleted embedding status object: ${sourceKey}`);

        } catch (error) {
            console.error(`[${requestId}] Error processing S3 object ${sourceKey}.`, error);
            // Propagate error to trigger SQS retry logic
            throw error;
        }
    }
}

/**
 * Downloads and parses a JSON object from S3.
 */
async function downloadS3JsonObject<T>(bucket: string, key: string, requestId: string): Promise<T> {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const response = await s3Client.send(command);
    const bodyString = await response.Body!.transformToString();
    console.log(`downloadS3JsonObject: [${requestId}] Downloading from s3://${bucket}/${key}: ${bodyString}`);
    return JSON.parse(bodyString) as T;
}

/**
 * Downloads a text object from S3.
 */
async function downloadS3TextObject(bucket: string, key: string, requestId: string): Promise<string> {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const response = await s3Client.send(command);
    const ret = await response.Body!.transformToString();
    console.log(`downloadS3TextObject:[${requestId}] Downloading from s3://${bucket}/${key}: ${ret}`);
    return ret;
}

/**
 * Downloads chunk content and embeddings to prepare the payload for the vector server.
 */
async function prepareUpsertPayloads(status: EmbeddingStatus, requestId: string): Promise<UpsertRequest[]> {
    const payloads: UpsertRequest[] = [];

    for (const ref of status.chunkReferences) {
        try {
            const [content, embedding] = await Promise.all([
                downloadS3TextObject(EMBEDDINGS_BUCKET_NAME, ref.s3_path_content, requestId),
                downloadS3JsonObject<number[]>(EMBEDDINGS_BUCKET_NAME, ref.s3_path_embedding, requestId)
            ]);

            payloads.push({
                documentId: status.documentId,
                s3Bucket: status.originalDocument?.bucket || 'unknown',
                s3Key: status.originalDocument?.key || 'unknown',
                chunkId: ref.chunkId,
                text: content,
                vector: embedding,
                metadata: {
                    chunkIndex: ref.chunkIndex,
                    totalChunks: status.summary.totalChunks,
                    model: status.summary.model
                }
            });
        } catch (error) {
            console.error(`[${requestId}] Failed to prepare chunk ${ref.chunkId}. Skipping.`, error);
        }
    }
    return payloads;
}

/**
 * Sends the prepared vector data to the home vector server.
 */
async function upsertVectorsToHomeServer(payloads: UpsertRequest[], requestId: string): Promise<any> {
    if (payloads.length === 0) {
        console.warn(`[${requestId}] No payloads to upsert. Skipping.`);
        return { success: true, message: "No data to upsert." };
    }
    
    const url = `http://${HOME_SERVER_DOMAIN}/api/upsert`;
    console.log(`[${requestId}] Posting ${payloads.length} vectors to ${url}`);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-request-id': requestId,
        },
        body: JSON.stringify({ chunks: payloads }),
    });

    const responseText = await response.text();
    console.log(`[${requestId}] Home server response: ${response.status}`);
    
    if (!response.ok) {
        console.error(`[${requestId}] Error from home server: ${response.status} ${response.statusText}`);
        console.error(`[${requestId}] Response body: ${responseText}`);
        throw new Error(`Failed to upsert vectors: ${response.statusText}`);
    }

    // Try to parse as JSON, fall back to plain text if it fails
    try {
        return JSON.parse(responseText);
    } catch (jsonError) {
        console.warn(`[${requestId}] Response is not valid JSON, treating as plain text response`);
        console.warn(`[${requestId}] Response body: ${responseText}`);
        
        // If the response is HTML (like an error page), log it and throw an error
        if (responseText.trim().startsWith('<!DOCTYPE') || responseText.trim().startsWith('<html')) {
            console.error(`[${requestId}] Home server returned HTML instead of JSON. This usually indicates a server configuration issue.`);
            throw new Error(`Home server returned HTML instead of JSON: ${responseText.substring(0, 200)}...`);
        }
        
        // For other non-JSON responses, return a generic success response
        return { 
            success: true, 
            message: "Upsert completed", 
            rawResponse: responseText,
            note: "Response was not JSON format"
        };
    }
}

/**
 * Creates and uploads the final metadata file after successful processing.
 */
async function createVectorMetadata(
    metadataKey: string,
    embeddingStatus: EmbeddingStatus,
    upsertResult: any,
    sourceBucket: string,
    sourceKey: string,
    startTime: number,
    requestId: string
): Promise<void> {
    const vectorMetadata = {
        documentId: embeddingStatus.documentId,
        status: 'indexed',
        indexedAt: new Date().toISOString(),
        processingTimeMs: Date.now() - startTime,
        homeServerDomain: HOME_SERVER_DOMAIN,
        embeddingSummary: embeddingStatus.summary,
        originalDocument: embeddingStatus.originalDocument,
        upsertResult,
        metadata: {
            sourceStatusObjectKey: sourceKey,
            sourceBucket: sourceBucket,
            requestId: requestId,
        }
    };

    await s3Client.send(new PutObjectCommand({
        Bucket: VECTOR_METADATA_BUCKET,
        Key: metadataKey,
        Body: JSON.stringify(vectorMetadata, null, 2),
        ContentType: 'application/json'
    }));
}

// [CLEANUP] The following functions are now obsolete and have been removed:
// - processAllChunksForVectorStorage
// - downloadEmbeddingFile
// - storeVectorIndexEntry 