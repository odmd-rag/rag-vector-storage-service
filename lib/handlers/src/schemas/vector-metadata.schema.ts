import { z } from 'zod';

// Embedding summary schema (consumed from embedding service)
export const EmbeddingSummaryReferenceSchema = z.object({
  totalChunks: z.number().int().positive(),
  model: z.string(),
  totalTokens: z.number().int().nonnegative()
});

// Original document reference schema
export const OriginalDocumentReferenceSchema = z.object({
  bucket: z.string(),
  key: z.string()
});

// Processing metadata schema
export const ProcessingMetadataSchema = z.object({
  sourceStatusObjectKey: z.string(),
  sourceBucket: z.string(),
  requestId: z.string()
});

// Main vector metadata schema (the complete data structure stored in S3)
export const VectorMetadataSchema = z.object({
  documentId: z.string(),
  status: z.literal('indexed'),
  indexedAt: z.string().datetime(),
  processingTimeMs: z.number().nonnegative(),
  homeServerDomain: z.string(),
  embeddingSummary: EmbeddingSummaryReferenceSchema,
  originalDocument: OriginalDocumentReferenceSchema,
  upsertResult: z.unknown(), // Home server response - flexible structure
  metadata: ProcessingMetadataSchema
});

// Export TypeScript types
export type EmbeddingSummaryReference = z.infer<typeof EmbeddingSummaryReferenceSchema>;
export type OriginalDocumentReference = z.infer<typeof OriginalDocumentReferenceSchema>;
export type ProcessingMetadata = z.infer<typeof ProcessingMetadataSchema>;
export type VectorMetadata = z.infer<typeof VectorMetadataSchema>; 