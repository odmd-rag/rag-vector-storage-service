import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { S3Client, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

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
        const vectorMetadataKey = `${documentId}-vector-metadata.json`;
        const vectorMetadataExists = await checkS3ObjectExists(VECTOR_METADATA_BUCKET, vectorMetadataKey, requestId);
        
        if (vectorMetadataExists) {
            console.log(`[${requestId}] Document ${documentId} found in vector metadata bucket`);
            
            const metadata = await getVectorProcessingMetadata(documentId, requestId);
            
            return {
                documentId,
                status: metadata?.status === 'completed' ? 'completed' : 'failed',
                stage: 'vector-storage',
                timestamp: metadata?.processedAt || new Date().toISOString(),
                metadata: {
                    processingTime: Date.now() - startTime,
                    vectorCount: metadata?.vectorCount || 0,
                    homeServerStatus: metadata?.homeServerResponse || 'unknown'
                }
            };
        }
        
        const errorStatus = await checkVectorStorageError(documentId, requestId);
        if (errorStatus) {
            return errorStatus;
        }
        
        const embeddingsExist = await checkEmbeddingsExist(documentId, requestId);
        
        if (embeddingsExist) {
            console.log(`[${requestId}] Document ${documentId} has embeddings but not indexed yet`);
            
            return {
                documentId,
                status: 'processing',
                stage: 'vector-storage',
                timestamp: new Date().toISOString(),
                metadata: {
                    processingTime: Date.now() - startTime,
                    homeServerStatus: 'indexing'
                }
            };
        } else {
            console.log(`[${requestId}] Document ${documentId} embeddings not found`);
            
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

async function checkS3ObjectExists(bucketName: string, key: string, requestId: string): Promise<boolean> {
    try {
        await s3Client.send(new HeadObjectCommand({
            Bucket: bucketName,
            Key: key
        }));
        
        console.log(`[${requestId}] Object exists: s3://${bucketName}/${key}`);
        return true;
        
    } catch (error: any) {
        if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
            console.log(`[${requestId}] Object not found: s3://${bucketName}/${key}`);
            return false;
        }
        
        console.error(`[${requestId}] Error checking object existence s3://${bucketName}/${key}:`, error);
        throw error;
    }
}

async function getVectorProcessingMetadata(documentId: string, requestId: string): Promise<any | null> {
    try {
        const vectorMetadataKey = `${documentId}-vector-metadata.json`;
        
        const command = new HeadObjectCommand({
            Bucket: VECTOR_METADATA_BUCKET,
            Key: vectorMetadataKey
        });
        
        const response = await s3Client.send(command);
        
        const metadata = {
            documentId,
            status: response.Metadata?.['status'] || 'completed',
            processedAt: response.Metadata?.['processed-at'] || response.LastModified?.toISOString() || new Date().toISOString(),
            vectorCount: parseInt(response.Metadata?.['vector-count'] || '0'),
            homeServerResponse: response.Metadata?.['home-server-response'] || 'simulated_success'
        };
        
        console.log(`[${requestId}] Retrieved vector processing metadata for document ${documentId}:`, metadata);
        return metadata;
        
    } catch (error) {
        console.error(`[${requestId}] Error getting vector processing metadata for ${documentId}:`, error);
        return null;
    }
}

async function checkVectorStorageError(documentId: string, requestId: string): Promise<DocumentStatus | null> {
    try {
        const errorKey = `errors/${documentId}.json`;
        const errorExists = await checkS3ObjectExists(VECTOR_METADATA_BUCKET, errorKey, requestId);
        
        if (errorExists) {
            console.log(`[${requestId}] Found vector storage error status for document ${documentId}`);
            
            const command = new HeadObjectCommand({
                Bucket: VECTOR_METADATA_BUCKET,
                Key: errorKey
            });
            
            const response = await s3Client.send(command);
            
            return {
                documentId,
                status: 'failed',
                stage: 'vector-storage',
                timestamp: new Date().toISOString(),
                metadata: {
                    errorMessage: response.Metadata?.['error-message'] || 'Vector storage indexing failed',
                    processingTime: parseInt(response.Metadata?.['processing-duration-ms'] || '0'),
                    homeServerStatus: response.Metadata?.['home-server-status'] || 'unknown'
                }
            };
        }
        
        return null;
        
    } catch (error) {
        console.error(`[${requestId}] Error checking vector storage error for ${documentId}:`, error);
        return null;
    }
}

async function checkEmbeddingsExist(documentId: string, requestId: string): Promise<boolean> {
    try {
        const embeddingsKey = `embeddings/${documentId}.json`;
        const exists = await checkS3ObjectExists(EMBEDDINGS_BUCKET_NAME, embeddingsKey, requestId);
        
        console.log(`[${requestId}] Embeddings exist check for ${documentId}: ${exists}`);
        return exists;
        
    } catch (error) {
        console.error(`[${requestId}] Error checking embeddings existence for ${documentId}:`, error);
        return false;
    }
}

async function checkHomeServerIndex(documentId: string, requestId: string): Promise<boolean> {
    try {
        console.log(`[${requestId}] Checking home server index for document ${documentId}`);
        
        // Query home server to verify document is indexed
        const searchUrl = `https://${HOME_SERVER_DOMAIN}/api/search`;
        
        const searchRequest = {
            query: `documentId:${documentId}`,
            limit: 1,
            threshold: 0.0
        };
        
        const response = await fetch(searchUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'RAG-VectorStorage-StatusCheck/1.0'
            },
            body: JSON.stringify(searchRequest),
            signal: AbortSignal.timeout(5000)
        });
        
        if (!response.ok) {
            console.log(`[${requestId}] Home server search failed with status ${response.status}`);
            return false;
        }
        
        const searchResult = await response.json();
        const hasResults = (searchResult as any).results && (searchResult as any).results.length > 0;
        
        console.log(`[${requestId}] Home server index check for ${documentId}: ${hasResults ? 'found' : 'not found'}`);
        return hasResults;
        
    } catch (error) {
        console.error(`[${requestId}] Error checking home server index for ${documentId}:`, error);
        return false;
    }
} 