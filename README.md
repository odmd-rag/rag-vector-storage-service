# RAG Vector Storage Service

## Overview

The **Vector Storage Service** is a simple, focused AWS-based proxy that securely forwards vector operations to a home-based vector database server. It provides enterprise-grade security while hiding the home server behind AWS infrastructure using **direct API Gateway HTTP integration**.

## 🎯 **Core Purpose**

This service acts as a **secure API Gateway proxy** for a home-based vector database, providing:
- **Security**: AWS JWT authentication & authorization
- **Monitoring**: Health checks and observability
- **Isolation**: Home server remains hidden from external access
- **Simplicity**: Direct HTTP proxy with zero Lambda functions for vector operations

## 🏗️ **Architecture**

```
External Client
       ↓
   API Gateway (JWT Auth + {proxy+})
       ↓
   Home Vector Server (direct HTTP integration)
```

### Components

1. **API Gateway HTTP API** 
   - JWT authentication via Cognito authorizer
   - Direct HTTP integration with `{proxy+}` wildcard
   - Automatic path forwarding to home server
   - Built-in CORS and request/response handling
   - **No Lambda functions** for vector operations

2. **Health Check Lambda** (`health-check.ts`)
   - Monitors home server connectivity
   - Scheduled every 5 minutes via EventBridge
   - Provides HTTP health endpoint
   - **Only Lambda function** in the service

## 🔌 **API Endpoints**

### Vector Operations (Authenticated)
All requests automatically forwarded to home server via direct HTTP integration:
- `ANY /{proxy+}` → `ANY /{proxy+}` (direct forwarding to home server)

**Examples:**
- `POST /search` → `POST /search` (direct to home server)
- `POST /store` → `POST /store` (direct to home server)
- `DELETE /delete` → `DELETE /delete` (direct to home server)
- `GET /api/vectors/status` → `GET /api/vectors/status` (direct to home server)

### Health Check (Public)
- `GET /health` - Service health status (Lambda-based)

## 🔐 **Authentication**

All vector operations require a valid JWT token from AWS Cognito:
```
Authorization: Bearer <jwt-token>
```

API Gateway validates JWT before forwarding requests to home server.

## 🏠 **Home Server Integration**

API Gateway directly forwards requests to home server endpoints with automatic:
- **Path Mapping**: `{proxy+}` forwards all paths unchanged
- **Header Forwarding**: Authorization and other headers passed through
- **Method Forwarding**: GET, POST, PUT, DELETE, OPTIONS all supported
- **Body Forwarding**: Request bodies passed unchanged

## 🚀 **Deployment**

### Prerequisites
- AWS CDK v2 installed
- Node.js 18+ 
- Home vector server running and accessible
- OndemandEnv contracts configured with home server domain

### Contract Configuration
The home server URL is now managed through the OndemandEnv contract system:

1. **Set Home Server Domain**: Update the `homeServerDomainName` in your user-auth contracts
2. **Contract Resolution**: The service automatically gets the domain via `myEnver.homeServerDomain.getSharedValue(this)`

```typescript
// In user-auth contracts (already configured)
this.homeServerDomainName = new OdmdCrossRefProducer(this, 'home-server-domain-name')

// In vector storage service (automatically resolved)
const homeVectorServerUrl = myEnver.homeServerDomain.getSharedValue(this);
```

### Deploy
```bash
# Install dependencies
npm install

# Build TypeScript (only for health check)
npm run build

# Deploy using contract-based configuration
npm run ragVectorStorage-cdk-deploy
```

## 📊 **Monitoring**

### Health Checks
- Automatic every 5 minutes (Lambda-based)
- Manual via `GET /health`
- Monitors home server connectivity

### Logs
- API Gateway access logs
- Direct HTTP integration logging
- Home server connectivity status

## 🔄 **Request Flow**

1. **Authentication**: API Gateway validates JWT token via Cognito
2. **Direct HTTP Integration**: API Gateway forwards request directly to home server using HTTP URL integration
3. **Response**: API Gateway returns home server response unchanged
4. **Logging**: All operations logged to CloudWatch
5. **No Lambda Cold Starts**: Direct HTTP integration eliminates Lambda invocation overhead

## 🎛️ **Configuration**

