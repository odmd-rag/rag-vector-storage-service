#!/usr/bin/env npx tsx

import * as cdk from "aws-cdk-lib";
import {RagContracts, RagVectorStorageEnver, SchemaTypeGenerator} from "@odmd-rag/contracts-lib-rag";


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
const targetEnver = RagContracts.inst.getTargetEnver() as RagVectorStorageEnver

const generator = new SchemaTypeGenerator(targetEnver, [targetEnver.embeddingStatusSchemaS3Url]);
generator.run().catch(console.error);