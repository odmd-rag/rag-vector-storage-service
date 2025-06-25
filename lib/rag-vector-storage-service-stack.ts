import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
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

export interface RagVectorStorageServiceStackProps extends cdk.StackProps {
    zoneName: string;
    hostedZoneId: string;
    webUiDomain: string;
}

export class RagVectorStorageServiceStack extends cdk.Stack {
    readonly httpApi: apigatewayv2.HttpApi;
    readonly apiDomain: string;

    constructor(scope: Construct, myEnver: RagVectorStorageEnver, props: RagVectorStorageServiceStackProps) {
        const id = myEnver.getRevStackNames()[0];
        super(scope, id, {...props, crossRegionReferences: props.env!.region !== 'us-east-1'});

        // Domain setup
        const zoneName = props.zoneName;
        const hostedZoneId = props.hostedZoneId;
        const apiSubdomain = ('vs-api.' + myEnver.targetRevision.value + '.' + myEnver.owner.buildId).toLowerCase();
        this.apiDomain = `${apiSubdomain}.${zoneName}`;

        // === CONSUMING from other services via OndemandEnv contracts ===
        const embeddingsBucketName = myEnver.embeddingSubscription.getSharedValue(this);
        const homeServerDomain = myEnver.homeServerDomain.getSharedValue(this);
        const clientId = myEnver.authProviderClientId.getSharedValue(this);
        const providerName = myEnver.authProviderName.getSharedValue(this);

        // === S3 BUCKETS FOR VECTOR STORAGE STATUS ===

        const vectorMetadataBucket = new s3.Bucket(this, 'VecMetadataBucket', {
            bucketName: `rag-vector-metadata-${this.account}-${this.region}`,
            versioned: false,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            lifecycleRules: [{
                id: 'DeleteOldVectorMetadata',
                enabled: true,
                expiration: cdk.Duration.days(365), // Keep vector metadata for a year
            }],
            publicReadAccess: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });

        const vectorBackupBucket = new s3.Bucket(this, 'VecBackupBucket', {
            bucketName: `rag-vector-backup-${this.account}-${this.region}`,
            versioned: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            lifecycleRules: [{
                id: 'DeleteOldVectorBackups',
                enabled: true,
                expiration: cdk.Duration.days(30), // Keep backups for 30 days
            }],
            publicReadAccess: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });

        // === LAMBDA FUNCTIONS ===

        // Status handler Lambda for WebUI tracking
        const statusHandler = new NodejsFunction(this, 'VecStatusHandler', {
            functionName: `rag-vector-storage-status-${this.account}-${this.region}`,
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

        // Health check Lambda for monitoring home server
        const healthCheckHandler = new NodejsFunction(this, 'VecHealthCheckHandler', {
            functionName: `rag-vector-storage-health-check-${this.account}-${this.region}`,
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

        // === PERMISSIONS ===

        // Grant S3 permissions
        const embeddingsBucket = s3.Bucket.fromBucketName(this, 'VecEmbeddingsBucket', embeddingsBucketName);
        embeddingsBucket.grantRead(statusHandler);

        vectorMetadataBucket.grantRead(statusHandler);
        vectorMetadataBucket.grantReadWrite(healthCheckHandler);

        // === SCHEDULED MONITORING ===

        // EventBridge rule for health checks
        const healthCheckRule = new events.Rule(this, 'VecHealthCheckRule', {
            schedule: events.Schedule.rate(cdk.Duration.minutes(10)), // Health check every 10 minutes
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

        // === HTTP API FOR STATUS TRACKING ===

        // CORS configuration
        const allowedOrigins = ['http://localhost:5173'];
        allowedOrigins.push(`https://${props.webUiDomain}`);

        // HTTP API Gateway with JWT authentication
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

        // Status endpoint
        this.httpApi.addRoutes({
            path: '/status/{documentId}',
            methods: [apigatewayv2.HttpMethod.GET],
            integration: new apigatewayv2Integrations.HttpLambdaIntegration('VecStatusIntegration', statusHandler),
        });

        // Vector search proxy endpoint - TODO: Add when handler is implemented
        // this.httpApi.addRoutes({
        //     path: '/search',
        //     methods: [apigatewayv2.HttpMethod.POST],
        //     integration: new apigatewayv2Integrations.HttpLambdaIntegration('VecSearchIntegration', vectorStorageProxyHandler),
        // });

        // Health check endpoint
        this.httpApi.addRoutes({
            path: '/health',
            methods: [apigatewayv2.HttpMethod.GET],
            integration: new apigatewayv2Integrations.HttpLambdaIntegration('VecHealthIntegration', healthCheckHandler),
        });

        // Set up custom domain for API Gateway
        const hostedZone = HostedZone.fromHostedZoneAttributes(this, 'VecApiHostedZone', {
            hostedZoneId: hostedZoneId,
            zoneName: zoneName,
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

        // === OUTPUTS ===

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

        // OndemandEnv Producers - Share values with other services
        new OdmdShareOut(
            this, new Map([
                // Vector database resources
                [myEnver.vectorStorage.vectorDatabaseEndpoint, homeServerDomain],
                [myEnver.vectorStorage.vectorIndexName, 'rag-documents'], // Default index name
                [myEnver.vectorStorage.vectorMetadataBucket, vectorMetadataBucket.bucketName],
                [myEnver.vectorStorage.vectorBackupBucket, vectorBackupBucket.bucketName],

                // Status API endpoint for WebUI tracking
                [myEnver.statusApi.statusApiEndpoint, `https://${this.apiDomain}/status`],
            ])
        );
    }
} 