import { Context, SQSEvent, SQSRecord } from 'aws-lambda';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';

// Initialize AWS clients
const s3Client = new S3Client({});
const dynamoClient = new DynamoDBClient({});

// Environment variables
const OPENSEARCH_COLLECTION_ENDPOINT = process.env.OPENSEARCH_COLLECTION_ENDPOINT!;
const OPENSEARCH_INDEX_NAME = process.env.OPENSEARCH_INDEX_NAME!;
const VECTOR_METADATA_BUCKET_NAME = process.env.VECTOR_METADATA_BUCKET_NAME!;
const VECTOR_INDEX_TABLE_NAME = process.env.VECTOR_INDEX_TABLE_NAME!;
const AWS_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID!;

// OpenSearch client (initialized lazily)
let opensearchClient: Client | null = null;

// Interfaces
interface VectorProcessingTask {
    embeddingS3Key: string;
    embeddingS3Bucket: string;
    timestamp: string;
    taskId: string;
}

interface EmbeddingData {
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

interface VectorIndexRecord {
    documentId: string;
    chunkId: string;
    chunkIndex: number;
    vectorId: string;
    opensearchIndexName: string;
    indexingStatus: 'processing' | 'success' | 'failed';
    errorMessage?: string;
    indexedAt: string;
    metadata: {
        dimensions: number;
        tokenCount: number;
        embeddingModel: string;
        contentPreview: string;
    };
}

/**
 * Lambda handler for processing vector indexing tasks from SQS
 * Downloads embedding files from S3 and indexes them into OpenSearch Serverless
 */
export const handler = async (event: SQSEvent, context: Context): Promise<void> => {
    const startTime = Date.now();
    const requestId = context.awsRequestId;
    
    console.log(`[${requestId}] === Vector Processor Started ===`);
    console.log(`[${requestId}] Function: ${context.functionName}:${context.functionVersion}`);
    console.log(`[${requestId}] Memory limit: ${context.memoryLimitInMB}MB`);
    console.log(`[${requestId}] Remaining time: ${context.getRemainingTimeInMillis()}ms`);
    console.log(`[${requestId}] Processing ${event.Records.length} messages`);

    const results = [];

    for (const record of event.Records) {
        const messageId = record.messageId;
        try {
            console.log(`[${requestId}] Processing message: ${messageId}`);
            
            // Parse the task from SQS message
            const task: VectorProcessingTask = JSON.parse(record.body);
            console.log(`[${requestId}] Task: ${JSON.stringify(task)}`);

            // Process the vector indexing task
            const result = await processVectorIndexingTask(task, requestId);
            results.push({ messageId, status: 'success', result });

            console.log(`[${requestId}] ✅ Successfully processed message: ${messageId}`);
        } catch (error) {
            console.error(`[${requestId}] ❌ Failed to process message ${messageId}:`, error);
            results.push({ messageId, status: 'failed', error: (error as Error).message });
            // Let the message go to DLQ by throwing error
            throw error;
        }
    }

    const totalDuration = Date.now() - startTime;
    console.log(`[${requestId}] ✅ Vector processing complete. Processed ${results.length} messages in ${totalDuration}ms`);
};

/**
 * Process a single vector indexing task
 */
async function processVectorIndexingTask(task: VectorProcessingTask, requestId: string): Promise<VectorIndexRecord> {
    const taskStartTime = Date.now();
    
    console.log(`[${requestId}] 🔍 Step 1: Downloading embedding data from S3...`);
    console.log(`[${requestId}]   Bucket: ${task.embeddingS3Bucket}`);
    console.log(`[${requestId}]   Key: ${task.embeddingS3Key}`);

    // Download embedding data from S3
    const embeddingData = await downloadEmbeddingData(task, requestId);
    
    console.log(`[${requestId}] ✅ Step 1 PASSED: Downloaded embedding data in ${Date.now() - taskStartTime}ms`);
    console.log(`[${requestId}]   Document: ${embeddingData.documentId}`);
    console.log(`[${requestId}]   Chunk: ${embeddingData.chunkId} (${embeddingData.chunkIndex})`);
    console.log(`[${requestId}]   Embedding: ${embeddingData.embedding.length}D vector`);
    console.log(`[${requestId}]   Content: ${embeddingData.content.length} chars`);

    // Update status to processing
    await updateIndexingStatus(embeddingData, 'processing', requestId);

    console.log(`[${requestId}] 🔍 Step 2: Indexing vector into OpenSearch...`);
    
    // Create OpenSearch document
    const opensearchDoc = {
        vector_field: embeddingData.embedding,
        document_id: embeddingData.documentId,
        processing_id: embeddingData.processingId,
        chunk_id: embeddingData.chunkId,
        chunk_index: embeddingData.chunkIndex,
        content: embeddingData.content,
        original_file_name: embeddingData.originalDocumentInfo.objectKey,
        content_type: embeddingData.originalDocumentInfo.contentType,
        file_size: embeddingData.originalDocumentInfo.fileSize,
        embedding_model: embeddingData.embeddingMetadata.model,
        dimensions: embeddingData.embeddingMetadata.dimensions,
        token_count: embeddingData.embeddingMetadata.tokenCount,
        processed_at: embeddingData.processedAt,
        indexed_at: new Date().toISOString(),
        source: embeddingData.source
    };

    // Index into OpenSearch Serverless
    const client = await getOpenSearchClient();
    const indexResponse = await client.index({
        index: OPENSEARCH_INDEX_NAME,
        id: embeddingData.chunkId,
        body: opensearchDoc
    });

    const indexingDuration = Date.now() - taskStartTime;
    console.log(`[${requestId}] ✅ Step 2 PASSED: Indexed vector in OpenSearch in ${indexingDuration}ms`);
    console.log(`[${requestId}]   Index: ${OPENSEARCH_INDEX_NAME}`);
    console.log(`[${requestId}]   Document ID: ${embeddingData.chunkId}`);
    console.log(`[${requestId}]   OpenSearch Response: ${JSON.stringify(indexResponse.body)}`);

    console.log(`[${requestId}] 🔍 Step 3: Creating index record...`);

    // Create vector index record
    const vectorIndexRecord: VectorIndexRecord = {
        documentId: embeddingData.documentId,
        chunkId: embeddingData.chunkId,
        chunkIndex: embeddingData.chunkIndex,
        vectorId: embeddingData.chunkId,
        opensearchIndexName: OPENSEARCH_INDEX_NAME,
        indexingStatus: 'success',
        indexedAt: new Date().toISOString(),
        metadata: {
            dimensions: embeddingData.embeddingMetadata.dimensions,
            tokenCount: embeddingData.embeddingMetadata.tokenCount,
            embeddingModel: embeddingData.embeddingMetadata.model,
            contentPreview: embeddingData.content.substring(0, 200)
        }
    };

    // Update status to success and store metadata
    await Promise.all([
        updateIndexingStatus(embeddingData, 'success', requestId),
        storeVectorMetadata(vectorIndexRecord, requestId)
    ]);

    const totalDuration = Date.now() - taskStartTime;
    console.log(`[${requestId}] ✅ Step 3 PASSED: Created index record in ${totalDuration}ms total`);

    return vectorIndexRecord;
}

/**
 * Download and parse embedding data from S3
 */
async function downloadEmbeddingData(task: VectorProcessingTask, requestId: string): Promise<EmbeddingData> {
    try {
        const response = await s3Client.send(new GetObjectCommand({
            Bucket: task.embeddingS3Bucket,
            Key: task.embeddingS3Key
        }));

        if (!response.Body) {
            throw new Error('No content body in S3 response');
        }

        // Read the stream
        const streamToString = (stream: any): Promise<string> => {
            return new Promise((resolve, reject) => {
                const chunks: Uint8Array[] = [];
                stream.on('data', (chunk: Uint8Array) => chunks.push(chunk));
                stream.on('error', reject);
                stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
            });
        };

        const contentString = await streamToString(response.Body);
        
        // Parse JSON content
        const embeddingData: EmbeddingData = JSON.parse(contentString);
        
        // Validate embedding data
        if (!embeddingData.embedding || !Array.isArray(embeddingData.embedding)) {
            throw new Error('Invalid embedding data: missing or invalid embedding array');
        }

        return embeddingData;
    } catch (error) {
        console.error(`[${requestId}] Failed to download embedding data ${task.embeddingS3Key}:`, error);
        throw error;
    }
}

/**
 * Get OpenSearch client (initialized lazily with AWS SigV4)
 */
async function getOpenSearchClient(): Promise<Client> {
    if (!opensearchClient) {
        opensearchClient = new Client({
            ...AwsSigv4Signer({
                region: process.env.AWS_REGION || 'us-east-2',
                service: 'aoss', // OpenSearch Serverless
            }),
            node: OPENSEARCH_COLLECTION_ENDPOINT,
            requestTimeout: 30000,
            sniffOnStart: false,
        });

        // Ensure the index exists with proper vector settings
        await ensureIndexExists();
    }

    return opensearchClient;
}

/**
 * Ensure the OpenSearch index exists with proper vector field mapping
 */
async function ensureIndexExists(): Promise<void> {
    if (!opensearchClient) {
        throw new Error('OpenSearch client not initialized');
    }

    try {
        // Check if index exists
        const indexExists = await opensearchClient.indices.exists({
            index: OPENSEARCH_INDEX_NAME
        });

        if (!indexExists.body) {
            console.log(`Creating OpenSearch index: ${OPENSEARCH_INDEX_NAME}`);
            
            // Create index with vector field mapping
            await opensearchClient.indices.create({
                index: OPENSEARCH_INDEX_NAME,
                body: {
                    settings: {
                        "index.knn": true,
                        "number_of_shards": 2,
                        "number_of_replicas": 1
                    },
                    mappings: {
                        properties: {
                            vector_field: {
                                type: "knn_vector",
                                dimension: 1024, // Bedrock Titan v2 default
                                method: {
                                    name: "hnsw",
                                    space_type: "cosinesimil",
                                    engine: "nmslib",
                                    parameters: {
                                        ef_construction: 128,
                                        m: 16
                                    }
                                }
                            },
                            document_id: { type: "keyword" },
                            processing_id: { type: "keyword" },
                            chunk_id: { type: "keyword" },
                            chunk_index: { type: "integer" },
                            content: { type: "text" },
                            original_file_name: { type: "keyword" },
                            content_type: { type: "keyword" },
                            file_size: { type: "integer" },
                            embedding_model: { type: "keyword" },
                            dimensions: { type: "integer" },
                            token_count: { type: "integer" },
                            processed_at: { type: "date" },
                            indexed_at: { type: "date" },
                            source: { type: "keyword" }
                        }
                    }
                }
            });

            console.log(`✅ Created OpenSearch index: ${OPENSEARCH_INDEX_NAME}`);
        }
    } catch (error) {
        console.error('Failed to ensure index exists:', error);
        throw error;
    }
}

/**
 * Update indexing status in DynamoDB
 */
async function updateIndexingStatus(
    embeddingData: EmbeddingData, 
    status: 'processing' | 'success' | 'failed', 
    requestId: string, 
    errorMessage?: string
): Promise<void> {
    try {
        const item = {
            documentId: embeddingData.documentId,
            chunkId: embeddingData.chunkId,
            chunkIndex: embeddingData.chunkIndex,
            indexingStatus: status,
            updatedAt: new Date().toISOString(),
            embeddingModel: embeddingData.embeddingMetadata.model,
            dimensions: embeddingData.embeddingMetadata.dimensions,
            ...(errorMessage && { errorMessage })
        };

        await dynamoClient.send(new PutItemCommand({
            TableName: VECTOR_INDEX_TABLE_NAME,
            Item: marshall(item)
        }));

        console.log(`[${requestId}] 📝 Updated indexing status to: ${status}`);
    } catch (error) {
        console.error(`[${requestId}] ❌ Failed to update indexing status:`, error);
        // Don't throw - this is not critical for the indexing process
    }
}

/**
 * Store vector metadata in S3
 */
async function storeVectorMetadata(vectorIndexRecord: VectorIndexRecord, requestId: string): Promise<void> {
    try {
        // Generate timestamp-hash key for the metadata
        const timestamp = new Date().toISOString();
        const hash = Buffer.from(`${timestamp}${vectorIndexRecord.chunkId}${vectorIndexRecord.documentId}`).toString('base64url');
        const objectKey = `${timestamp}-${hash}-vector-metadata.json`;

        console.log(`[${requestId}] Storing vector metadata: ${objectKey}`);

        await s3Client.send(new PutObjectCommand({
            Bucket: VECTOR_METADATA_BUCKET_NAME,
            Key: objectKey,
            Body: JSON.stringify(vectorIndexRecord, null, 2),
            ContentType: 'application/json',
            Metadata: {
                'document-id': vectorIndexRecord.documentId,
                'chunk-id': vectorIndexRecord.chunkId,
                'vector-id': vectorIndexRecord.vectorId,
                'indexing-status': vectorIndexRecord.indexingStatus,
                'opensearch-index': vectorIndexRecord.opensearchIndexName
            }
        }));

        console.log(`[${requestId}] ✅ Stored vector metadata in S3`);
    } catch (error) {
        console.error(`[${requestId}] ❌ Failed to store vector metadata:`, error);
        // Don't throw - this is not critical for the indexing process
    }
} 