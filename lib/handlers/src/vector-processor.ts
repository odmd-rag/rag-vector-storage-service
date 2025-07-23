import { SQSEvent, SQSRecord, Context, SQSBatchResponse, SQSBatchItemFailure, S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { HttpRequest } from '@aws-sdk/protocol-http';
import { fromUtf8 } from '@aws-sdk/util-utf8';
import { randomUUID } from 'crypto';
import { 
    UpsertRequestSchema, 
    UpsertRequest, 
    UpsertChunk 
} from './schemas/upsert-request.schema';
import { 
    VectorMetadataSchema, 
    VectorMetadata 
} from './schemas/vector-metadata.schema';

const s3Client = new S3Client();
const stsClient = new STSClient();

const VECTOR_METADATA_BUCKET = process.env.VECTOR_METADATA_BUCKET!;
const EMBEDDINGS_BUCKET_NAME = process.env.EMBEDDINGS_BUCKET_NAME!;
const HOME_SERVER_DOMAIN = process.env.HOME_SERVER_DOMAIN;

if (!HOME_SERVER_DOMAIN) {
    throw new Error("HOME_SERVER_DOMAIN environment variable is not set.");
}

/**
 * Create and sign an HTTP request using AWS SigV4
 */
/**
 * Create AWS SigV4 headers that can be validated by AWS STS
 * This implements the HashiCorp Vault approach: create headers for STS validation
 */
async function createSignedRequest(
    method: string, 
    url: string, 
    body: string, 
    requestId: string
): Promise<{ url: string; headers: Record<string, string> }> {
    try {
        console.log(`[${requestId}] Creating AWS SigV4 signed headers for STS validation`);
        
        // Get current AWS credentials and region
        const region = process.env.AWS_REGION || 'us-east-1';
        const credentials = {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
            sessionToken: process.env.AWS_SESSION_TOKEN
        };
        
        // Parse URL
        const urlObj = new URL(url);
        
        // Create a GetCallerIdentity request that STS can validate
        // This is the key insight: we create STS-compatible headers
        const stsRequest = new HttpRequest({
            method: 'POST',
            protocol: 'https:',
            hostname: `sts.${region}.amazonaws.com`,
            port: 443,
            path: '/',
            headers: {
                'Content-Type': 'application/x-amz-json-1.1',
                'X-Amz-Target': 'AWSSecurityTokenServiceV20110615.GetCallerIdentity',
                'Host': `sts.${region}.amazonaws.com`
            },
            body: fromUtf8('{}')
        });

        // Create STS signer
        const stsSigner = new SignatureV4({
            service: 'sts',
            region,
            credentials
        });

        // Sign the STS request to get valid headers
        const signedStsRequest = await stsSigner.sign(stsRequest);
        
        // Extract the signed headers that we can forward
        const stsHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(signedStsRequest.headers)) {
            stsHeaders[key] = Array.isArray(value) ? value.join(',') : value;
        }

        // Now create the actual request headers by combining STS auth with our request
        const finalHeaders: Record<string, string> = {
            // Use STS authentication headers
            'Authorization': stsHeaders['authorization'] || stsHeaders['Authorization'],
            'X-Amz-Date': stsHeaders['x-amz-date'] || stsHeaders['X-Amz-Date'],
            'X-Amz-Content-Sha256': stsHeaders['x-amz-content-sha256'] || stsHeaders['X-Amz-Content-Sha256'],
            
            // Add our request-specific headers
            'Content-Type': 'application/json',
            'Host': urlObj.hostname,
            'x-request-id': requestId,
            'User-Agent': 'rag-vector-storage-service/1.0.0'
        };

        // Include security token if present (for temporary credentials)
        if (credentials.sessionToken) {
            finalHeaders['X-Amz-Security-Token'] = credentials.sessionToken;
        }
        
        // Validate that we have all required headers
        if (!finalHeaders['Authorization']) {
            throw new Error('Missing Authorization header in signed request');
        }
        if (!finalHeaders['X-Amz-Date']) {
            throw new Error('Missing X-Amz-Date header in signed request');
        }
        if (!finalHeaders['X-Amz-Content-Sha256']) {
            throw new Error('Missing X-Amz-Content-Sha256 header in signed request');
        }
        
        console.log(`[${requestId}] ✅ Created STS-compatible signed headers`);
        console.log(`[${requestId}] Auth headers: ${Object.keys(finalHeaders).filter(k => k.toLowerCase().includes('amz')).join(', ')}`);
        console.log(`[${requestId}] Region: ${region}, Has session token: ${!!credentials.sessionToken}`);
        
        return { 
            url,
            headers: finalHeaders
        };
        
    } catch (error) {
        console.error(`[${requestId}] ❌ Failed to create signed headers:`, error);
        throw new Error(`Failed to create signed headers: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}


// Represents the structure of the embedding-status/{documentId}.json object
interface EmbeddingStatus {
    documentId: string;
    processingId: string;
    originalDocument: {
        bucketName: string;
        objectKey: string;
        contentType: string;
        fileSize: number;
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
    embeddingTimestamp: string;
    embeddingModel: string;
    status: 'completed';
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

            const upsertPayloads = await prepareUpsertPayloads(embeddingStatus, requestId);
            console.log(`[${requestId}] Prepared ${upsertPayloads.length} chunks for upsert.`);

            // Validate the upsert request against schema before sending
            const upsertRequestData: UpsertRequest = { chunks: upsertPayloads };
            try {
                UpsertRequestSchema.parse(upsertRequestData);
                console.log(`[${requestId}] ✅ Upsert request schema validation passed`);
            } catch (validationError) {
                console.error(`[${requestId}] ❌ Upsert request schema validation failed:`, validationError);
                throw new Error(`Upsert request schema validation failed: ${validationError}`);
            }

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
    console.log(`[${requestId}] Downloading from s3://${bucket}/${key}`);
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const response = await s3Client.send(command);
    const bodyString = await response.Body!.transformToString();
    return JSON.parse(bodyString) as T;
}

/**
 * Downloads a text object from S3.
 */
async function downloadS3TextObject(bucket: string, key: string, requestId: string): Promise<string> {
    console.log(`[${requestId}] Downloading from s3://${bucket}/${key}`);
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const response = await s3Client.send(command);
    return response.Body!.transformToString();
}

/**
 * Downloads chunk content and embeddings to prepare the payload for the vector server.
 */
async function prepareUpsertPayloads(status: EmbeddingStatus, requestId: string): Promise<UpsertChunk[]> {
    const payloads: UpsertChunk[] = [];

    for (const ref of status.chunkReferences) {
        try {
            const [content, embedding] = await Promise.all([
                downloadS3TextObject(EMBEDDINGS_BUCKET_NAME, ref.s3_path_content, requestId),
                downloadS3JsonObject<number[]>(EMBEDDINGS_BUCKET_NAME, ref.s3_path_embedding, requestId)
            ]);

            payloads.push({
                documentId: status.documentId,
                s3Bucket: status.originalDocument.bucketName,
                s3Key: status.originalDocument.objectKey,
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
 * Sends the prepared vector data to the home vector server using AWS SigV4 authentication.
 */
async function upsertVectorsToHomeServer(payloads: UpsertChunk[], requestId: string): Promise<any> {
    if (payloads.length === 0) {
        console.warn(`[${requestId}] No payloads to upsert. Skipping.`);
        return { success: true, message: "No data to upsert." };
    }
    
    const url = `https://${HOME_SERVER_DOMAIN}/vector/upsert`;
    console.log(`[${requestId}] Posting ${payloads.length} vectors to ${url} with SigV4 authentication`);

    try {
        // Prepare request body
        const requestBody = JSON.stringify({ chunks: payloads });
        
        // Create signed request
        const signedRequest = await createSignedRequest('POST', url, requestBody, requestId);
        
        // Make the authenticated request
        const response = await fetch(url, {
            method: 'POST',
            headers: signedRequest.headers,
            body: requestBody,
        });

        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`[${requestId}] Error from home server: ${response.status} ${response.statusText}`, errorBody);
            throw new Error(`Failed to upsert vectors: ${response.status} ${response.statusText} - ${errorBody}`);
        }

        console.log(`[${requestId}] ✅ Home server response: ${response.status}`);
        const result = await response.json();
        console.log(`[${requestId}] Upsert result: ${result.message || 'Success'}`);
        
        return result;
        
    } catch (error) {
        console.error(`[${requestId}] ❌ Failed to upsert vectors to home server:`, error);
        throw error;
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
    const vectorMetadataData: VectorMetadata = {
        documentId: embeddingStatus.documentId,
        status: 'indexed',
        indexedAt: new Date().toISOString(),
        processingTimeMs: Date.now() - startTime,
        homeServerDomain: HOME_SERVER_DOMAIN!,
        embeddingSummary: embeddingStatus.summary,
        originalDocument: {
            bucket: embeddingStatus.originalDocument.bucketName,
            key: embeddingStatus.originalDocument.objectKey
        },
        upsertResult,
        metadata: {
            sourceStatusObjectKey: sourceKey,
            sourceBucket: sourceBucket,
            requestId: requestId,
        }
    };

    // Validate the vector metadata against schema before storing
    try {
        VectorMetadataSchema.parse(vectorMetadataData);
        console.log(`[${requestId}] ✅ Vector metadata schema validation passed`);
    } catch (validationError) {
        console.error(`[${requestId}] ❌ Vector metadata schema validation failed:`, validationError);
        throw new Error(`Vector metadata schema validation failed: ${validationError}`);
    }

    await s3Client.send(new PutObjectCommand({
        Bucket: VECTOR_METADATA_BUCKET,
        Key: metadataKey,
        Body: JSON.stringify(vectorMetadataData, null, 2),
        ContentType: 'application/json'
    }));
}

// [CLEANUP] The following functions are now obsolete and have been removed:
// - processAllChunksForVectorStorage
// - downloadEmbeddingFile
// - storeVectorIndexEntry 