# RAG Vector Storage Service Lambda Handlers

This is a TypeScript project containing all Lambda function handlers for the RAG Vector Storage Service.

## Structure

- `src/` - TypeScript source code for Lambda handlers
  - `status-handler.ts` - Provides HTTP status API for document vector indexing tracking
  - `health-check.ts` - Health check endpoint for home vector server monitoring

## Development

### Prerequisites

- Node.js 18+
- TypeScript 5.6+

### Setup

```bash
npm install
```

### Build

```bash
npm run build
```

### Development Mode

```bash
npm run dev
```

### Linting

```bash
npm run lint
```

### Testing

```bash
npm run test
```

### Clean

```bash
npm run clean
```

## Dependencies

- **AWS SDK v3** - For AWS service interactions (S3, Lambda)
- **AWS Lambda Powertools** - For structured logging, metrics, and tracing
- **Axios** - For HTTP requests to home vector server
- **TypeScript** - Type safety and modern JavaScript features

## Deployment

These handlers are deployed as part of the main RAG Vector Storage Service CDK stack. The CDK stack references the compiled JavaScript from the `dist/` directory. 