import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as sns from "aws-cdk-lib/aws-sns";
import * as chatbot from "aws-cdk-lib/aws-chatbot";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Service } from "../../../properties";
import { addStandardTags } from "../../../helpers/tag_resources";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";

export interface DevOpsStackProps extends cdk.StackProps {
  readonly project: string;
  readonly slackWorkspaceId: string; //The WorkspaceID which can be found in AWS Chatbot Console
  readonly pipelineSlackChannelId: string; //The Slack Workspace ID which is found in Slack->Channel -> View Channel Details -> About
  readonly services: Service[];
}
export class DevOpsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DevOpsStackProps) {
    super(scope, id, props);

    // Create tagging props for the management stack
    const taggingProps = {
      project: props.project,
      service: "devops",
      environment: "shared", // DevOpsStack is typically a shared resource
      customTags: {
        Stack: "devops",
        ResourceType: "devops",
      },
    };

    // Add tags to the stack itself
    addStandardTags(this, taggingProps);



    /************************************* ECR Resources ****************************/

    props.services.forEach((service) => {
      switch (service.ecrRepositoryRequired) {
        case true:
          const repository = new ecr.Repository(this, `${props.project}-${service.name}-repository`, {
            repositoryName: `${props.project}-${service.name}`,
            imageScanOnPush: true,
          });

          // Apply tags to repository
          addStandardTags(repository, {
            ...taggingProps,
            service: service.name, // Override service to reflect the actual service
            customTags: {
              ...taggingProps.customTags,
              ResourceType: "ecr-repository",
            },
          });

          repository.addLifecycleRule({ tagPrefixList: ["dev", "stage", "master"], maxImageCount: 1 });
          repository.addLifecycleRule({ maxImageAge: cdk.Duration.days(90), tagPrefixList: ["dev", "stage"] });
          repository.addLifecycleRule({ tagStatus: ecr.TagStatus.UNTAGGED, maxImageCount: 1 });
          repository.grantPullPush(new iam.AccountRootPrincipal());
          repository.grantPullPush(new iam.AccountPrincipal(process.env.CDK_DEV_ACCOUNT));
          repository.grantPullPush(new iam.AccountPrincipal(process.env.CDK_PROD_ACCOUNT));
          repository.grantPullPush(new iam.ServicePrincipal("ecs-tasks.amazonaws.com"));

          repository.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

          // Corrected Resource Policy
          repository.addToResourcePolicy(
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "ecr:BatchCheckLayerAvailability",
                "ecr:BatchGetImage",
                "ecr:CompleteLayerUpload",
                "ecr:GetDownloadUrlForLayer",
                "ecr:InitiateLayerUpload",
                "ecr:PutImage",
                "ecr:UploadLayerPart",
              ],
              principals: [
                new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
                new iam.ArnPrincipal("arn:aws:iam::366394957699:root"),
                new iam.ArnPrincipal("arn:aws:iam::896502667345:root"),
                new iam.ArnPrincipal("arn:aws:iam::736548610362:root"),
              ],
            })
          );
          break;

        default:
          break;
      }
    });

    /************************************* CHATBOT ****************************/

    const chatbotSlackRole = new iam.Role(this, `${props.project}-chatbot-slack-role`, {
      assumedBy: new iam.ServicePrincipal("chatbot.amazonaws.com"),
      roleName: `${props.project}-chatbot-slack-role`,
    });
    addStandardTags(chatbotSlackRole, {
      ...taggingProps,
      customTags: {
        ...taggingProps.customTags,
        ResourceType: "iam-role",
        Purpose: "chatbot",
      },
    });

    /*************************** SNS TOPIC ************************/

    const codePipelineSnsTopic = new sns.Topic(this, `${props.project}-codepipeline-sns-topic`, {
      displayName: `${props.project}-codepipeline`,
      topicName: `${props.project}-codepipeline`,
    });
    codePipelineSnsTopic.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    addStandardTags(codePipelineSnsTopic, {
      ...taggingProps,
      customTags: {
        ...taggingProps.customTags,
        ResourceType: "sns-topic",
        Purpose: "codepipeline-notifications",
      },
    });

    codePipelineSnsTopic.grantPublish(new iam.AccountRootPrincipal());
    codePipelineSnsTopic.grantPublish(new iam.ServicePrincipal("codestar-notifications.amazonaws.com"));

    new cdk.CfnOutput(this, `${props.project}-codepipeline-sns-topic-arn`, {
      value: codePipelineSnsTopic.topicArn,
      description: "The ARN for the SNS Topic",
      exportName: `${props.project}-codepipeline-sns-topic-arn`,
    });

    /************************************************** CHATBOT CONFIGURATION ******************************************************* */

    const channelConfiguration = new chatbot.SlackChannelConfiguration(this, `${props.project}-codepipeline-slack-channel-configuration`, {
      slackChannelConfigurationName: props.pipelineSlackChannelId,
      slackWorkspaceId: props.slackWorkspaceId,
      slackChannelId: props.pipelineSlackChannelId,
      role: chatbotSlackRole,
    });
    addStandardTags(channelConfiguration, {
      ...taggingProps,
      customTags: {
        ...taggingProps.customTags,
        ResourceType: "chatbot",
        Purpose: "slack-notifications",
      },
    });

    channelConfiguration.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    channelConfiguration.addNotificationTopic(codePipelineSnsTopic);
  }
}

