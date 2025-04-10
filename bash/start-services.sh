#!/bin/bash

export AWS_PROFILE="mostrom_dev"

cluster_name="not-possible"

# Get list of service ARNs in the cluster
service_arns=$(aws ecs list-services --cluster "$cluster_name" --output text --query 'serviceArns[*]')

# Iterate through each service and check its status
for service_arn in $service_arns; do
    service=$(basename "$service_arn")
    
    # Get current running count and desired count
    current_status=$(aws ecs describe-services --cluster "$cluster_name" --services "$service" --query 'services[0].{running:runningCount,desired:desiredCount}' --output json)
    running_count=$(echo $current_status | jq -r '.running')
    desired_count=$(echo $current_status | jq -r '.desired')
    
    # Only update if service is not running (desired or running count is 0)
    if [ "$running_count" -eq 0 ] || [ "$desired_count" -eq 0 ]; then
        echo "Starting service: $service (current running: $running_count, desired: $desired_count)"
        aws ecs update-service --cluster "$cluster_name" --service "$service" --desired-count 1 --force-new-deployment >/dev/null
    else
        echo "Service $service is already running (running: $running_count, desired: $desired_count)"
    fi
done
