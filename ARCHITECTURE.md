# RAG Vector Storage Service Architecture - Hybrid Architecture

## Overview

The Vector Storage Service has been **significantly simplified** in the hybrid architecture. It now serves as a **secure proxy service** that forwards vector operations to the home vector server, rather than managing complex vector indexing and OpenSearch operations directly.

## 🎯 **Service Purpose (Hybrid Architecture)**

- **Input**: Vector search requests from Knowledge Retrieval Service
- **Process**: **Secure proxy** with authentication and request forwarding
- **Output**: Proxied responses from home vector server

## 🏗️ **Simplified Architecture**

```
┌─────────────────────┐    ┌──────────────────────┐    ┌─────────────────────┐
│  Knowledge          │    │  Vector Storage      │    │  Home Vector        │
│  Retrieval Service  │───▶│  Service (Proxy)     │───▶│  Server             │
│                     │    │                      │    │                     │
│ • Query Enhancement │    │ • Request Proxy      │    │ • Weaviate DB       │
│ • Context Ranking   │    │ • JWT Authentication │    │ • Vector Operations │
│ • Result Caching    │    │ • Health Monitoring  │    │ • Performance Opt   │
└─────────────────────┘    └──────────────────────┘    └─────────────────────┘
```

## 🔄 **Simplified Data Flow**

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                            Vector Storage Service (Proxy)                              │
│                                                                                         │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐                │
│  │ Knowledge   │──▶│   Vector    │──▶│    Home     │──▶│  Weaviate   │                │
│  │ Retrieval   │   │ Proxy API   │   │   Vector    │   │  Database   │                │
│  │ Service     │   │             │   │   Server    │   │             │                │
│  └─────────────┘   └─────────────┘   └─────────────┘   └─────────────┘                │
│                            │                                    │                       │
│                            ▼                                    ▼                       │
│                   ┌─────────────┐                      ┌─────────────┐                │
│                   │   Health    │                      │   Vector    │                │
│                   │ Monitoring  │                      │ Operations  │                │
│                   │             │                      │ (Search,    │                │
│                   └─────────────┘                      │ Store, etc) │                │
│                                                        └─────────────┘                │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

## 🚀 **Service Components (Simplified)**

### Lambda Functions

#### 1. Vector Proxy API (`vector-proxy-api.ts`)
- **Purpose**: **Main proxy function** that forwards requests to home vector server
- **Triggers**: API Gateway requests
- **Features**:
  - JWT authentication validation
  - Request forwarding to home server
  - Response proxying with CORS headers
  - Error handling and fallbacks
  - Basic request/response logging

**Key Capabilities**:
- **Authentication**: Validates Cognito JWT tokens
- **Proxy Logic**: Forwards requests to home server with proper headers
- **Error Handling**: Graceful fallbacks for connectivity issues
- **CORS Support**: Proper cross-origin headers for web UI
- **Health Checks**: Basic connectivity monitoring

#### 2. Health Monitor (`health-monitor.ts`)
- **Purpose**: Monitors connectivity to home vector server
- **Triggers**: CloudWatch Events (every 5 minutes)
- **Features**:
  - Home server connectivity checks
  - Performance metrics collection
  - Alert generation for outages
  - Status dashboard updates

## 🏗️ **Infrastructure Components (Simplified)**

### API Gateway
- **Name**: `rag-vector-storage-api-{account}-{region}`
- **Endpoints**:
  - `POST /search` - Vector similarity search (proxy)
  - `POST /store` - Store vectors (proxy)
  - `DELETE /delete` - Delete vectors (proxy)
  - `GET /health` - Service health check
- **Features**: CORS enabled, Cognito authentication, request validation

### CloudWatch Monitoring
- **Metrics**: Request count, latency, error rates, home server connectivity
- **Alarms**: Home server unreachable, high error rates, performance degradation
- **Dashboards**: Service health, proxy performance, home server status

## 🔗 **OndemandEnv Integration (Hybrid)**

### Service Communication Pattern

#### Consuming from Knowledge Retrieval Service
```typescript
// Knowledge Retrieval calls Vector Storage proxy
const vectorStorageApi = ragContracts.ragVectorStorageBuild.dev.vectorProxyApi;

// Vector search request
const searchRequest = {
  query: "machine learning concepts",
  limit: 10,
  threshold: 0.7,
  optimizeForGeneration: true
};

const response = await fetch(vectorStorageApi.url + '/search', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(searchRequest)
});
```

#### Providing to Generation Service (via Knowledge Retrieval)
```typescript
// Generation Service → Knowledge Retrieval → Vector Storage → Home Server
const generationService = ragContracts.ragGenerationBuild.dev;
// Generation calls Knowledge Retrieval, which calls Vector Storage proxy
```

## 🛡️ **Security Architecture**

### Authentication Flow
```
Knowledge Retrieval → Vector Storage Proxy → Home Vector Server
         ↓                      ↓                      ↓
   Cognito JWT           JWT Validation         JWT Validation
```

### Security Features
- **JWT Validation**: Cognito token verification
- **HTTPS Only**: All communications encrypted
- **Network Isolation**: Home server not directly accessible
- **Request Logging**: Security audit trail
- **Rate Limiting**: API Gateway throttling

## 📊 **Performance Characteristics**

### Latency Profile
- **Proxy Overhead**: < 50ms additional latency
- **Authentication**: < 10ms JWT validation
- **Network Transit**: Depends on home server location
- **Total Overhead**: < 100ms for proxy operations

