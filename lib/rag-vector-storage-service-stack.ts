import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { RagVectorStorageEnver } from '@odmd-rag/contracts-lib-rag';

export interface RagVectorStorageStackProps extends cdk.StackProps {
}

export class RagVectorStorageStack extends cdk.Stack {
    constructor(scope: Construct, myEnver: RagVectorStorageEnver, props: RagVectorStorageStackProps) {
        const id = myEnver.getRevStackNames()[0];
        super(scope, id, props);

        // Get authentication information from contracts (OnDemandEnv pattern)
        const clientId = myEnver.authProviderClientId.getSharedValue(this);
        const providerName = myEnver.authProviderName.getSharedValue(this);

        // Get home server URL from contracts (OnDemandEnv pattern)
        const homeVectorServerUrl = myEnver.homeServerDomain.getSharedValue(this);

        // Create Health Check Lambda
        const healthCheckLambda = new NodejsFunction(this, 'HealthCheck', {
            functionName: `rag-vector-health-${this.account}-${this.region}`,
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'handler',
            entry: 'lib/handlers/src/health-check.ts',
            timeout: cdk.Duration.seconds(30),
            memorySize: 128,
            environment: {
                HOME_VECTOR_SERVER_URL: homeVectorServerUrl,
            },
            description: 'Health check for home vector server connectivity',
        });

        // Create HTTP API Gateway with JWT Authorization (OnDemandEnv pattern)
        const httpApi = new apigatewayv2.HttpApi(this, 'VectorStorageApi', {
            apiName: 'RAG Vector Storage Service',
            description: 'Simple proxy API for vector storage operations',
            defaultAuthorizer: new HttpJwtAuthorizer('VectorStorageAuth',
                `https://${providerName}`,
                { jwtAudience: [clientId] }
            ),
            corsPreflight: {
                allowOrigins: ['*'], // Configure appropriately for production
                allowMethods: [
                    apigatewayv2.CorsHttpMethod.GET,
                    apigatewayv2.CorsHttpMethod.POST,
                    apigatewayv2.CorsHttpMethod.DELETE,
                    apigatewayv2.CorsHttpMethod.OPTIONS
                ],
                allowHeaders: ['Content-Type', 'Authorization'],
            },
        });

        // Create direct HTTP integration for vector operations
        const directHttpIntegration = new apigatewayv2Integrations.HttpUrlIntegration(
            'DirectVectorIntegration',
            `${homeVectorServerUrl}/{proxy}`,
            {
                method: apigatewayv2.HttpMethod.ANY,
                parameterMapping: new apigatewayv2.ParameterMapping()
                    .appendHeader('authorization', apigatewayv2.MappingValue.requestHeader('authorization'))
                    .overwritePath(apigatewayv2.MappingValue.requestPath())
            }
        );

        const healthIntegration = new apigatewayv2Integrations.HttpLambdaIntegration(
            'HealthCheckIntegration',
            healthCheckLambda
        );

        // Define API routes - using {proxy+} for direct forwarding to home server
        httpApi.addRoutes({
            path: '/{proxy+}',
            methods: [apigatewayv2.HttpMethod.ANY],
            integration: directHttpIntegration,
        });

        // Health endpoint (no auth required)
        httpApi.addRoutes({
            path: '/health',
            methods: [apigatewayv2.HttpMethod.GET],
            integration: healthIntegration,
            authorizer: new apigatewayv2.HttpNoneAuthorizer(),
        });

        // Schedule health checks every 5 minutes
        const healthCheckRule = new events.Rule(this, 'HealthCheckSchedule', {
            schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
            description: 'Scheduled health check for vector storage service',
        });

        healthCheckRule.addTarget(new targets.LambdaFunction(healthCheckLambda));

        // Grant Lambda permissions for EventBridge
        healthCheckLambda.addPermission('AllowEventBridgeInvoke', {
            principal: new iam.ServicePrincipal('events.amazonaws.com'),
            sourceArn: healthCheckRule.ruleArn,
        });

        // Outputs
        new cdk.CfnOutput(this, 'VectorStorageApiUrl', {
            value: httpApi.url!,
            description: 'Vector Storage Service API URL',
        });

        new cdk.CfnOutput(this, 'HealthCheckEndpoint', {
            value: `${httpApi.url}health`,
            description: 'Health check endpoint',
        });

        new cdk.CfnOutput(this, 'HomeVectorServerUrl', {
            value: homeVectorServerUrl,
            description: 'Home Vector Server URL (direct integration)',
        });

        new cdk.CfnOutput(this, 'HealthCheckLambdaName', {
            value: healthCheckLambda.functionName,
            description: 'Health Check Lambda function name',
        });
    }
} 