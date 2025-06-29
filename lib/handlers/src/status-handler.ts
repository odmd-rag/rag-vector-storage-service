import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { S3Client, HeadObjectCommand, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });

const HOME_SERVER_DOMAIN = process.env.HOME_SERVER_DOMAIN!;
const VECTOR_METADATA_BUCKET = process.env.VECTOR_METADATA_BUCKET!;
const EMBEDDINGS_BUCKET_NAME = process.env.EMBEDDINGS_BUCKET_NAME!;
const CLIENT_ID = process.env.CLIENT_ID!;
const PROVIDER_NAME = process.env.PROVIDER_NAME!;

interface DocumentStatus {
    documentId: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    stage: 'vector-storage';
    timestamp: string;
    metadata?: {
        processingTime?: number;
        errorMessage?: string;
        vectorCount?: number;
        indexName?: string;
        homeServerStatus?: string;
    };
}

interface VectorMetadata {
    documentId: string;
    indexName: string;
    vectorCount: number;
    indexingStartTime: string;
    indexingEndTime: string;
    indexingDurationMs: number;
    homeServerResponse: any;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    const requestId = event.requestContext.requestId;
    
    try {
        const documentId = event.pathParameters?.documentId;
        
        if (!documentId) {
            return {
                statusCode: 400,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'X-Request-Id': requestId
                },
                body: JSON.stringify({ 
                    error: 'Missing documentId parameter',
                    requestId 
                })
            };
        }
        
        console.log(`[${requestId}] Checking vector storage status for document: ${documentId}`);
        
        const status = await getDocumentVectorStorageStatus(documentId, requestId);
        
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'X-Request-Id': requestId,
                'X-Processing-Time': Date.now().toString()
            },
            body: JSON.stringify(status)
        };
        
    } catch (error) {
        console.error(`[${requestId}] Error checking document vector storage status:`, error);
        
        return {
            statusCode: 500,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'X-Request-Id': requestId
            },
            body: JSON.stringify({ 
                error: 'Internal server error', 
                requestId,
                message: error instanceof Error ? error.message : 'Unknown error'
            })
        };
    }
};

async function getDocumentVectorStorageStatus(documentId: string, requestId: string): Promise<DocumentStatus> {
    const startTime = Date.now();
    
    try {
        const vectorMetadata = await getVectorMetadata(documentId, requestId);
        
        if (vectorMetadata) {
            console.log(`[${requestId}] Document ${documentId} found in vector metadata bucket`);
            
            return {
                documentId,
                status: 'completed',
                stage: 'vector-storage',
                timestamp: vectorMetadata.processedAt || new Date().toISOString(),
                metadata: {
                    processingTime: Date.now() - startTime,
                    vectorCount: vectorMetadata.embeddingSummary.totalChunks || 0,
                    homeServerStatus: 'indexed'
                }
            };
        }
        
        const isReadyForProcessing = await checkEmbeddingsExistAndAreCompleted(documentId, requestId);
        
        if (isReadyForProcessing) {
            console.log(`[${requestId}] Document ${documentId} embeddings are complete, pending vector storage.`);
            
            return {
                documentId,
                status: 'processing',
                stage: 'vector-storage',
                timestamp: new Date().toISOString(),
                metadata: {
                    processingTime: Date.now() - startTime,
                    homeServerStatus: 'pending-indexing'
                }
            };
        } else {
            console.log(`[${requestId}] Document ${documentId} embeddings not found or not complete`);
            
            return {
                documentId,
                status: 'pending',
                stage: 'vector-storage',
                timestamp: new Date().toISOString(),
                metadata: {
                    errorMessage: 'Embeddings not generated yet - vector storage pending embedding completion'
                }
            };
        }
        
    } catch (error) {
        console.error(`[${requestId}] Error checking vector storage status for ${documentId}:`, error);
        
        return {
            documentId,
            status: 'failed',
            stage: 'vector-storage',
            timestamp: new Date().toISOString(),
            metadata: {
                errorMessage: `Vector storage status check failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
        };
    }
}

async function getVectorMetadata(documentId: string, requestId: string): Promise<any | null> {
    try {
        const listCommand = new ListObjectsV2Command({
            Bucket: VECTOR_METADATA_BUCKET,
            Prefix: `vector-metadata/${documentId}/`,
            MaxKeys: 1
        });

        const listResponse = await s3Client.send(listCommand);

        if (!listResponse.Contents || listResponse.Contents.length === 0) {
            console.log(`[${requestId}] No vector metadata found for document ${documentId}`);
            return null;
        }

        const metadataObjectKey = listResponse.Contents[0].Key;
        console.log(`[${requestId}] Found vector metadata object: ${metadataObjectKey}`);

        const getCommand = new GetObjectCommand({
            Bucket: VECTOR_METADATA_BUCKET,
            Key: metadataObjectKey!
        });

        const getResponse = await s3Client.send(getCommand);
        const metadata = JSON.parse(await getResponse.Body!.transformToString());
        
        console.log(`[${requestId}] Retrieved and parsed vector metadata for document ${documentId}`);
        return metadata;
        
    } catch (error) {
        console.error(`[${requestId}] Error getting vector metadata for ${documentId}:`, error);
        return null;
    }
}

async function checkEmbeddingsExistAndAreCompleted(documentId: string, requestId: string): Promise<boolean> {
    const statusKey = `embedding-status/${documentId}.json`;
    try {
        const getCommand = new GetObjectCommand({
            Bucket: EMBEDDINGS_BUCKET_NAME,
            Key: statusKey
        });

        const response = await s3Client.send(getCommand);
        const statusData = JSON.parse(await response.Body!.transformToString());
        
        if (statusData.status === 'completed') {
            console.log(`[${requestId}] Embedding status for ${documentId} is 'completed'.`);
            return true;
        }

        console.log(`[${requestId}] Embedding status for ${documentId} is '${statusData.status}', not 'completed'.`);
        return false;
        
    } catch (error: any) {
        if (error.name === 'NotFound') {
            console.log(`[${requestId}] Embedding status object not found: s3://${EMBEDDINGS_BUCKET_NAME}/${statusKey}`);
            return false;
        }
        console.error(`[${requestId}] Error checking embedding status for ${documentId}:`, error);
        return false; // Assume not ready if there's an error
    }
}

// [CLEANUP] The following function is now obsolete and has been removed:
// - checkHomeServerIndex 