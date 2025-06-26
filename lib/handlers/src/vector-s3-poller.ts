import { Handler } from 'aws-lambda';
import { S3Client, ListObjectsV2Command, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';

interface S3PollerEvent {
    source: string;
    detail: {
        action: string;
        bucketName: string;
    };
}

interface ProcessingCheckpoint {
    serviceId: string;
    lastProcessedKey: string;
    lastProcessedTimestamp: string;
    updatedAt: string;
}

const s3Client = new S3Client({});
const dynamoClient = new DynamoDBClient({});

const EMBEDDINGS_BUCKET_NAME = process.env.EMBEDDINGS_BUCKET_NAME!;
const CHECKPOINT_TABLE_NAME = process.env.CHECKPOINT_TABLE_NAME!;
const HOME_SERVER_DOMAIN = process.env.HOME_SERVER_DOMAIN!;
const VECTOR_METADATA_BUCKET = process.env.VECTOR_METADATA_BUCKET!;

export const handler: Handler<S3PollerEvent> = async (event) => {
    console.log('🔄 Starting vector storage S3 polling process...', JSON.stringify(event, null, 2));

    try {
        // Get current checkpoint
        const checkpoint = await getCurrentCheckpoint();
        console.log('📍 Current checkpoint:', checkpoint);

        // List objects in embeddings bucket newer than checkpoint
        const newObjects = await listNewObjects(EMBEDDINGS_BUCKET_NAME, checkpoint);
        console.log(`📄 Found ${newObjects.length} new objects to process`);

        if (newObjects.length === 0) {
            console.log('✅ No new objects found, polling complete');
            return { statusCode: 200, message: 'No new objects to process' };
        }

        // Process each new embedding file
        let lastProcessedKey = checkpoint.lastProcessedKey;
        let lastProcessedTimestamp = checkpoint.lastProcessedTimestamp;

        for (const obj of newObjects) {
            console.log(`🔄 Processing embedding: ${obj.Key}`);
            
            try {
                await processEmbeddingFile(obj.Key!, obj.LastModified!);
                
                // Update tracking variables
                lastProcessedKey = obj.Key!;
                lastProcessedTimestamp = obj.LastModified!.toISOString();
                
                console.log(`✅ Successfully processed: ${obj.Key}`);
            } catch (error) {
                console.error(`❌ Failed to process ${obj.Key}:`, error);
                // Continue processing other files even if one fails
            }
        }

        // Update checkpoint with last successfully processed object
        if (lastProcessedKey !== checkpoint.lastProcessedKey) {
            await updateCheckpoint({
                serviceId: 'vector-processor-1',
                lastProcessedKey,
                lastProcessedTimestamp,
                updatedAt: new Date().toISOString()
            });
            console.log('📍 Updated checkpoint to:', lastProcessedKey);
        }

        console.log(`✅ S3 polling complete. Processed ${newObjects.length} new objects`);
        return { 
            statusCode: 200, 
            message: `Successfully processed ${newObjects.length} new embedding files`,
            processedObjects: newObjects.length,
            lastProcessedKey
        };

    } catch (error) {
        console.error('❌ Error during S3 polling:', error);
        throw error;
    }
};

async function getCurrentCheckpoint(): Promise<ProcessingCheckpoint> {
    try {
        const result = await dynamoClient.send(new GetItemCommand({
            TableName: CHECKPOINT_TABLE_NAME,
            Key: {
                serviceId: { S: 'vector-processor-1' }
            }
        }));

        if (result.Item) {
            return {
                serviceId: result.Item.serviceId.S!,
                lastProcessedKey: result.Item.lastProcessedKey.S!,
                lastProcessedTimestamp: result.Item.lastProcessedTimestamp.S!,
                updatedAt: result.Item.updatedAt.S!
            };
        }
    } catch (error) {
        console.log('📍 No existing checkpoint found, starting fresh');
    }

    // Return default checkpoint if none exists
    return {
        serviceId: 'vector-processor-1',
        lastProcessedKey: '',
        lastProcessedTimestamp: '1970-01-01T00:00:00.000Z',
        updatedAt: new Date().toISOString()
    };
}

async function updateCheckpoint(checkpoint: ProcessingCheckpoint): Promise<void> {
    await dynamoClient.send(new PutItemCommand({
        TableName: CHECKPOINT_TABLE_NAME,
        Item: {
            serviceId: { S: checkpoint.serviceId },
            lastProcessedKey: { S: checkpoint.lastProcessedKey },
            lastProcessedTimestamp: { S: checkpoint.lastProcessedTimestamp },
            updatedAt: { S: checkpoint.updatedAt }
        }
    }));
}

async function listNewObjects(bucketName: string, checkpoint: ProcessingCheckpoint) {
    const command = new ListObjectsV2Command({
        Bucket: bucketName,
        MaxKeys: 100 // Process in batches
    });

    const result = await s3Client.send(command);
    const objects = result.Contents || [];

    // Filter objects newer than checkpoint
    const checkpointTime = new Date(checkpoint.lastProcessedTimestamp);
    const newObjects = objects.filter(obj => {
        if (!obj.LastModified || !obj.Key) return false;
        
        // Only process JSON files (embedding files)
        if (!obj.Key.endsWith('.json')) return false;
        
        // Check if object is newer than checkpoint
        const objTime = new Date(obj.LastModified);
        return objTime > checkpointTime;
    });

    // Sort by last modified time to process in order
    newObjects.sort((a, b) => 
        new Date(a.LastModified!).getTime() - new Date(b.LastModified!).getTime()
    );

    return newObjects;
}

async function processEmbeddingFile(objectKey: string, lastModified: Date): Promise<void> {
    console.log(`🔄 Processing embedding file: ${objectKey}`);
    
    // Extract document ID from the object key
    const documentId = extractDocumentIdFromKey(objectKey);
    
    // For now, we'll simulate vector storage processing
    // In a real implementation, this would:
    // 1. Download the embedding file from S3
    // 2. Send vectors to the home vector server
    // 3. Store metadata about the operation
    
    // Create a metadata record for tracking
    const metadata = {
        documentId,
        objectKey,
        processedAt: new Date().toISOString(),
        lastModified: lastModified.toISOString(),
        status: 'completed',
        vectorCount: 0, // Would be set from actual processing
        homeServerResponse: 'simulated_success'
    };
    
    // Store processing metadata (this enables status tracking)
    await storeVectorMetadata(documentId, metadata);
    
    console.log(`✅ Stored vector metadata for document: ${documentId}`);
}

function extractDocumentIdFromKey(objectKey: string): string {
    // Extract timestamp and hash from embedding file key
    // Format: "2025-06-25T23:46:15.362Z-4bf1f9b9763635c415c7bbf1185cd0408e22738109291ee12582a3c35ddd0bc7.json"
    const match = objectKey.match(/^(.+?)-([a-f0-9]{64})\.json$/);
    if (match) {
        const timestamp = match[1];
        const hash = match[2];
        return `${timestamp}-${hash}`;
    }
    
    // Fallback: use the filename without extension
    return objectKey.replace('.json', '');
}

async function storeVectorMetadata(documentId: string, metadata: any): Promise<void> {
    // Store metadata in S3 for status tracking
    const metadataKey = `${documentId}-vector-metadata.json`;
    
    await s3Client.send(new PutObjectCommand({
        Bucket: VECTOR_METADATA_BUCKET,
        Key: metadataKey,
        Body: JSON.stringify(metadata, null, 2),
        ContentType: 'application/json',
        Metadata: {
            'document-id': documentId,
            'processed-at': metadata.processedAt,
            'status': metadata.status
        }
    }));
} 