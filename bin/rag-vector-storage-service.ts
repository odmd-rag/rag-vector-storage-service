#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { StackProps } from 'aws-cdk-lib';
import { RagVectorStorageServiceStack } from '../lib/rag-vector-storage-service-stack';
import { RagContracts, RagVectorStorageEnver } from '@odmd-rag/contracts-lib-rag';

const app = new cdk.App({autoSynth: false});

async function main() {
    const buildRegion = process.env.CDK_DEFAULT_REGION;
    const buildAccount = process.env.CDK_DEFAULT_ACCOUNT;
    if (!buildRegion || !buildAccount) {
        throw new Error("buildRegion>" + buildRegion + "; buildAccount>" + buildAccount);
    }


    new RagContracts(app);

    const targetEnver = RagContracts.inst.getTargetEnver() as RagVectorStorageEnver;

    // Create the main vector storage stack using OnDemandEnv pattern
    const mainStack = new RagVectorStorageServiceStack(app, targetEnver, {
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