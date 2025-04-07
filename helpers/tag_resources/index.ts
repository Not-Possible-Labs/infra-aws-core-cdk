import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";

interface TaggingProps {
  project: string;
  service: string;
  environment: string;
  prefix?: string; // Optional prefix for Name tags
  customTags?: { [key: string]: string }; // Optional additional tags
}

// Helper function to add consistent tags to resources
export const addStandardTags = (construct: Construct | cdk.Resource | cdk.Stack, props: TaggingProps) => {
  cdk.Tags.of(construct).add("Project", props.project);
  cdk.Tags.of(construct).add("Service", props.service);
  cdk.Tags.of(construct).add("Environment", props.environment);

  // Add Name tag for resources that traditionally use it
  if (construct instanceof ec2.SecurityGroup && props.prefix) {
    cdk.Tags.of(construct).add("Name", `${props.prefix}-fargate`);
  }

  // Add any custom tags
  if (props.customTags) {
    Object.entries(props.customTags).forEach(([key, value]) => {
      cdk.Tags.of(construct).add(key, value);
    });
  }
};
