import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import {HttpJwtAuthorizer} from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import {Certificate, CertificateValidation} from "aws-cdk-lib/aws-certificatemanager";
import {ARecord, HostedZone, RecordTarget} from "aws-cdk-lib/aws-route53";
import {ApiGatewayv2DomainProperties} from "aws-cdk-lib/aws-route53-targets";
import {NodejsFunction} from 'aws-cdk-lib/aws-lambda-nodejs';
import {RagVectorStorageEnver} from '@odmd-rag/contracts-lib-rag';
import {OdmdShareOut} from '@ondemandenv/contracts-lib-base';
import {StackProps} from "aws-cdk-lib";
import {EmbeddingStorageProducer} from "@odmd-rag/contracts-lib-rag/dist/services/embedding";


export class RagVectorStorageServiceStack extends cdk.Stack {
    readonly httpApi: apigatewayv2.HttpApi;
    readonly apiDomain: string;
    readonly zoneName: string;
    readonly hostedZoneId: string;

    constructor(scope: Construct, myEnver: RagVectorStorageEnver, props: StackProps) {
        const id = myEnver.getRevStackNames()[0];
        super(scope, id, props);
        this.hostedZoneId = 'Z01450892FNOJJT5BBBRU';
        this.zoneName = 'rag-ws1.root.ondemandenv.link';

        const apiSubdomain = ('vs-api.' + myEnver.targetRevision.value + '.' + myEnver.owner.buildId).toLowerCase();
        this.apiDomain = `${apiSubdomain}.${this.zoneName}`;

        const embeddingsBucketName = myEnver.embeddingSubscription.getSharedValue(this);
        const processedContentBucketName = (myEnver.embeddingSubscription.producer as EmbeddingStorageProducer).owner.processedContentSubscription.getSharedValue(this);
        const homeServerDomain = myEnver.homeServerDomain.getSharedValue(this);
        const clientId = myEnver.authProviderClientId.getSharedValue(this);
        const providerName = myEnver.authProviderName.getSharedValue(this);


        const vectorMetadataBucket = new s3.Bucket(this, 'VecMetadataBucket', {
            versioned: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            lifecycleRules: [{
                id: 'DeleteOldVectorMetadata',
                enabled: true,
                expiration: cdk.Duration.days(365),
            }],
            publicReadAccess: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });

        const vectorBackupBucket = new s3.Bucket(this, 'VecBackupBucket', {
            versioned: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            lifecycleRules: [{
                id: 'DeleteOldVectorBackups',
                enabled: true,
                expiration: cdk.Duration.days(30),
            }],
            publicReadAccess: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });


        const statusHandler = new NodejsFunction(this, 'VecStatusHandler', {
            entry: __dirname + '/handlers/src/status-handler.ts',
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'handler',
            timeout: cdk.Duration.seconds(30),
            memorySize: 256,
            logRetention: logs.RetentionDays.ONE_WEEK,
            environment: {
                HOME_SERVER_DOMAIN: homeServerDomain,
                VECTOR_METADATA_BUCKET: vectorMetadataBucket.bucketName,
                EMBEDDINGS_BUCKET_NAME: embeddingsBucketName,
                CLIENT_ID: clientId,
                PROVIDER_NAME: providerName,
            },
        });

        const healthCheckHandler = new NodejsFunction(this, 'VecHealthCheckHandler', {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'handler',
            entry: __dirname + '/handlers/src/health-check.ts',
            timeout: cdk.Duration.seconds(30),
            memorySize: 256,
            logRetention: logs.RetentionDays.ONE_WEEK,
            environment: {
                HOME_SERVER_DOMAIN: homeServerDomain,
                VECTOR_METADATA_BUCKET: vectorMetadataBucket.bucketName,
            },
        });


        
        
        const vectorProcessingDlq = new sqs.Queue(this, 'VecProcessingDlq', {
            retentionPeriod: cdk.Duration.days(14),
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        const vectorProcessingQueue = new sqs.Queue(this, 'VecProcessingQueue', {
            visibilityTimeout: cdk.Duration.minutes(10),
            receiveMessageWaitTime: cdk.Duration.seconds(20),
            retentionPeriod: cdk.Duration.days(14),
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            
            deadLetterQueue: {
                queue: vectorProcessingDlq,
                maxReceiveCount: 3
            }
        });

        const vectorProcessorHandler = new NodejsFunction(this, 'VecProcessorHandler', {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'handler',
            entry: __dirname + '/handlers/src/vector-processor.ts',
            timeout: cdk.Duration.minutes(3),
            memorySize: 1024,
            logRetention: logs.RetentionDays.ONE_WEEK,
            environment: {
                HOME_SERVER_DOMAIN: homeServerDomain,
                VECTOR_METADATA_BUCKET: vectorMetadataBucket.bucketName,
            },
        });

        const vectorDlqHandler = new NodejsFunction(this, 'VecDlqHandler', {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'handler',
            entry: __dirname + '/handlers/src/dlq-handler.ts',
            timeout: cdk.Duration.seconds(30),
            memorySize: 256,
            logRetention: logs.RetentionDays.ONE_WEEK,
            environment: {
                VECTOR_METADATA_BUCKET: vectorMetadataBucket.bucketName,
            },
        });


        const embeddingsBucket = s3.Bucket.fromBucketName(this, 'VecEmbeddingsBucket', embeddingsBucketName);
        const processedContentBucket = s3.Bucket.fromBucketName(this, 'VecProcessedContentBucket', processedContentBucketName);
        
        embeddingsBucket.grantRead(statusHandler);
        embeddingsBucket.grantRead(vectorProcessorHandler);
        processedContentBucket.grantRead(vectorProcessorHandler);

        vectorMetadataBucket.grantRead(statusHandler);
        vectorMetadataBucket.grantReadWrite(healthCheckHandler);
        vectorMetadataBucket.grantReadWrite(vectorProcessorHandler);

        // Listen to embeddings bucket for embedding-status objects
        embeddingsBucket.addEventNotification(
            s3.EventType.OBJECT_CREATED,
            new s3n.SqsDestination(vectorProcessingQueue),
            {
                prefix: 'embedding-status/',
                suffix: '.json'
            }
        );


        vectorProcessorHandler.addEventSource(new lambdaEventSources.SqsEventSource(vectorProcessingQueue, {
            batchSize: 1000,
            maxBatchingWindow: cdk.Duration.seconds(5),
            maxConcurrency: 8,
            reportBatchItemFailures: true,
        }));

        vectorDlqHandler.addEventSource(new lambdaEventSources.SqsEventSource(vectorProcessingDlq, {
            batchSize: 100,
            maxBatchingWindow: cdk.Duration.seconds(20),
            maxConcurrency: 8,
            reportBatchItemFailures: true,
        }));

        vectorProcessingDlq.grantConsumeMessages(vectorDlqHandler);
        vectorMetadataBucket.grantReadWrite(vectorDlqHandler);


        const healthCheckRule = new events.Rule(this, 'VecHealthCheckRule', {
            schedule: events.Schedule.rate(cdk.Duration.minutes(10)),
            description: 'Triggers health checks for home vector server',
        });

        healthCheckRule.addTarget(new targets.LambdaFunction(healthCheckHandler, {
            event: events.RuleTargetInput.fromObject({
                source: 'scheduled-health-check',
                detail: {
                    action: 'health-check',
                    homeServerDomain: homeServerDomain,
                }
            })
        }));


        const ingestionEnver = (myEnver.embeddingSubscription.producer as EmbeddingStorageProducer).owner.processedContentSubscription.producer.owner.ingestionEnver

        // CORS configuration
        const allowedOrigins = ['http://localhost:5173'];
        const webUiDomain = `https://up.${ingestionEnver.targetRevision.value}.${ingestionEnver.owner.buildId}.${this.zoneName}`.toLowerCase();
        allowedOrigins.push(`https://${webUiDomain}`);

        this.httpApi = new apigatewayv2.HttpApi(this, 'VecApi', {
            apiName: 'RAG Vector Storage Service',
            description: 'HTTP API for RAG vector storage service status with JWT authentication',
            defaultAuthorizer: new HttpJwtAuthorizer('Auth',
                `https://${providerName}`,
                {jwtAudience: [clientId]}
            ),
            corsPreflight: {
                allowOrigins: allowedOrigins,
                allowMethods: [apigatewayv2.CorsHttpMethod.GET, apigatewayv2.CorsHttpMethod.POST, apigatewayv2.CorsHttpMethod.OPTIONS],
                allowHeaders: [
                    'Content-Type',
                    'X-Amz-Date',
                    'Authorization',
                    'X-Api-Key',
                    'X-Amz-Security-Token',
                    'X-Amz-User-Agent',
                    'Host',
                    'Cache-Control',
                    'Pragma'
                ],
                allowCredentials: false,
                exposeHeaders: ['Date', 'X-Amzn-ErrorType'],
                maxAge: cdk.Duration.hours(1),
            },
        });

        this.httpApi.addRoutes({
            path: '/status/{documentId}',
            methods: [apigatewayv2.HttpMethod.GET],
            integration: new apigatewayv2Integrations.HttpLambdaIntegration('VecStatusIntegration', statusHandler),
        });


        this.httpApi.addRoutes({
            path: '/health',
            methods: [apigatewayv2.HttpMethod.GET],
            integration: new apigatewayv2Integrations.HttpLambdaIntegration('VecHealthIntegration', healthCheckHandler),
        });

        const hostedZone = HostedZone.fromHostedZoneAttributes(this, 'VecApiHostedZone', {
            hostedZoneId: this.hostedZoneId,
            zoneName: this.zoneName,
        });

        const domainName = new apigatewayv2.DomainName(this, 'VecApiDomainName', {
            domainName: this.apiDomain,
            certificate: new Certificate(this, 'VecApiCertificate', {
                domainName: this.apiDomain,
                validation: CertificateValidation.fromDns(hostedZone),
            }),
        });

        new apigatewayv2.ApiMapping(this, 'VecApiMapping', {
            api: this.httpApi,
            domainName: domainName,
        });

        new ARecord(this, 'VecApiAliasRecord', {
            zone: hostedZone,
            target: RecordTarget.fromAlias(
                new ApiGatewayv2DomainProperties(
                    domainName.regionalDomainName,
                    domainName.regionalHostedZoneId
                )
            ),
            recordName: apiSubdomain,
        });


        new cdk.CfnOutput(this, 'VecMetadataBucketName', {
            value: vectorMetadataBucket.bucketName,
            exportName: `${this.stackName}-VecMetadataBucket`,
        });

        new cdk.CfnOutput(this, 'VecBackupBucketName', {
            value: vectorBackupBucket.bucketName,
            exportName: `${this.stackName}-VecBackupBucket`,
        });

        new cdk.CfnOutput(this, 'VecApiEndpoint', {
            value: `https://${this.apiDomain}`,
            exportName: `${this.stackName}-VecApiEndpoint`,
        });

        new cdk.CfnOutput(this, 'VecApiDomain', {
            value: this.apiDomain,
            exportName: `${this.stackName}-VecApiDomain`,
        });

        new cdk.CfnOutput(this, 'VecHomeServerDomain', {
            value: homeServerDomain,
            exportName: `${this.stackName}-VecHomeServerDomain`,
        });

        new cdk.CfnOutput(this, 'VecProcessingQueueUrl', {
            value: vectorProcessingQueue.queueUrl,
            description: 'SQS queue for vector processing tasks (event-driven)',
        });

        new OdmdShareOut(
            this, new Map([
                [myEnver.vectorStorage.vectorDatabaseEndpoint, homeServerDomain],
                [myEnver.vectorStorage.vectorIndexName, 'rag-documents'],
                [myEnver.vectorStorage.vectorMetadataBucket, vectorMetadataBucket.bucketName],
                [myEnver.vectorStorage.vectorBackupBucket, vectorBackupBucket.bucketName],

                // Status API endpoint for WebUI tracking
                [myEnver.statusApi.statusApiEndpoint, `https://${this.apiDomain}/status`],
            ])
        );
    }
} 