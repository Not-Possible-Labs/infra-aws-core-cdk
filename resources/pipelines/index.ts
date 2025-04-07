//import * as cdk from "aws-cdk-lib/core";

import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

import * as iam from "aws-cdk-lib/aws-iam";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codecommit from "aws-cdk-lib/aws-codecommit";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";
import * as awslogs from "aws-cdk-lib/aws-logs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as dotenv from "dotenv";
dotenv.config();
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import * as codestarnotifications from "aws-cdk-lib/aws-codestarnotifications";
import * as s3 from "aws-cdk-lib/aws-s3";

import { dockerBuildSpec, ecsDeploymentBuildSpec, NextJSDockerBuildSpec } from "./buildspec";

export interface PipelineStackProps extends cdk.StackProps {
  readonly project: string;
  readonly service: string;
  readonly type: string;
  readonly environment: string;
  readonly targetBranch: string;
  readonly imageTag: string;
  readonly ecsCluster: string;
  readonly ecsService: string;
  readonly roleARN: string;
  readonly github: string;
  readonly ecrURI: string;
  readonly vpcId: string;
  readonly desiredCount: number;
  readonly secretVariables: string[] | undefined;
  readonly secretArn: string;
}
export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    /**
     * 1. CodePipelines
     * 2. CodePipeline Roles
     * 3. Lambda Roles
     * 4. Lambda Functions
     */

    const prefix = `${props.environment}-${props.project}-${props.service}`;

    const vpc = ec2.Vpc.fromLookup(this, `${props.project}-imported-vpc`, { isDefault: false, vpcId: props.vpcId });
    const sourceArtifact = new codepipeline.Artifact();

    const gitHubSource = codebuild.Source.gitHub({
      owner: `${process.env.GITHUB_SOURCE_OWNER}`,
      repo: props.github,
      webhook: true, // optional, default: true if `webhookFilters` were provided, false otherwise
      webhookFilters: [codebuild.FilterGroup.inEventOf(codebuild.EventAction.PUSH).andBranchIs(`${props.targetBranch}`)], // optional, by default all pushes and Pull Requests will trigger a build
    });

    const role = new iam.Role(this, `${prefix}-pipeline-role`, {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal("codepipeline.amazonaws.com"),
        new iam.ServicePrincipal("codebuild.amazonaws.com"),
        new iam.AccountRootPrincipal()
      ),
      roleName: `${prefix}-pipeline-role`,
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: ["*"],
        actions: ["codecommit:*", "codebuild:*", "codepipeline:*", "logs:*", "s3:*", "kms:*", "ecr:*", "secretsmanager:*", "lambda:*"],
      })
    );

    role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        resources: [props.roleARN], //
        actions: ["sts:AssumeRole"],
      })
    );

    const securityGroup = new ec2.SecurityGroup(this, `${prefix}-code-pipeline-security-group`, {
      vpc: vpc,
      securityGroupName: `${prefix}-code-pipeline`,
      allowAllOutbound: true,
    });

    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.allTraffic(), "Allow Traffic");

    const secret = secretsmanager.Secret.fromSecretAttributes(this, `import-${prefix}-pipeline-environment-variables`, {
      secretCompleteArn: props.secretArn,
    });

    secret.grantRead(role);

    // Generate container secrets based on the specified list of secret names.
    const generateSecrets = (list: string[] | undefined) => {
      let environmentVariables: { [key: string]: codebuild.BuildEnvironmentVariable } = {};

      list?.forEach((item) => {
        environmentVariables[item] = {
          type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER,
          value: `${secret.secretArn}:${item}::`,
        };
      });

      return environmentVariables;
    };

    const buildSpec =
      props.type === "platform"
        ? NextJSDockerBuildSpec({ imageTag: props.imageTag, ecrURI: props.ecrURI, region: this.region, secretVariables: props.secretVariables! })
        : dockerBuildSpec({ imageTag: props.imageTag, ecrURI: props.ecrURI, region: this.region });

    const build = new codebuild.Project(this, `${prefix}-codebuild-project`, {
      source: gitHubSource,
      role: role,
      projectName: `${prefix}-docker`,
      description: `Build Project for ${prefix}`,
      vpc: vpc,
      subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [securityGroup],
      cache: codebuild.Cache.local(codebuild.LocalCacheMode.CUSTOM, codebuild.LocalCacheMode.DOCKER_LAYER),
      buildSpec: buildSpec,
      environment: {
        computeType: codebuild.ComputeType.SMALL,
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        //buildImage: props.type === "platform" ? codebuild.LinuxBuildImage.STANDARD_7_0 : codebuild.LinuxBuildImage.fromDockerRegistry("denoland/deno:2.2.8"),
        privileged: true,
        environmentVariables: props.type === "platform" ? generateSecrets(props.secretVariables) : undefined,
      },
      logging: {
        cloudWatch: {
          logGroup: new awslogs.LogGroup(this, `${prefix}-codebuild-build-log-group`, {
            logGroupName: `codebuild/${prefix}-build`,
            retention: awslogs.RetentionDays.ONE_DAY,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          }),
        },
      },
      timeout: cdk.Duration.minutes(15),
      badge: false,
    });

    const deploymentLogGroup = new awslogs.LogGroup(this, `${prefix}-codebuild-deploy-log-group`, {
      logGroupName: `codebuild/${prefix}-deploy`,
      retention: awslogs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const deploy = new codebuild.Project(this, `${prefix}-codebuild-deploy-project-`, {
      source: gitHubSource,
      role: role,
      projectName: `${prefix}-deploy-`,
      description: `Deployment Project for: ${prefix} us-east-1`,
      buildSpec: ecsDeploymentBuildSpec({
        cluster: props.ecsCluster,
        service: props.ecsService,
        roleARN: props.roleARN,
        desiredCount: props.desiredCount,
        region: "us-east-1",
      }),
      environment: { computeType: codebuild.ComputeType.SMALL, buildImage: codebuild.LinuxBuildImage.STANDARD_7_0, privileged: true },
      logging: {
        cloudWatch: {
          logGroup: deploymentLogGroup,
        },
      },
      timeout: cdk.Duration.minutes(15),
      badge: false,
    });

    const sourceAction = new codepipeline_actions.CodeStarConnectionsSourceAction({
      actionName: "github",
      owner: `${process.env.GITHUB_SOURCE_OWNER}`,
      repo: props.github,
      branch: props.targetBranch,
      output: sourceArtifact,
      role: role,
      triggerOnPush: true,
      connectionArn: `${process.env.CDK_CODESTAR_CONNECTION_ARN}`,
    });

    const buildAction = new codepipeline_actions.CodeBuildAction({
      actionName: "docker",
      role: role,
      project: build,
      input: sourceArtifact,
    });

    const manualApprovalAction = new codepipeline_actions.ManualApprovalAction({
      actionName: "approve",
      role: role,
    });

    const deployAction01 = new codepipeline_actions.CodeBuildAction({
      actionName: "us-east-1",
      role: role,
      project: deploy,
      input: sourceArtifact,
      type: codepipeline_actions.CodeBuildActionType.BUILD,
    });

    const pipeline = new codepipeline.Pipeline(this, `${prefix}-pipeline`, {
      pipelineName: `${prefix}`,
      role: role,
      crossAccountKeys: true,
      restartExecutionOnUpdate: true,
    });

    /********* PIPELINE STAGES **************/
    pipeline.addStage({ stageName: "Source", actions: [sourceAction] });
    pipeline.addStage({ stageName: "Build", actions: [buildAction] });
    pipeline.addStage({ stageName: "Deploy", actions: [deployAction01] });

    /************************************************** CODESTAR ******************************************************* */

    const SNSTopic = sns.Topic.fromTopicArn(
      this,
      `import-${props.project}-${props.service}-sns-topic-arn`,
      cdk.Fn.importValue(`${props.project}-codepipeline-sns-topic-arn`)
    );
    //https://docs.aws.amazon.com/dtconsole/latest/userguide/concepts.html#events-ref-pipeline
    const codePipelineRule = new codestarnotifications.NotificationRule(this, `${prefix}-codepipeline-notifications-rule`, {
      source: pipeline, //build,
      events: [
        "codepipeline-pipeline-manual-approval-needed",
        "codepipeline-pipeline-pipeline-execution-failed",
        "codepipeline-pipeline-action-execution-failed",
        "codepipeline-pipeline-stage-execution-failed",
        "codepipeline-pipeline-pipeline-execution-started",
      ],
      targets: [SNSTopic],
      enabled: true,
      detailType: codestarnotifications.DetailType.FULL,
      notificationRuleName: `${prefix}-codepipeline`,
    });

    SNSTopic.grantPublish(new iam.ArnPrincipal(codePipelineRule.notificationRuleArn));

    const codebuildRule = new codestarnotifications.NotificationRule(this, `${prefix}-codebuild-notifications-rule`, {
      source: build,
      events: ["codebuild-project-build-state-failed"],
      targets: [SNSTopic],
      enabled: true,
      detailType: codestarnotifications.DetailType.BASIC,
      notificationRuleName: `${prefix}-codebuild`,
    });

    SNSTopic.grantPublish(new iam.ArnPrincipal(codebuildRule.notificationRuleArn));

    const codeDeployRule = new codestarnotifications.NotificationRule(this, `${prefix}-codedeploy-notifications-rule`, {
      source: deploy,
      events: ["codebuild-project-build-state-failed"],
      targets: [SNSTopic],
      enabled: true,
      detailType: codestarnotifications.DetailType.BASIC,
      notificationRuleName: `${prefix}-codedeploy`,
    });
    SNSTopic.grantPublish(new iam.ArnPrincipal(codeDeployRule.notificationRuleArn));

    /************************** TAGS *************************************/
  }
}