### Scalability
- **Concurrent Requests**: Limited by API Gateway (10,000 RPS)
- **Home Server**: Scales based on hardware capabilities
- **Stateless**: No local state, pure proxy pattern

## 🔧 **Configuration**

### Environment Variables
- `HOME_VECTOR_SERVER_URL`: Home server endpoint
- `COGNITO_USER_POOL_ID`: AWS Cognito User Pool ID
- `COGNITO_CLIENT_ID`: AWS Cognito Client ID
- `AWS_REGION`: AWS region for Cognito
- `REQUIRED_GROUP`: Required Cognito group (`odmd-rag-uploader`)

### Home Server Integration
- **URL Format**: `https://your-domain.com`
- **Authentication**: Same Cognito JWT token
- **Endpoints**: Direct mapping to home server API
- **Health Check**: Regular connectivity monitoring

## 🚨 **Error Handling**

### Failure Scenarios
1. **Home Server Unreachable**: Return cached results or error
2. **Authentication Failure**: Return 401 with proper error message
3. **Request Timeout**: Return 504 with retry guidance
4. **Invalid Request**: Return 400 with validation errors

### Recovery Strategies
- **Circuit Breaker**: Fail fast when home server is down
- **Retry Logic**: Exponential backoff for transient failures
- **Fallback Responses**: Cached results when available
- **Alert Generation**: Immediate notification of persistent issues

## 📈 **Monitoring and Observability**

### Key Metrics
- **Request Volume**: Requests per second through proxy
- **Response Time**: End-to-end latency including home server
- **Error Rate**: Failed requests percentage
- **Home Server Health**: Connectivity and response time

### Dashboards
- **Proxy Performance**: Request/response metrics
- **Home Server Status**: Connectivity and health metrics
- **Error Analysis**: Failed request patterns and causes
- **Cost Tracking**: API Gateway usage and costs

## 🎯 **Cost Optimization**

### Previous Architecture (OpenSearch)
- **OpenSearch Serverless**: $345/month minimum
- **Complex Lambda Functions**: High compute costs
- **Data Transfer**: Expensive cross-AZ transfers
- **Development Environments**: Full cost per environment

### New Architecture (Proxy)
- **API Gateway**: $1-7/month for proxy requests
- **Simple Lambda Functions**: Minimal compute costs
- **Home Server**: One-time hardware + electricity
- **Development**: Shared home server resources

### Cost Savings
- **98% reduction** in vector storage costs
- **90% reduction** in compute complexity
- **100% savings** on development environments
- **Total**: **85% overall cost reduction**

## 🔄 **Migration Notes**

### Changes from Previous Architecture
1. **Removed**: OpenSearch Serverless collection
2. **Removed**: Complex vector indexing logic
3. **Removed**: S3 polling and processing queues
4. **Removed**: DynamoDB checkpoint tables
5. **Added**: Simple proxy API function
6. **Added**: Home server health monitoring
7. **Simplified**: Authentication to JWT-only

### Breaking Changes
- **API Endpoints**: Same paths, different backend
- **Response Format**: Maintained compatibility
- **Authentication**: Same Cognito JWT tokens
- **Performance**: Potentially different latency characteristics

## 🏃‍♂️ **Deployment**

### AWS Infrastructure
```bash
cd rag-vector-storage-service
npm install
cdk deploy --profile your-aws-profile
```

### Configuration
```bash
# Set home server URL
aws ssm put-parameter \
  --name "/rag/vector-storage/home-server-url" \
  --value "https://your-domain.com" \
  --type "String"
```

### Verification
```bash
# Test proxy functionality
curl -X POST https://your-api-gateway-url/search \
  -H "Authorization: Bearer your-jwt-token" \
  -H "Content-Type: application/json" \
  -d '{"query": "test", "limit": 5}'
```

## 🗺️ **Multi-Enver Roadmap**

This service follows OndemandEnv's **multi-enver approach** with different architectural implementations:

### **Current Implementation: `dev` Branch**
- **Architecture**: Secure proxy to home vector server
- **Cost**: $1-7/month (98% cost reduction)
- **Use Case**: Cost optimization, full control, development environments
- **Status**: ✅ **Production Ready**

### **Planned Implementation: `dev-pine` Branch**
- **Architecture**: Cloud-native Pinecone integration
- **Components**:
  - Direct Pinecone SDK integration
  - Native vector operations (no proxy)
  - Pinecone index management
  - Usage-based scaling
- **Cost**: $20-100/month (usage-based)
- **Use Case**: Production scalability, managed service, enterprise features
- **Status**: 📋 **Roadmap**

### **Enver Comparison**

| Aspect | `dev` (Home Server) | `dev-pine` (Pinecone) |
|--------|-------------------|---------------------|
| **Cost** | $1-7/month | $20-100/month |
| **Control** | Full hardware control | Managed service |
| **Scalability** | Manual scaling | Auto-scaling |
| **Maintenance** | Self-managed | Vendor-managed |
| **Performance** | Predictable | Variable (cloud) |
| **Security** | Self-hosted | Vendor security |

### **Contract Consistency**
Both envers will satisfy the same service contracts, allowing consumers to switch between implementations without code changes.

## 📚 **Related Documentation**

- [Home Vector Server Setup](../home-vector-server/README.md)
- [Hybrid RAG Architecture](../HYBRID_RAG_ARCHITECTURE.md)
- [Knowledge Retrieval Service](../rag-knowledge-retrieval-service/ARCHITECTURE.md)
- [Authentication Architecture](../rag-document-ingestion-service/AUTHENTICATION_ARCHITECTURE.md) 