/****************************** NEW ******************************************/

export interface SharedServicesStackProps extends cdk.StackProps {
  readonly environment: string;
  readonly project: string;
  readonly domain: string;
  readonly vpcId: string;
  readonly certificate?: string;
  readonly whitelist?: Array<{ address: string; description: string }>;
}
export class SharedServicesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SharedServicesStackProps) {
    super(scope, id, props);

    const prefix = `${props.environment}-${props.project}`;

    // Create tagging props object
    const taggingProps = {
      project: props.project,
      service: "shared", // Since this is a shared services stack
      environment: props.environment,
      prefix: prefix,
    };

    /**
     * CDK IMPORTS
     */
    const vpc = ec2.Vpc.fromLookup(this, `${prefix}-imported-vpc`, { isDefault: false, vpcId: props.vpcId });
    /************************************************** ECS ******************************************************* */

    const cluster = new ecs.Cluster(this, `${prefix}-ecs-cluster`, {
      vpc: vpc,
      enableFargateCapacityProviders: true,
      containerInsights: true,
      clusterName: `${props.project}`,
    });
    addStandardTags(cluster, taggingProps);

    /************************************************** Cross Zone Delegation Record ******************************************************* */
    const subZone = new route53.PublicHostedZone(this, `${prefix}-public-hosted-zone`, {
      zoneName: `${props.environment}.${props.domain}`,
    });

    new cdk.CfnOutput(this, `${prefix}-hosted-zone-id`, {
      value: subZone.hostedZoneId,
      exportName: `${prefix}-hosted-zone-id`,
      description: "The ID of the public hosted zone"
    });

    // import the delegation role by constructing the roleArn
    const delegationRoleArn = cdk.Stack.of(this).formatArn({
      region: '', // IAM is global in each partition
      service: 'iam',
      account: process.env.CDK_DEFAULT_ACCOUNT!,
      resource: 'role',
      resourceName: 'AdministratorInboundAccessRole',
    });
    const delegationRole = iam.Role.fromRoleArn(this, `${prefix}-delegation-role`, delegationRoleArn);

    // create the record
    new route53.CrossAccountZoneDelegationRecord(this, `${prefix}-cross-account-zone-delegation-record`, {
      delegatedZone: subZone,
      parentHostedZoneName: `${props.domain}`, // or you can use parentHostedZoneId
      delegationRole,
    });

    const certificate = new acm.Certificate(this, `${prefix}-certificate`, {
      domainName: `${props.environment}.${props.domain}`,
      validation: acm.CertificateValidation.fromDns(),
      subjectAlternativeNames: [`*.${props.environment}.${props.domain}`],
    });

    certificate.node.addDependency(subZone)

    /************************************************** SHARED APPLICATION LOAD BALANCER ******************************************************* */

    const loadBalancerSecurityGroup = new ec2.SecurityGroup(this, `${prefix}-alb-security-group`, {
      vpc: vpc,
      securityGroupName: `${prefix}-load-balancer`,
      allowAllOutbound: true,
    });
    addStandardTags(loadBalancerSecurityGroup, taggingProps);

    loadBalancerSecurityGroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new cdk.CfnOutput(this, `${props.environment}-load-balancer-sg-id`, {
      value: loadBalancerSecurityGroup.securityGroupId,
      description: "The id for the load balancer security group",
      exportName: `${prefix}-load-balancer-sg-id`,
    });

