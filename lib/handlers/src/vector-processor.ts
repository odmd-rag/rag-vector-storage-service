import { SQSEvent, Context, SQSBatchResponse, SQSBatchItemFailure, S3Event, SQSRecord } from 'aws-lambda';
import { S3Client, GetObjectCommand, GetObjectTaggingCommand } from '@aws-sdk/client-s3';
import { Pinecone } from '@pinecone-database/pinecone';
import { randomUUID } from 'crypto';

const s3Client = new S3Client();

if (!process.env.PINECONE_API_KEY) {
    throw new Error('Missing PINECONE_API_KEY environment variable');
}
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const PINECONE_INDEX_NAME = process.env.PINECONE_INDEX_NAME || 'rag-documents';
const pineconeIndex = pinecone.index(PINECONE_INDEX_NAME);

interface EmbeddingRecord {
    documentId: string;
    originalChunks: { content: string }[];
    embeddings: { chunkId: string; vector: number[] }[];
}

export const handler = async (event: SQSEvent, context: Context): Promise<SQSBatchResponse> => {
    const batchItemFailures: SQSBatchItemFailure[] = [];

    for (const record of event.Records) {
        try {
            await processVector(record, context.awsRequestId);
        } catch (error) {
            console.error(`[${context.awsRequestId}] ❌ Failed to process record ${record.messageId}:`, error);
            batchItemFailures.push({ itemIdentifier: record.messageId });
        }
    }

    return { batchItemFailures };
};

async function processVector(record: SQSRecord, requestId: string): Promise<void> {
    const startTime = Date.now();
    const { bucketName, objectKey, documentId } = parseS3Event(record);

    console.log(`[${requestId}] 🔍 Starting vector processing for s3://${bucketName}/${objectKey}`);

    const tags = await s3Client.send(new GetObjectTaggingCommand({ Bucket: bucketName, Key: objectKey }));
    const embeddingStatus = tags.TagSet?.find(tag => tag.Key === 'embedding-status')?.Value;
    if (embeddingStatus !== 'completed') {
        console.log(`[${requestId}] ⏭️ Skipping document. Embedding status is '${embeddingStatus || 'not set'}'.`);
        return;
    }
    console.log(`[${requestId}] ✅ Document approved for vector storage.`);

    const embeddingData = await downloadEmbeddingData(bucketName, objectKey, requestId);
    
    console.log(`[${requestId}] 🔍 Preparing ${embeddingData.embeddings.length} vectors for upsert...`);
    const vectorsToUpsert = embeddingData.embeddings.map((embedding, index) => ({
        id: embedding.chunkId,
        values: embedding.vector,
        metadata: {
            documentId: embeddingData.documentId,
            text: embeddingData.originalChunks[index]?.content || ''
        }
    }));

    if (vectorsToUpsert.length > 0) {
        await pineconeIndex.upsert(vectorsToUpsert);
        console.log(`[${requestId}] ✅ Successfully upserted ${vectorsToUpsert.length} vectors to Pinecone.`);
    } else {
        console.log(`[${requestId}] ⚠️ No vectors to upsert.`);
    }

    const totalDuration = Date.now() - startTime;
    console.log(`[${requestId}] ✅ Vector processing completed in ${totalDuration}ms.`);
}

function parseS3Event(record: SQSRecord): { bucketName: string, objectKey: string, documentId: string } {
    const s3Event: S3Event = JSON.parse(record.body);
    const s3Record = s3Event.Records[0];
    const bucketName = s3Record.s3.bucket.name;
    const objectKey = decodeURIComponent(s3Record.s3.object.key.replace(/\+/g, ' '));
    const documentId = objectKey.split('/').pop()?.replace('.json', '') || `unknown-id-${randomUUID()}`;
    return { bucketName, objectKey, documentId };
}

async function downloadEmbeddingData(bucketName: string, objectKey: string, requestId: string): Promise<EmbeddingRecord> {
    console.log(`[${requestId}] 📥 Downloading embedding data from s3://${bucketName}/${objectKey}`);
    const command = new GetObjectCommand({ Bucket: bucketName, Key: objectKey });
    const response = await s3Client.send(command);
    return JSON.parse(await response.Body!.transformToString());
} 