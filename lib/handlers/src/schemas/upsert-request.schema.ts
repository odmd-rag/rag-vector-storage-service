import { z } from 'zod';

// Individual chunk upsert request schema
export const UpsertChunkSchema = z.object({
  documentId: z.string(),
  s3Bucket: z.string(),
  s3Key: z.string(),
  chunkId: z.string().uuid(),
  text: z.string(),
  vector: z.array(z.number()),
  metadata: z.object({
    chunkIndex: z.number().int().nonnegative(),
    totalChunks: z.number().int().positive(),
    model: z.string()
  }).and(z.record(z.unknown())) // Allow additional metadata fields
});

// Main upsert request schema (the complete payload sent to home vector server)
export const UpsertRequestSchema = z.object({
  chunks: z.array(UpsertChunkSchema)
});

// Export TypeScript types
export type UpsertChunk = z.infer<typeof UpsertChunkSchema>;
export type UpsertRequest = z.infer<typeof UpsertRequestSchema>; 