    if (props.environment === "prod") {
      loadBalancerSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.allTraffic(), "Allow all traffic");
    }

    props.whitelist?.forEach((ip) => {
      loadBalancerSecurityGroup.addIngressRule(ec2.Peer.ipv4(`${ip.address}`), ec2.Port.allIcmp(), `Allow all traffic for ${ip.description}`);
      loadBalancerSecurityGroup.addIngressRule(ec2.Peer.ipv4(`${ip.address}`), ec2.Port.allTraffic(), `Allow all traffic for ${ip.description}`);
    });

    /**
     * CREATE ALB
     */
    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, `${prefix}-application-load-balancer`, {
      vpc: vpc,
      internetFacing: true,
      loadBalancerName: `${prefix}`,
      deletionProtection: false,
      vpcSubnets: { subnets: vpc.publicSubnets, availabilityZones: this.availabilityZones },
      ipAddressType: elbv2.IpAddressType.IPV4,
      securityGroup: loadBalancerSecurityGroup,
      idleTimeout: cdk.Duration.seconds(30),
    });
    addStandardTags(loadBalancer, taggingProps);

    new cdk.CfnOutput(this, `${prefix}-load-balancer-dns`, {
      value: loadBalancer.loadBalancerDnsName,
      description: "The DNS for the load balancer",
      exportName: `${prefix}-load-balancer-dns`,
    });

    loadBalancer.addRedirect({
      sourceProtocol: elbv2.ApplicationProtocol.HTTP,
      sourcePort: 80,
      targetProtocol: elbv2.ApplicationProtocol.HTTPS,
      targetPort: 443,
    });

    const HTTPSListener = loadBalancer.addListener(`${prefix}-https-listener`, {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      open: true,
    });
    addStandardTags(HTTPSListener, taggingProps);

    new cdk.CfnOutput(this, `${prefix}-https-listener-arn`, {
      value: HTTPSListener.listenerArn,
      description: "The ARN for the HTTPS Listener",
      exportName: `${prefix}-https-listener-arn`,
    });

    HTTPSListener.connections.allowFrom(loadBalancer, ec2.Port.tcp(80), `Allow connections from ${prefix} load balancer on port 80`);
    HTTPSListener.connections.allowFrom(loadBalancer, ec2.Port.tcp(443), `Allow connections from ${prefix} load balancer on port 443`);

    HTTPSListener.addAction(`${prefix}-default-action`, {
      action: elbv2.ListenerAction.fixedResponse(200, { messageBody: JSON.stringify({ response: 200, message: prefix }) }),
    });

    HTTPSListener.addAction("Fixed", {
      priority: 30,
      conditions: [elbv2.ListenerCondition.pathPatterns(["/healthCheck"])],
      action: elbv2.ListenerAction.fixedResponse(200, { messageBody: JSON.stringify({ response: 200, message: "healthy" }) }),
    });

    /*************** Internal DNS ***************/

    /*  const internalZone = new route53.PrivateHostedZone(this, `${prefix}-internal-zone`, {
       zoneName: `${props.project}.internal`,
       vpc: vpc,
     });
     addStandardTags(internalZone, taggingProps);
 
     new cdk.CfnOutput(this, `${prefix}-internal-zone-id`, {
       value: internalZone.hostedZoneId,
       description: "The ID for the internal zone",
       exportName: `${prefix}-internal-zone-id`,
     }); */
  }
}

/* export interface Route53StackProps extends cdk.StackProps {
  readonly environment: string;
  readonly project: string;
  readonly service: string;
  readonly hostedZoneName: string;
  readonly recordName: string;
  readonly value: string;
}
export class Route53CreateCNAMEStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Route53StackProps) {
    super(scope, id, props);

    const prefix = `${props.environment}-${props.project}-${props.service}`;

    const hostedZone = route53.HostedZone.fromLookup(this, `${prefix}-importing-hosted-zone`, {
      domainName: props.hostedZoneName, //e.g. example.com
    });

    new route53.CnameRecord(this, `${prefix}-route53-cname-record`, {
      domainName: props.value,
      zone: hostedZone,
      comment: `Create the CNAME record for ${prefix} in ${props.hostedZoneName}`,
      recordName: props.recordName,
      ttl: cdk.Duration.minutes(30),
    });
  }
} */
