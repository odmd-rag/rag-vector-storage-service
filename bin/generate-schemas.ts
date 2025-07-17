#!/usr/bin/env npx tsx

import {execSync} from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {SSMClient, GetParameterCommand} from '@aws-sdk/client-ssm';
import {S3Client, GetObjectCommand} from '@aws-sdk/client-s3';
import {STSClient, AssumeRoleCommand, GetCallerIdentityCommand} from '@aws-sdk/client-sts';
import * as cdk from "aws-cdk-lib";
import {RagContracts, RagVectorStorageEnver} from "@odmd-rag/contracts-lib-rag";
import {AwsCredentialIdentity} from "@smithy/types/dist-types/identity/awsCredentialIdentity";


interface GeneratedSchema {
    consumerId: string;
    schemaPath: string;
    schemaS3Url: string;
    ver: string;
    jsonSchemaStr: any;
}

export class SchemaTypeGenerator {
    private outputDir = path.join(__dirname, '../lib/handlers/src', '__generated__');

    constructor() {
        console.log(`🚀 Starting schema type generation for vector-storage handlers ${process.env.ODMD_buildId!}/${process.env.ODMD_rev_ref!}`);
    }

    async run(): Promise<void> {
        const myEnver = RagContracts.inst.getTargetEnver() as RagVectorStorageEnver;

        const client = new STSClient({});
        const callerIdResp = await client.send(new GetCallerIdentityCommand({}));

        console.log("Caller:", JSON.stringify(callerIdResp, null, 2));

        let buildRoleCreds;
        if (callerIdResp.Arn !== myEnver.buildRoleArn) {
            buildRoleCreds = await this.stsAssumeRole(myEnver.buildRoleArn);
        } else {
            buildRoleCreds = undefined; // Use default credentials
        }

        const ssmClient = new SSMClient({credentials: buildRoleCreds})

        // Vector storage service consumes schema from embedding service
        const consumers = [myEnver.embeddingStatusSchemaS3Url]


        const enverConfResp = await ssmClient.send(new GetParameterCommand({
            Name: `/odmd-${myEnver.owner.buildId}/${myEnver.targetRevision.toPathPartStr()}/enver_config`
        }));

        const paramValLineArr = enverConfResp.Parameter!.Value!.split('\n') as string[]

        this.ensureOutputDirectory();

        const s3Client = new S3Client({credentials: await this.stsAssumeRole(myEnver.centralRoleArn, buildRoleCreds)})

        const schemas = await Promise.allSettled(
            consumers.map(async c => {
                const cl = paramValLineArr.find(p => p.startsWith(c.node.id + ':'))!
                // s3://odmd-build-ragingest-ragingestartifactse23a694f-8mgcyxvb7dyf/366920167720/store-schema.json@haEk7y4ShsOj7WFpuXkcn39_TKhkiMxs
                const schemaS3Url = cl.substring((c.node.id + ':').length);
                const tmpArr = schemaS3Url.split('/')
                const [Bucket, Kav] = [tmpArr[2], tmpArr.slice(3).join('/')]
                const [Key, ver ] = Kav.split('@')

                const response = await s3Client.send(new GetObjectCommand({Bucket, Key}))

                const jsonSchemaStr = await response.Body!.transformToString();
                const ret = {
                    consumerId: c.node.id,
                    schemaS3Url,
                    ver: ver,
                    jsonSchemaStr
                } as GeneratedSchema;
                await this.generateTypeScriptTypes(ret, response.LastModified!)
                return ret
            }))

        const generatedSchemas: GeneratedSchema[] = schemas.map(a => {
            if (a.status == 'fulfilled') {
                return a.value as GeneratedSchema
            } else {
                throw new Error(a.reason)
            }
        })

        console.log(`\n🎉 Successfully generated types for ${generatedSchemas.length} schema(s)`);
        console.log(`📁 Output directory: ${this.outputDir}`);
    }

