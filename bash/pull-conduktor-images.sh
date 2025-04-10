#!/bin/bash

# Set AWS profile
export AWS_PROFILE=mostrom_mgmt

# Login to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 366394957699.dkr.ecr.us-east-1.amazonaws.com

# Function to pull amd64 images
function pull_amd64_image {
    local image=$1
    local max_retries=3
    local retry_delay=30
    
    # Set platform to amd64
    for ((i=1; i<=max_retries; i++)); do
        echo "Attempting to pull amd64 version of $image (attempt $i of $max_retries)"
        docker pull --platform linux/amd64 "$image" && return 0
        sleep $retry_delay
    done
    echo "Failed to pull $image after $max_retries attempts"
    return 1
}

# Pull both images with retries
pull_amd64_image "conduktor/conduktor-console:1.30.0" || exit 1
pull_amd64_image "conduktor/conduktor-console-cortex:1.30.0" || exit 1

# Tag images
ECR_REPO="366394957699.dkr.ecr.us-east-1.amazonaws.com/infra-conduktor"

docker tag conduktor/conduktor-console:1.30.0 ${ECR_REPO}:conduktor-console
docker tag conduktor/conduktor-console-cortex:1.30.0 ${ECR_REPO}:conduktor-console-cortex

# Push images
docker push ${ECR_REPO}:conduktor-console
docker push ${ECR_REPO}:conduktor-console-cortex