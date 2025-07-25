import { Handler, ScheduledEvent, APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

interface HealthCheckResult {
    status: 'healthy' | 'unhealthy';
    responseTime: number;
    timestamp: string;
    homeServer: {
        reachable: boolean;
        responseTime?: number;
        error?: string;
    };
}

export const handler: Handler<ScheduledEvent | APIGatewayProxyEvent> = async (event) => {
    console.log('Health check triggered');

    const homeServerDomain = process.env.HOME_SERVER_DOMAIN!;
    const startTime = Date.now();

    const healthResult: HealthCheckResult = {
        status: 'unhealthy',
        responseTime: 0,
        timestamp: new Date().toISOString(),
        homeServer: {
            reachable: false
        }
    };

    try {
        console.log(`Testing connectivity to: ${homeServerDomain}`);
        
        const homeServerStart = Date.now();
        const response = await fetch(`${homeServerDomain}/health`, {
            method: 'GET',
            headers: {
                'User-Agent': 'AWS-HealthCheck/1.0'
            },
            signal: AbortSignal.timeout(10000)
        });

        const homeServerResponseTime = Date.now() - homeServerStart;

        if (response.ok) {
            healthResult.homeServer.reachable = true;
            healthResult.homeServer.responseTime = homeServerResponseTime;
            healthResult.status = 'healthy';
            console.log(`Home server health check: OK (${homeServerResponseTime}ms)`);
        } else {
            healthResult.homeServer.error = `HTTP ${response.status}`;
            console.warn(`Home server returned status: ${response.status}`);
        }

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        healthResult.homeServer.error = errorMessage;
        console.error('Home server health check failed:', errorMessage);
    }

    healthResult.responseTime = Date.now() - startTime;

    console.log('Health check result:', {
        status: healthResult.status,
        responseTime: healthResult.responseTime,
        homeServerReachable: healthResult.homeServer.reachable
    });

    if ('httpMethod' in event) {
        return {
            statusCode: healthResult.status === 'healthy' ? 200 : 503,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify(healthResult)
        } as APIGatewayProxyResult;
    }

    return healthResult;
}; 