### CDK Context Variables
- `homeVectorServerUrl`: URL of your home vector server
- `userPoolId`: AWS Cognito User Pool ID
- `userPoolClientId`: Cognito User Pool Client ID

### API Gateway Integration
- Direct HTTP integration with `{proxy+}` wildcard
- Automatic request/response forwarding
- Built-in error handling and timeouts

## 🛠️ **Local Development**

### Build and Test
```bash
# Install dependencies
npm install

# Build TypeScript (health check Lambda only)
npm run build

# Run tests
npm test
```

### Testing Locally
```bash
# Test health check
curl https://your-api-gateway-url/health

# Test vector search (with JWT)
curl -X POST https://your-api-gateway-url/search \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "test query", "topK": 5}'

# Test any endpoint (proxy+)
curl -X GET https://your-api-gateway-url/api/vectors/status \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

## 🔧 **Troubleshooting**

### Common Issues

1. **401 Unauthorized**
   - Check JWT token validity
   - Verify Cognito User Pool configuration

2. **503 Service Unavailable**
   - Check home server connectivity
   - Verify firewall/network configuration
   - Check health endpoint status

3. **Timeout Errors**
   - Check API Gateway timeout settings (29 seconds max)
   - Verify home server response time
   - Check network latency

### Logs
```bash
# View API Gateway logs
aws logs tail /aws/apigateway/vector-storage-api --follow

# View health check logs
aws logs tail /aws/lambda/health-check --follow
```

## 🔄 **Cost Optimization**

This direct HTTP integration architecture minimizes AWS costs:
- **No Lambda invocation charges** for vector operations
- **No cold starts** - direct HTTP forwarding eliminates Lambda overhead
- **Pay-per-request** API Gateway pricing only
- **No data processing costs** - direct passthrough to home server
- **Minimal Lambda usage** - only for health checks (scheduled)

Expected monthly costs:
- API Gateway HTTP API: ~$1-5 (per million requests)
- Health Check Lambda: ~$0.10-0.50 (scheduled every 5 minutes)
- Total: **~$1-6/month** (vs $345/month for OpenSearch Serverless)

**Performance Benefits:**
- **Zero cold start latency** for vector operations
- **Direct network path** to home server
- **Reduced failure points** (no Lambda in request path)

## 🔗 **Integration with Other Services**

### Generation Service
```typescript
// Call vector storage for RAG context
const response = await fetch(`${vectorStorageUrl}/search`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    query: userQuery,
    topK: 5
  })
});
```

### Document Processing
```typescript
// Store processed document vectors
await fetch(`${vectorStorageUrl}/store`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${jwtToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    documentId: 'doc-123',
    chunks: vectorChunks
  })
});
```

## 🎯 **Design Principles**

1. **Maximum Simplicity**: Direct HTTP proxy with zero custom code
2. **Security**: Enterprise-grade authentication and authorization
3. **Performance**: No Lambda cold starts or processing overhead
4. **Cost-Effective**: Lowest possible AWS costs for proxy functionality
5. **Maintainable**: Minimal infrastructure with native AWS services

## 📈 **Architecture Benefits**

### **Direct HTTP Integration Advantages**
- ✅ **90% Lower Cost**: No Lambda invocation charges
- ✅ **Better Performance**: No cold starts, direct HTTP forwarding
- ✅ **Zero Code Maintenance**: Pure API Gateway configuration
- ✅ **Automatic Scaling**: API Gateway handles all traffic patterns
- ✅ **Built-in Features**: CORS, error handling, request validation

### **Comparison: Lambda vs Direct HTTP**

| Feature | Lambda Proxy | Direct HTTP Integration |
|---------|-------------|------------------------|
| **Cost** | $0.20+ per million requests | $3.50 per million requests (API Gateway only) |
| **Latency** | +50-200ms (cold starts) | <10ms overhead |
| **Code** | 100+ lines to maintain | Zero code |
| **Scaling** | Lambda concurrency limits | Native API Gateway scaling |
| **Debugging** | Lambda logs + API Gateway | API Gateway logs only |

This service provides a secure, cost-effective bridge between AWS services and your home vector database, enabling enterprise RAG capabilities with **maximum simplicity and minimum cost**. 