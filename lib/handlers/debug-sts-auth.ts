#!/usr/bin/env ts-node

/**
 * Debug script to test AWS STS authentication with home vector server
 * This script calls upsertVectorsToHomeServer directly to debug authentication issues
 */

// Configure environment for localhost testing
process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-2';
process.env.HOME_SERVER_DOMAIN = 'localhost:3000';

import { UpsertChunk } from './src/schemas/upsert-request.schema';
import { upsertVectorsToHomeServer, createSignedRequest } from './src/vector-processor';
import { fromIni } from '@aws-sdk/credential-providers';
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { HttpRequest } from '@aws-sdk/protocol-http';
import { fromUtf8 } from '@aws-sdk/util-utf8';
import { Sha256 } from '@aws-crypto/sha256-js';


async function main() {
    const requestId = `debug-${Date.now()}`;
    console.log(`🔍 Starting STS authentication debug with request ID: ${requestId}`);
    console.log(`🎯 Target server: ${process.env.HOME_SERVER_DOMAIN}`);
    console.log(`🌍 AWS Region: ${process.env.AWS_REGION}`);
    
    // Load AWS credentials from profile and set as environment variables
    const awsProfile = process.env.AWS_PROFILE || 'default';
    console.log(`👤 AWS Profile: ${awsProfile}`);
    
    try {
        const credentialsProvider = fromIni({ profile: awsProfile });
        const credentials = await credentialsProvider();
        
        // Set credentials as environment variables for vector-processor to use
        process.env.AWS_ACCESS_KEY_ID = credentials.accessKeyId;
        process.env.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey;
        if (credentials.sessionToken) {
            process.env.AWS_SESSION_TOKEN = credentials.sessionToken;
        }
        
        console.log(`🔑 Loaded credentials from profile: ${awsProfile}`);
        console.log(`🎫 Has session token: ${!!credentials.sessionToken}`);
        console.log('');
        
        // FIRST: Test that we can make a proper STS request with current credentials
        console.log('🧪 Step 1: Testing direct STS GetCallerIdentity to validate credentials...');
        await testDirectStsCredentials(requestId);
        console.log('');
        
        // SECOND: Test the createSignedRequest function (which creates fake STS headers for home server)
        console.log('🧪 Step 2: Testing vector-processor createSignedRequest function...');
        await testCreateSignedRequestFunction(requestId);
        console.log('');
        
    } catch (error) {
        console.error('❌ Failed to load AWS credentials from profile:', error);
        console.error('Make sure you have configured AWS credentials in ~/.aws/credentials');
        process.exit(1);
    }

    // Create test payload similar to what the lambda would send
    const testChunks: UpsertChunk[] = [
        {
            documentId: `debug-${Date.now()}-test-document.txt`,
            chunkId: `debug-chunk-1-${Date.now()}`,
            text: 'This is a test chunk for debugging AWS STS authentication',
            vector: new Array(1536).fill(0.1), // Mock embedding vector
            s3Bucket: 'debug-test-bucket',
            s3Key: 'debug-test-key.txt',
            metadata: {
                chunkIndex: 0,
                totalChunks: 1,
                model: 'text-embedding-ada-002'
            }
        }
    ];

    try {
        console.log('📤 Calling upsertVectorsToHomeServer with test data...');
        console.log(`   - Chunk count: ${testChunks.length}`);
        console.log(`   - Document ID: ${testChunks[0].documentId}`);
        console.log(`   - Vector dimensions: ${testChunks[0].vector.length}`);
        console.log('');

        // This will call the ACTUAL upsertVectorsToHomeServer function from vector-processor.ts
        // which internally calls createSignedRequest and makes HTTP request to localhost:3000
        const result = await upsertVectorsToHomeServer(testChunks, requestId);
        
        console.log('✅ Success! Upsert completed successfully');
        console.log('📊 Result:', JSON.stringify(result, null, 2));
        
    } catch (error) {
        console.error('❌ Debug test failed:');
        console.error('Error message:', error instanceof Error ? error.message : 'Unknown error');
        console.error('Error stack:', error instanceof Error ? error.stack : 'No stack trace');
        
        if (error instanceof Error && error.message.includes('Unexpected token')) {
            console.log('');
            console.log('🔍 Analysis: The error suggests STS is returning HTML instead of JSON');
            console.log('   This typically indicates:');
            console.log('   1. Network connectivity issues to AWS STS');
            console.log('   2. DNS resolution problems');
            console.log('   3. Corporate firewall/proxy intercepting requests');
            console.log('   4. AWS region configuration issues');
            console.log('');
            console.log('💡 Next steps:');
            console.log('   - Check if your local machine can reach sts.us-east-2.amazonaws.com');
            console.log('   - Try running: curl -v https://sts.us-east-2.amazonaws.com/');
            console.log('   - Verify AWS credentials are valid');
            console.log('   - Check if behind corporate proxy/firewall');
        }
        
        process.exit(1);
    }
}

