import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as opensearchserverless from 'aws-cdk-lib/aws-opensearchserverless';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
// Note: Contract imports will be available at runtime
// import { OdmdEnverCdk, OdmdShareIn, OdmdShareOut } from '@ondemandenv/contracts-lib-base';
// import { RagVectorStorageEnver } from '@odmd-rag/contracts-lib-rag';

export interface RagVectorStorageStackProps extends cdk.StackProps {
}

export class RagVectorStorageStack extends cdk.Stack {

    constructor(scope: Construct, myEnver: any, props: RagVectorStorageStackProps) {
        super(scope, `RagVectorStorageStack-${myEnver.targetAWSAccountID}-${myEnver.targetAWSRegion}`, props);

        // === ONDEMANDENV SHARE IN (CONSUMING) ===

        // Consume embedding service outputs
        const embeddingsBucketName = myEnver.embeddingSubscription.getValue();

        // === OPENSEARCH SERVERLESS COLLECTION ===

        // Security policy for OpenSearch Serverless collection
        const encryptionPolicy = new opensearchserverless.CfnSecurityPolicy(this, 'VectorEncryptionPolicy', {
            name: `rag-vector-encryption-${this.account}-${this.region}`,
            type: 'encryption',
            policy: JSON.stringify({
                Rules: [{
                    ResourceType: 'collection',
                    Resource: [`collection/rag-vectors-${this.account}-${this.region}`]
                }],
                AWSOwnedKey: true
            })
        });

        // Network policy for OpenSearch Serverless collection
        const networkPolicy = new opensearchserverless.CfnSecurityPolicy(this, 'VectorNetworkPolicy', {
            name: `rag-vector-network-${this.account}-${this.region}`,
            type: 'network',
            policy: JSON.stringify([{
                Rules: [{
                    ResourceType: 'collection',
                    Resource: [`collection/rag-vectors-${this.account}-${this.region}`]
                }],
                AllowFromPublic: true
            }])
        });

        // OpenSearch Serverless collection for vector storage
        const vectorCollection = new opensearchserverless.CfnCollection(this, 'VectorCollection', {
            name: `rag-vectors-${this.account}-${this.region}`,
            type: 'VECTORSEARCH',
            description: 'Vector storage collection for RAG system',
        });

        vectorCollection.addDependency(encryptionPolicy);
        vectorCollection.addDependency(networkPolicy);

        // Data access policy for OpenSearch Serverless
        const dataAccessPolicy = new opensearchserverless.CfnAccessPolicy(this, 'VectorDataAccessPolicy', {
            name: `rag-vector-data-access-${this.account}-${this.region}`,
            type: 'data',
            policy: JSON.stringify([{
                Rules: [{
                    ResourceType: 'collection',
                    Resource: [`collection/rag-vectors-${this.account}-${this.region}`],
                    Permission: [
                        'aoss:CreateCollectionItems',
                        'aoss:DeleteCollectionItems',
                        'aoss:UpdateCollectionItems',
                        'aoss:DescribeCollectionItems'
                    ]
                }, {
                    ResourceType: 'index',
                    Resource: [`index/rag-vectors-${this.account}-${this.region}/*`],
                    Permission: [
                        'aoss:CreateIndex',
                        'aoss:DeleteIndex',
                        'aoss:UpdateIndex',
                        'aoss:DescribeIndex',
                        'aoss:ReadDocument',
                        'aoss:WriteDocument'
                    ]
                }],
                Principal: [
                    `arn:aws:iam::${this.account}:role/rag/vector-storage/processor-${this.account}-${this.region}`,
                    `arn:aws:iam::${this.account}:role/rag/vector-storage/search-api-${this.account}-${this.region}`
                ]
            }])
        });

        // === S3 BUCKETS ===

        // Vector metadata bucket (stores processing status, index mappings)
        const vectorMetadataBucket = new s3.Bucket(this, 'VectorMetadataBucket', {
            bucketName: `rag-vector-metadata-${this.account}-${this.region}`,
            versioned: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            lifecycleRules: [{
                id: 'DeleteOldMetadata',
                enabled: true,
                expiration: cdk.Duration.days(30), // Keep metadata for 30 days
            }],
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });

        // Vector backup bucket (periodic snapshots of vector data)
        const vectorBackupBucket = new s3.Bucket(this, 'VectorBackupBucket', {
            bucketName: `rag-vector-backup-${this.account}-${this.region}`,
            versioned: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            lifecycleRules: [{
                id: 'DeleteOldBackups',
                enabled: true,
                expiration: cdk.Duration.days(90), // Keep backups for 90 days
            }],
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });

        // === SQS QUEUES ===

        // Dead letter queue for failed vector processing
        const vectorProcessingDlq = new sqs.Queue(this, 'VectorProcessingDlq', {
            queueName: `rag-vector-processing-dlq-${this.account}-${this.region}`,
            retentionPeriod: cdk.Duration.days(14),
        });

        // Main vector processing queue
        const vectorProcessingQueue = new sqs.Queue(this, 'VectorProcessingQueue', {
            queueName: `rag-vector-processing-${this.account}-${this.region}`,
            visibilityTimeout: cdk.Duration.minutes(15), // Match Lambda timeout
            deadLetterQueue: {
                queue: vectorProcessingDlq,
                maxReceiveCount: 3
            }
        });

        // === DYNAMODB TABLES ===

        // Checkpoint table for S3 polling state
        const checkpointTable = new dynamodb.Table(this, 'VectorStorageCheckpointTable', {
            tableName: `rag-vector-storage-checkpoints-${this.account}-${this.region}`,
            partitionKey: { name: 'serviceId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            pointInTimeRecovery: true,
        });

        // Vector index status table (tracks indexing status per document)
        const vectorIndexTable = new dynamodb.Table(this, 'VectorIndexTable', {
            tableName: `rag-vector-index-status-${this.account}-${this.region}`,
            partitionKey: { name: 'documentId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'chunkId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            pointInTimeRecovery: true,
        });

        // === LAMBDA FUNCTIONS ===

        // S3 poller Lambda (polls embeddings bucket for new files)
        const vectorIndexingPollerHandler = new NodejsFunction(this, 'VectorIndexingPollerHandler', {
            functionName: `rag-vector-indexing-poller-${this.account}-${this.region}`,
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'handler',
            entry: 'lib/handlers/src/vector-indexing-poller.ts',
            timeout: cdk.Duration.minutes(15),
            memorySize: 1024,
            logRetention: logs.RetentionDays.ONE_WEEK,
            role: new iam.Role(this, 'VectorIndexingPollerRole', {
                path: '/rag/vector-storage/',                                           // ← Hierarchical path
                roleName: `indexing-poller-${this.account}-${this.region}`,            // ← Fixed: vector-storage service role
                assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
                managedPolicies: [
                    iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
                ]
            }),
            environment: {
                EMBEDDINGS_BUCKET_NAME: embeddingsBucketName,
                VECTOR_PROCESSING_QUEUE_URL: vectorProcessingQueue.queueUrl,
                CHECKPOINT_TABLE_NAME: checkpointTable.tableName,
                BATCH_SIZE: '50', // Process 50 embedding files per execution
                SERVICE_ID: 'vector-storage-1',
                AWS_ACCOUNT_ID: this.account,
            },
        });

                 // Vector processor Lambda (processes embedding files, stores in OpenSearch)
         const vectorProcessorHandler = new NodejsFunction(this, 'VectorProcessorHandler', {
             functionName: `rag-vector-processor-${this.account}-${this.region}`,
             runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'handler',
            entry: 'lib/handlers/src/vector-processor.ts',
            timeout: cdk.Duration.minutes(15),
            memorySize: 2048,
            logRetention: logs.RetentionDays.ONE_WEEK,
            role: new iam.Role(this, 'VectorProcessorRole', {
                path: '/rag/vector-storage/',                                          // ← Hierarchical path
                roleName: `processor-${this.account}-${this.region}`,                 // ← Fixed: vector-storage service role
                assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
                managedPolicies: [
                    iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
                ]
            }),
            environment: {
                OPENSEARCH_COLLECTION_ENDPOINT: vectorCollection.attrCollectionEndpoint,
                OPENSEARCH_INDEX_NAME: `embeddings-${this.account}-${this.region}`,
                VECTOR_METADATA_BUCKET_NAME: vectorMetadataBucket.bucketName,
                VECTOR_INDEX_TABLE_NAME: vectorIndexTable.tableName,
                AWS_ACCOUNT_ID: this.account,
            },
        });

                 // Vector search API Lambda (provides similarity search capabilities)
         const vectorSearchApiHandler = new NodejsFunction(this, 'VectorSearchApiHandler', {
             functionName: `rag-vector-search-api-${this.account}-${this.region}`,
             runtime: lambda.Runtime.NODEJS_22_X,
             handler: 'handler',
             entry: 'lib/handlers/src/vector-search-api.ts',
             timeout: cdk.Duration.minutes(5),
             memorySize: 1024,
             logRetention: logs.RetentionDays.ONE_WEEK,
                         role: new iam.Role(this, 'VectorSearchApiRole', {
                path: '/rag/vector-storage/',                                          // ← Hierarchical path
                roleName: `search-api-${this.account}-${this.region}`,                // ← Fixed: vector-storage service role
                assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
                managedPolicies: [
                    iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
                ]
            }),
             environment: {
                 OPENSEARCH_COLLECTION_ENDPOINT: vectorCollection.attrCollectionEndpoint,
                 OPENSEARCH_INDEX_NAME: `embeddings-${this.account}-${this.region}`,
                 VECTOR_METADATA_BUCKET_NAME: vectorMetadataBucket.bucketName,
                 AWS_ACCOUNT_ID: this.account,
             },
         });

         // DLQ handler Lambda (processes failed vector indexing tasks)
         const dlqHandlerHandler = new NodejsFunction(this, 'DlqHandlerHandler', {
             functionName: `rag-vector-dlq-handler-${this.account}-${this.region}`,
             runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'handler',
            entry: 'lib/handlers/src/dlq-handler.ts',
            timeout: cdk.Duration.seconds(30),
            memorySize: 512,
            logRetention: logs.RetentionDays.ONE_WEEK,
            role: new iam.Role(this, 'DlqHandlerRole', {
                path: '/rag/vector-storage/',                                          // ← Hierarchical path
                roleName: `dlq-handler-${this.account}-${this.region}`,               // ← Role name only
                assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
                managedPolicies: [
                    iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
                ]
            }),
            environment: {
                VECTOR_METADATA_BUCKET_NAME: vectorMetadataBucket.bucketName,
                VECTOR_INDEX_TABLE_NAME: vectorIndexTable.tableName,
                AWS_ACCOUNT_ID: this.account,
            },
        });

        // === EVENTBRIDGE SCHEDULED RULE FOR S3 POLLING ===
        const vectorIndexingPollingRule = new events.Rule(this, 'VectorIndexingPollingRule', {
            ruleName: `rag-vector-indexing-polling-${this.account}-${this.region}`,
            description: 'Triggers vector indexing poller every 30 seconds',
            schedule: events.Schedule.rate(cdk.Duration.seconds(30)),
        });

        vectorIndexingPollingRule.addTarget(new targets.LambdaFunction(vectorIndexingPollerHandler));

        // === SQS EVENT SOURCES FOR LAMBDA FUNCTIONS ===

        // Main vector processing queue
        vectorProcessorHandler.addEventSource(new lambdaEventSources.SqsEventSource(vectorProcessingQueue, {
            batchSize: 5, // Process up to 5 embedding files at once
            maxBatchingWindow: cdk.Duration.seconds(5),
        }));

        // DLQ processing
        dlqHandlerHandler.addEventSource(new lambdaEventSources.SqsEventSource(vectorProcessingDlq, {
            batchSize: 1, // Process DLQ messages one at a time
        }));

        // === IAM PERMISSIONS ===

        // Vector indexing poller permissions
        s3.Bucket.fromBucketName(this, 'EmbeddingsBucket', embeddingsBucketName)
            .grantRead(vectorIndexingPollerHandler);
        vectorProcessingQueue.grantSendMessages(vectorIndexingPollerHandler);
        checkpointTable.grantReadWriteData(vectorIndexingPollerHandler);

        // Vector processor permissions
        vectorMetadataBucket.grantWrite(vectorProcessorHandler);
        vectorIndexTable.grantReadWriteData(vectorProcessorHandler);
        vectorProcessingQueue.grantConsumeMessages(vectorProcessorHandler);

        // OpenSearch Serverless permissions for vector processor
        vectorProcessorHandler.role?.addToPrincipalPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'aoss:APIAccessAll'
            ],
            resources: [vectorCollection.attrArn]
        }));

        // Vector search API permissions
        vectorMetadataBucket.grantRead(vectorSearchApiHandler);

        // OpenSearch Serverless permissions for search API
        vectorSearchApiHandler.role?.addToPrincipalPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'aoss:APIAccessAll'
            ],
            resources: [vectorCollection.attrArn]
        }));

        // DLQ handler permissions
        vectorProcessingDlq.grantConsumeMessages(dlqHandlerHandler);
        vectorMetadataBucket.grantWrite(dlqHandlerHandler);
        vectorIndexTable.grantReadWriteData(dlqHandlerHandler);

        // === STACK OUTPUTS ===

        // Vector storage endpoints for downstream services
        new cdk.CfnOutput(this, 'VectorDatabaseEndpoint', {
            value: vectorCollection.attrCollectionEndpoint,
            description: 'OpenSearch Serverless collection endpoint',
        });

        new cdk.CfnOutput(this, 'VectorIndexName', {
            value: `embeddings-${this.account}-${this.region}`,
            description: 'OpenSearch vector index name',
        });

        new cdk.CfnOutput(this, 'VectorMetadataBucketName', {
            value: vectorMetadataBucket.bucketName,
            description: 'S3 bucket for vector metadata',
        });

        new cdk.CfnOutput(this, 'VectorBackupBucketName', {
            value: vectorBackupBucket.bucketName,
            description: 'S3 bucket for vector backups',
        });

        // === CLOUDWATCH ALARMS ===

        // Alarm for DLQ messages
        const dlqAlarm = vectorProcessingDlq.metricApproximateNumberOfMessagesVisible()
            .createAlarm(this, 'VectorProcessingDlqAlarm', {
                threshold: 5,
                evaluationPeriods: 2,
                alarmDescription: 'Vector processing DLQ has messages',
            });

        // Alarm for vector processor errors
        const processorErrorAlarm = vectorProcessorHandler.metricErrors()
            .createAlarm(this, 'VectorProcessorErrorAlarm', {
                threshold: 10,
                evaluationPeriods: 2,
                alarmDescription: 'High error rate in vector processor',
            });

        // === ADDITIONAL STACK OUTPUTS ===
        
        new cdk.CfnOutput(this, 'OpenSearchCollectionEndpoint', {
            value: vectorCollection.attrCollectionEndpoint,
            description: 'OpenSearch Serverless collection endpoint',
        });

        new cdk.CfnOutput(this, 'VectorProcessingQueueUrl', {
            value: vectorProcessingQueue.queueUrl,
            description: 'SQS queue for vector processing tasks',
        });
    }
} 