    private async stsAssumeRole(roleArn: string, credentials?: AwsCredentialIdentity): Promise<AwsCredentialIdentity> {
        console.log('🔑 Assuming build role...');
        const stsClient = new STSClient({credentials});
        const command = new AssumeRoleCommand({
            RoleArn: roleArn,
            RoleSessionName: `schema-gen-${Date.now()}`,
            DurationSeconds: 3600 // 1 hour
        });

        const response = await stsClient.send(command);

        const creds = response.Credentials;
        if (!creds) {
            throw new Error('Failed to assume role - no credentials returned');
        }

        return {
            accessKeyId: creds.AccessKeyId,
            secretAccessKey: creds.SecretAccessKey,
            sessionToken: creds.SessionToken
        } as AwsCredentialIdentity
    }

    private ensureOutputDirectory(): void {
        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, {recursive: true});
            console.log(`📁 Created output directory: ${this.outputDir}`);
        } else {
            console.log(`files in output dir: ${fs.readdirSync(this.outputDir).map(f => {
                return path.join(this.outputDir, f);
            }).join('\n')}`);
        }
    }

    private async generateTypeScriptTypes(schema: GeneratedSchema, time: Date): Promise<void> {
        console.log(`generateTypeScriptTypes: ${JSON.stringify(schema, null, 2)}`);
        const {consumerId, schemaS3Url, ver, jsonSchemaStr} = schema;

        const schemaFileName = `${consumerId}-${schema.ver}.schema.json`;
        const schemaFilePath = path.join(this.outputDir, schemaFileName);

        console.log(`generateTypeScriptTypes fs.writeFileSync: ${schemaFilePath}`);
        fs.writeFileSync(schemaFilePath, jsonSchemaStr);

        const bannerComment = `/* AUTO-GENERATED ⏤ schema-sha:${ver} source:${schemaS3Url} consumer:${consumerId} */`;

        try {
            // Generate Zod schemas using json-schema-to-zod
            const zodFileName = `${consumerId}-${schema.ver}.zod.ts`;
            const zodFilePath = path.join(this.outputDir, zodFileName);
            
            // Create valid JavaScript identifier name
            const camelCaseConsumerId = consumerId.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
            const zodCommand = `npx json-schema-to-zod --input "${schemaFilePath}" --name "${camelCaseConsumerId}Schema" --noImport`;
            
            const zodSchemas = execSync(zodCommand, {
                encoding: 'utf8',
                cwd: path.dirname(this.outputDir)
            });
            
            // Create content with both schema and inferred types
            const zodContent = `${bannerComment}

import { z } from 'zod';

${zodSchemas}

// Inferred TypeScript types from Zod schemas
export type ${camelCaseConsumerId}Schema = z.infer<typeof ${camelCaseConsumerId}Schema>;`;
            
            fs.writeFileSync(zodFilePath, zodContent);
            
            console.log(`✅ Generated Zod schemas and types for ${consumerId} (SHA: ${ver})`);

        } catch (error) {
            console.error(`❌ Failed to generate Zod schemas for ${consumerId}:`, error);
            throw error;
        }
    }
}

// Run as the script
if (require.main === module) {
    if (!process.env.REGION || process.env.REGION == 'undefined') {
        const region = 'us-east-2';
        process.env.CDK_DEFAULT_REGION = region
        process.env.REGION = region
    }

    if (!process.env.ODMD_buildId || process.env.REGODMD_buildId == 'undefined' || !process.env.ODMD_rev_ref || process.env.ODMD_rev_ref == 'undefined') {
        process.env.ODMD_buildId = 'ragStore'
        process.env.ODMD_rev_ref = 'b..dev'
    }

    process.env.CDK_DEFAULT_ACCOUNT = 'dummy'
    process.env.CDK_CLI_VERSION = 'dummy'

    new RagContracts(new cdk.App());

    const generator = new SchemaTypeGenerator();
    generator.run().catch(console.error);
}