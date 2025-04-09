#!/bin/bash

export AWS_PROFILE="mostrom_dev"

cluster_name="not-possible"

# Get list of service ARNs in the cluster
service_arns=$(aws ecs list-services --cluster "$cluster_name" --output text --query 'serviceArns[*]')

# Iterate through each service and set desired count to 0
for service_arn in $service_arns; do
    service=$(basename "$service_arn")
    echo "Starting service: $service"
    aws ecs update-service --cluster "$cluster_name" --service "$service" --desired-count 1 --force-new-deployment >/dev/null
done

