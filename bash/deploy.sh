#!/bin/bash

export AWS_REGION="us-east-1"
# Set AWS profile
AWS_PROFILE="mostrom_mgmt"

# Get stack names from `cdk list`, filter for "stage", and exclude ones starting with "prod"
stack_names=$(cdk list --profile mostrom_mgmt | grep possible | grep -v 'prod' | awk -F ' ' '{print $1}')

# Loop through the stack names
for stack_name in $stack_names; do
  echo "Running commands for stack: $stack_name"

  # Synthesize the stack
  cdk synth "$stack_name" --profile $AWS_PROFILE --no-bundling

  # Deploy the stack
  cdk deploy "$stack_name" --profile $AWS_PROFILE --require-approval never 

  echo "Finished running commands for stack: $stack_name"
done
