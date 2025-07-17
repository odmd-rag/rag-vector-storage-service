#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import {RagVectorStorageServiceStack} from '../lib/rag-vector-storage-service-stack';
import {RagContracts, RagVectorStorageEnver} from '@odmd-rag/contracts-lib-rag';
import {SchemaTypeGenerator} from "./generate-schemas";

const app = new cdk.App({autoSynth: false});

async function main() {
    const buildRegion = process.env.CDK_DEFAULT_REGION;
    const buildAccount = process.env.CDK_DEFAULT_ACCOUNT;
    if (!buildRegion || !buildAccount) {
        throw new Error("buildRegion>" + buildRegion + "; buildAccount>" + buildAccount);
    }

    new RagContracts(app);

    // Generate schema types from upstream embedding service for handlers
    const gen = new SchemaTypeGenerator();
    await gen.run();

    const targetEnver = RagContracts.inst.getTargetEnver() as RagVectorStorageEnver;

    new RagVectorStorageServiceStack(app, targetEnver, {
        env: {
            account: buildAccount,
            region: buildRegion
        }
    });

    app.synth();
}

console.log("main begin.");
main().catch(e => {
    console.error(e);
    throw e;
}).finally(() => {
    console.log("main end.");
}); 