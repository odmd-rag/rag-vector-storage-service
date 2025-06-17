import { Context, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws';

// Initialize AWS clients
const s3Client = new S3Client({});

// Environment variables
const OPENSEARCH_COLLECTION_ENDPOINT = process.env.OPENSEARCH_COLLECTION_ENDPOINT!;
const OPENSEARCH_INDEX_NAME = process.env.OPENSEARCH_INDEX_NAME!;
const VECTOR_METADATA_BUCKET_NAME = process.env.VECTOR_METADATA_BUCKET_NAME!;

// OpenSearch client (initialized lazily)
let opensearchClient: Client | null = null;

// Interfaces
interface SearchRequest {
    vector?: number[];
    query?: string;
    limit?: number;
    threshold?: number;
    filters?: Record<string, any>;
    includeContent?: boolean;
}

interface SearchResult {
    chunkId: string;
    documentId: string;
    processingId: string;
    chunkIndex: number;
    score: number;
    content?: string;
    metadata: {
        originalFileName: string;
        contentType: string;
        fileSize: number;
        embeddingModel: string;
        tokenCount: number;
        processedAt: string;
        source: string;
    };
}

interface SearchResponse {
    results: SearchResult[];
    totalHits: number;
    searchTime: number;
    metadata: {
        indexName: string;
        searchType: 'vector' | 'hybrid';
        threshold: number;
        limit: number;
    };
}

/**
 * Lambda handler for vector search API
 * Provides similarity search capabilities over the vector database
 */
export const handler = async (event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> => {
    const startTime = Date.now();
    const requestId = context.awsRequestId;

    console.log(`[${requestId}] === Vector Search API Started ===`);
    console.log(`[${requestId}] HTTP Method: ${event.httpMethod}`);
    console.log(`[${requestId}] Path: ${event.path}`);
    console.log(`[${requestId}] Query String: ${JSON.stringify(event.queryStringParameters)}`);

    try {
        // CORS headers
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
            'Content-Type': 'application/json'
        };

        // Handle OPTIONS request for CORS
        if (event.httpMethod === 'OPTIONS') {
            return {
                statusCode: 200,
                headers: corsHeaders,
                body: ''
            };
        }

        // Only allow POST requests for search
        if (event.httpMethod !== 'POST') {
            return {
                statusCode: 405,
                headers: corsHeaders,
                body: JSON.stringify({
                    error: 'Method Not Allowed',
                    message: 'Only POST requests are allowed'
                })
            };
        }

        // Parse request body
        let searchRequest: SearchRequest;
        try {
            searchRequest = JSON.parse(event.body || '{}');
        } catch (error) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({
                    error: 'Bad Request',
                    message: 'Invalid JSON in request body'
                })
            };
        }

        // Validate search request
        if (!searchRequest.vector || !Array.isArray(searchRequest.vector)) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({
                    error: 'Bad Request',
                    message: 'vector field is required and must be an array'
                })
            };
        }

        console.log(`[${requestId}] Search request: vector dimensions=${searchRequest.vector.length}, limit=${searchRequest.limit || 10}`);

        // Perform vector search
        const searchResponse = await performVectorSearch(searchRequest, requestId);

        const totalDuration = Date.now() - startTime;
        console.log(`[${requestId}] ✅ Search completed in ${totalDuration}ms, found ${searchResponse.results.length} results`);

        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify(searchResponse)
        };

    } catch (error) {
        console.error(`[${requestId}] ❌ Search failed:`, error);

        return {
            statusCode: 500,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                error: 'Internal Server Error',
                message: 'Failed to perform vector search',
                requestId
            })
        };
    }
};

/**
 * Perform vector similarity search using OpenSearch
 */
async function performVectorSearch(request: SearchRequest, requestId: string): Promise<SearchResponse> {
    const searchStartTime = Date.now();
    
    console.log(`[${requestId}] 🔍 Performing vector search...`);
    console.log(`[${requestId}]   Vector dimensions: ${request.vector!.length}`);
    console.log(`[${requestId}]   Limit: ${request.limit || 10}`);
    console.log(`[${requestId}]   Threshold: ${request.threshold || 0.7}`);
    console.log(`[${requestId}]   Include content: ${request.includeContent !== false}`);

    const client = await getOpenSearchClient();

    // Build the KNN search query
    let searchQuery: any = {
        size: request.limit || 10,
        query: {
            knn: {
                vector_field: {
                    vector: request.vector,
                    k: request.limit || 10
                }
            }
        },
        _source: {
            excludes: request.includeContent === false ? ['content'] : []
        }
    };

    // Add filters if provided
    if (request.filters && Object.keys(request.filters).length > 0) {
        const filterQueries = Object.entries(request.filters).map(([field, value]) => ({
            term: { [field]: value }
        }));

        searchQuery.query = {
            bool: {
                must: [searchQuery.query],
                filter: filterQueries
            }
        };
    }

    console.log(`[${requestId}] OpenSearch query: ${JSON.stringify(searchQuery, null, 2)}`);

    // Execute search
    const searchResult = await client.search({
        index: OPENSEARCH_INDEX_NAME,
        body: searchQuery
    });

    const searchTime = Date.now() - searchStartTime;
    console.log(`[${requestId}] ✅ OpenSearch returned ${searchResult.body.hits.hits.length} results in ${searchTime}ms`);

    // Process results
    const threshold = request.threshold || 0.0;
    const results: SearchResult[] = searchResult.body.hits.hits
        .filter((hit: any) => hit._score >= threshold)
        .map((hit: any) => ({
            chunkId: hit._source.chunk_id,
            documentId: hit._source.document_id,
            processingId: hit._source.processing_id,
            chunkIndex: hit._source.chunk_index,
            score: hit._score,
            ...(request.includeContent !== false && { content: hit._source.content }),
            metadata: {
                originalFileName: hit._source.original_file_name,
                contentType: hit._source.content_type,
                fileSize: hit._source.file_size,
                embeddingModel: hit._source.embedding_model,
                tokenCount: hit._source.token_count,
                processedAt: hit._source.processed_at,
                source: hit._source.source
            }
        }));

    const response: SearchResponse = {
        results,
        totalHits: searchResult.body.hits.total.value || searchResult.body.hits.total,
        searchTime,
        metadata: {
            indexName: OPENSEARCH_INDEX_NAME,
            searchType: 'vector',
            threshold,
            limit: request.limit || 10
        }
    };

    console.log(`[${requestId}] Filtered results: ${results.length} (threshold=${threshold})`);

    return response;
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

        console.log('✅ Initialized OpenSearch client for search');
    }

    return opensearchClient;
} 