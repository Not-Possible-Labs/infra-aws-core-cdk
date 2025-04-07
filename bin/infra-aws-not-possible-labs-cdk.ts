#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { InfraAwsNotPossibleLabsCdkStack } from "../lib/infra-aws-not-possible-labs-cdk-stack";

const app = new cdk.App();
new InfraAwsNotPossibleLabsCdkStack(app, "InfraAwsNotPossibleLabsCdkStack", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  stackName: "infra-aws-not-possible-labs-cdk",
  description: "Deploys infrastructure",
});