/**
 * Test direct STS GetCallerIdentity to validate credentials work
 */
async function testDirectStsCredentials(requestId: string): Promise<void> {
    try {
        const region = process.env.AWS_REGION || 'us-east-2';
        const stsUrl = `https://sts.${region}.amazonaws.com/`;
        const stsBody = 'Action=GetCallerIdentity&Version=2011-06-15';
        
        console.log(`[${requestId}] 🔐 Making proper STS GetCallerIdentity request...`);
        console.log(`[${requestId}] 🌐 STS URL: ${stsUrl}`);
        
        // Create proper STS request with correct signing
        const credentials = {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
            sessionToken: process.env.AWS_SESSION_TOKEN
        };
        
        const stsRequest = new HttpRequest({
            method: 'POST',
            protocol: 'https:',
            hostname: `sts.${region}.amazonaws.com`,
            port: 443,
            path: '/',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
                'Host': `sts.${region}.amazonaws.com`
            },
            body: fromUtf8(stsBody)
        });

        const stsSigner = new SignatureV4({
            service: 'sts',
            region,
            credentials,
            sha256: Sha256
        });

        const signedRequest = await stsSigner.sign(stsRequest);
        
        // Convert headers for fetch
        const fetchHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(signedRequest.headers)) {
            fetchHeaders[key] = Array.isArray(value) ? value.join(',') : value;
        }
        
        const response = await fetch(stsUrl, {
            method: 'POST',
            headers: fetchHeaders,
            body: stsBody
        });
        
        console.log(`[${requestId}] 📡 STS Response: ${response.status} ${response.statusText}`);
        
        if (response.ok) {
            const responseText = await response.text();            
            if (responseText.includes('<GetCallerIdentityResponse')) {
                console.log(`[${requestId}] ✅ Credentials are valid! STS authentication works.`);
                
                const accountMatch = responseText.match(/<Account>(\d+)<\/Account>/);
                const arnMatch = responseText.match(/<Arn>([^<]+)<\/Arn>/);
                
                if (accountMatch && arnMatch) {
                    console.log(`[${requestId}] 🎯 Identity - Account: ${accountMatch[1]}, Arn: ${arnMatch[1]}`);
                }
            }
        } else {
            const errorText = await response.text();
            console.error(`[${requestId}] ❌ STS Request failed: ${response.status} ${response.statusText}`);
            console.error(`[${requestId}] Error:`, errorText.substring(0, 500));
            throw new Error(`Credentials validation failed: ${response.status}`);
        }
        
    } catch (error) {
        console.error(`[${requestId}] ❌ Direct STS test failed:`, error);
        throw error;
    }
}

/**
 * Test the createSignedRequest function (which creates headers for home vector server validation)
 */
async function testCreateSignedRequestFunction(requestId: string): Promise<void> {
    try {
        console.log(`[${requestId}] 🔐 Testing createSignedRequest function from vector-processor...`);
        
        // This function creates STS-compatible headers for the home vector server to validate
        // It's NOT meant to make actual STS requests, but to create headers that STS can validate
        const testUrl = `http://localhost:3000/upsert`;
        const testBody = JSON.stringify({ chunks: [] });
        
        const signedRequest = await createSignedRequest('POST', testUrl, testBody, requestId);
        
        console.log(`[${requestId}] ✅ createSignedRequest completed successfully`);
        console.log(`[${requestId}] 📋 Generated headers: ${Object.keys(signedRequest.headers).join(', ')}`);
        console.log(`[${requestId}] 🎯 These headers are meant for home vector server validation, not direct STS calls`);
        
    } catch (error) {
        console.error(`[${requestId}] ❌ createSignedRequest function test failed:`, error);
        throw error;
    }
}


// Run the debug script
if (require.main === module) {
    console.log('🚀 AWS STS Authentication Debug Script');
    console.log('=====================================');
    console.log('');
    
    main().catch(error => {
        console.error('💥 Debug script crashed:', error);
        process.exit(1);
    });
}

// Export main function for potential reuse
export { main as debugUpsertToHomeServer };