terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Backend configuration is provided via backend.hcl file
  # Usage: tofu init -backend-config=backend.hcl
  backend "s3" {}
}

provider "aws" {
  region = var.aws_region
}

# Get current AWS account ID for scoped permissions
data "aws_caller_identity" "current" {}

# ============================================================================
# S3 Bucket for Terraform State (INFRA-03, SEC-04)
# ============================================================================

resource "aws_s3_bucket" "terraform_state" {
  bucket = var.state_bucket

  tags = {
    Name        = "Terraform State Bucket"
    Environment = var.environment
    ManagedBy   = "terraform"
    Application = var.app_name
  }
}

# Enable versioning for state recovery (SEC-04)
resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Enable server-side encryption (INFRA-03, SEC-04)
resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
    # Keep SSE-C uploads blocked (matches live state; avoids provider-6.x drift)
    blocked_encryption_types = ["SSE-C"]
  }
}

# Block public access (INFRA-03)
resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Lifecycle policy to clean up old state versions after 30 days
resource "aws_s3_bucket_lifecycle_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    id     = "expire-old-versions"
    status = "Enabled"

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

# ============================================================================
# GitHub OIDC Provider (INFRA-01)
# ============================================================================

resource "aws_iam_openid_connect_provider" "github_actions" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]

  tags = {
    Environment = var.environment
    ManagedBy   = "terraform"
    Application = var.app_name
  }
}

# ============================================================================
# IAM Role for GitHub Actions (INFRA-01)
# ============================================================================

data "aws_iam_policy_document" "assume_role" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    effect  = "Allow"

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github_actions.arn]
    }

    # SECURITY: Allow main branch and pull requests from this repository
    # Prevents fork abuse by restricting to repo owner
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [
        "repo:kingchappers@${var.github_owner_id}/${var.github_repo}@${var.github_repo_id}:ref:refs/heads/main",
        "repo:kingchappers@${var.github_owner_id}/${var.github_repo}@${var.github_repo_id}:pull_request"
      ]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "github_actions_role" {
  name               = "github-actions"
  assume_role_policy = data.aws_iam_policy_document.assume_role.json

  tags = {
    Environment = var.environment
    ManagedBy   = "terraform"
    Application = var.app_name
  }
}

# ============================================================================
# IAM Policy for GitHub Actions (INFRA-01 - Least Privilege)
# ============================================================================

data "aws_iam_policy_document" "github_iam_policy_document" {
  # Lambda function management
  # TEMPORARY: Includes both old (budget-app) and new (budget-app-v3-ai-edition) names for migration
  statement {
    sid    = "LambdaFunctionManagement"
    effect = "Allow"
    actions = [
      "lambda:CreateFunction",
      "lambda:DeleteFunction",
      "lambda:GetFunction",
      "lambda:GetFunctionCodeSigningConfig",
      "lambda:ListVersionsByFunction",
      "lambda:UpdateFunctionCode",
      "lambda:UpdateFunctionConfiguration",
      "lambda:TagResource",
      "lambda:UntagResource",
    ]
    resources = [
      "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:budget-app",
      "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:budget-app-*",
      "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${var.app_name}",
      "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${var.app_name}-*"
    ]
  }

  # Lambda permissions management
  statement {
    sid    = "LambdaPermissions"
    effect = "Allow"
    actions = [
      "lambda:AddPermission",
      "lambda:RemovePermission",
      "lambda:GetPolicy",
    ]
    resources = [
      "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:budget-app",
      "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:budget-app-*",
      "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${var.app_name}",
      "arn:aws:lambda:${var.aws_region}:${data.aws_caller_identity.current.account_id}:function:${var.app_name}-*"
    ]
  }

  # IAM role management for Lambda execution
  # TEMPORARY: Includes both old and new names for migration
  statement {
    sid    = "IAMRoleManagement"
    effect = "Allow"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:ListAttachedRolePolicies",
      "iam:ListRolePolicies",
      "iam:UpdateRole",
      "iam:UpdateRoleDescription",
      "iam:TagRole",
      "iam:UntagRole",
    ]
    resources = [
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/budget-app-*",
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.app_name}-*"
    ]
  }

  # IAM policy attachment for Lambda execution role
  # TEMPORARY: Includes both old and new names for migration
  statement {
    sid    = "IAMPolicyAttachment"
    effect = "Allow"
    actions = [
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
    ]
    resources = [
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/budget-app-*",
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.app_name}-*"
    ]
    # Only allow attaching AWS managed Lambda execution policy
    condition {
      test     = "ArnEquals"
      variable = "iam:PolicyARN"
      values   = ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"]
    }
  }

  # Inline role policies on the Lambda execution role (e.g. DynamoDB data access)
  # TEMPORARY: Includes both old and new names for migration
  statement {
    sid    = "IAMInlineRolePolicy"
    effect = "Allow"
    actions = [
      "iam:PutRolePolicy",
      "iam:GetRolePolicy",
      "iam:DeleteRolePolicy",
    ]
    resources = [
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/budget-app-*",
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.app_name}-*"
    ]
  }

  # PassRole for Lambda to assume execution role
  # TEMPORARY: Includes both old and new names for migration
  statement {
    sid    = "PassRoleToLambda"
    effect = "Allow"
    actions = [
      "iam:PassRole"
    ]
    resources = [
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/budget-app-*",
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.app_name}-*"
    ]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["lambda.amazonaws.com"]
    }
  }

  # API Gateway management (v1 REST APIs and v2 HTTP APIs)
  statement {
    sid    = "APIGatewayManagement"
    effect = "Allow"
    actions = [
      "apigateway:DELETE",
      "apigateway:GET",
      "apigateway:PATCH",
      "apigateway:POST",
      "apigateway:PUT",
      "apigateway:TagResource",
      "apigateway:UntagResource",
    ]
    resources = concat(
      [
        "arn:aws:apigateway:${var.aws_region}::/apis",
        "arn:aws:apigateway:${var.aws_region}::/apis/*",
        "arn:aws:apigateway:${var.aws_region}::/v2/apis",
        "arn:aws:apigateway:${var.aws_region}::/v2/apis/*",
        "arn:aws:apigateway:${var.aws_region}::/tags/*",
        "arn:aws:apigateway:${var.aws_region}::/domainnames",
      ],
      # Only the app's own custom domains, and what hangs beneath them (their API mappings)
      flatten([
        for domain in concat([var.custom_domain], var.additional_custom_domains) : [
          "arn:aws:apigateway:${var.aws_region}::/domainnames/${domain}",
          "arn:aws:apigateway:${var.aws_region}::/domainnames/${domain}/*",
          "arn:aws:apigateway:${var.aws_region}::/v2/domainnames/${domain}",
          "arn:aws:apigateway:${var.aws_region}::/v2/domainnames/${domain}/*",
        ]
      ])
    )
  }

  # CloudWatch Logs for Lambda and API Gateway (resource-specific)
  # TEMPORARY: Includes both old and new names for migration
  statement {
    sid    = "CloudWatchLogsManagement"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:DeleteLogGroup",
      "logs:ListTagsForResource",
      "logs:PutRetentionPolicy",
      "logs:DeleteRetentionPolicy",
      "logs:TagResource",
      "logs:UntagResource",
    ]
    resources = [
      "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/budget-app*",
      "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/apigateway/budget-app*",
      "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.app_name}*",
      "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/apigateway/${var.app_name}*",
      # Custom-named log groups (/${app_name}/lambda/{static,api}), distinct
      # from the AWS-default /aws/lambda/* naming pattern above.
      "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/${var.app_name}/lambda/*"
    ]
  }

  # CloudWatch Logs list operations (require wildcard resource)
  statement {
    sid       = "CloudWatchLogsListOperations"
    effect    = "Allow"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }

  # CloudWatch Logs resource policies for API Gateway
  statement {
    sid    = "CloudWatchLogsResourcePolicy"
    effect = "Allow"
    actions = [
      "logs:PutResourcePolicy",
      "logs:DeleteResourcePolicy",
      "logs:DescribeResourcePolicies",
    ]
    resources = ["*"]
  }

  # CloudWatch Logs delivery (required for API Gateway logging)
  statement {
    sid    = "CloudWatchLogsDelivery"
    effect = "Allow"
    actions = [
      "logs:ListLogDeliveries",
      "logs:GetLogDelivery",
      "logs:CreateLogDelivery",
      "logs:UpdateLogDelivery",
      "logs:DeleteLogDelivery",
    ]
    resources = ["*"]
  }

  # DynamoDB table management for the application data store (INFRA-01)
  # Scoped to the app table; covers create/update/delete plus the describe
  # calls the AWS provider makes on read-back (PITR, TTL, tags).
  statement {
    sid    = "DynamoDBTableManagement"
    effect = "Allow"
    actions = [
      "dynamodb:CreateTable",
      "dynamodb:DeleteTable",
      "dynamodb:DescribeTable",
      "dynamodb:UpdateTable",
      "dynamodb:DescribeContinuousBackups",
      "dynamodb:UpdateContinuousBackups",
      "dynamodb:DescribeTimeToLive",
      "dynamodb:UpdateTimeToLive",
      "dynamodb:ListTagsOfResource",
      "dynamodb:TagResource",
      "dynamodb:UntagResource",
    ]
    resources = [
      "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/${var.app_name}-*"
    ]
  }

  # EventBridge rule that runs the bill reminder scheduler (INFRA-01)
  # Scoped to rules named after the app. events:TagResource is needed because the rule is tagged.
  statement {
    sid    = "EventBridgeRuleManagement"
    effect = "Allow"
    actions = [
      "events:PutRule",
      "events:DeleteRule",
      "events:DescribeRule",
      "events:EnableRule",
      "events:DisableRule",
      "events:PutTargets",
      "events:RemoveTargets",
      "events:ListTargetsByRule",
      "events:ListTagsForResource",
      "events:TagResource",
      "events:UntagResource",
    ]
    resources = [
      "arn:aws:events:${var.aws_region}:${data.aws_caller_identity.current.account_id}:rule/${var.app_name}-*"
    ]
  }

  # S3 state bucket access (read state, write plan/apply results)
  statement {
    sid    = "TerraformStateAccess"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:ListBucket",
    ]
    resources = [
      "arn:aws:s3:::${var.state_bucket}",
      "arn:aws:s3:::${var.state_bucket}/*"
    ]
  }

  # STS GetCallerIdentity for data sources
  statement {
    sid       = "STSGetCallerIdentity"
    effect    = "Allow"
    actions   = ["sts:GetCallerIdentity"]
    resources = ["*"]
  }

  # ACM Certificate access 
  statement {
    sid    = "AcmCertificateAccess"
    effect = "Allow"
    actions = [
      "acm:RequestCertificate",
      "acm:DescribeCertificate",
      "acm:ListCertificates",
      "acm:GetCertificate",
      "acm:ListTagsForCertificate",
      "acm:AddTagsToCertificate",
      "acm:RemoveTagsFromCertificate",
      "acm:RequestCertificate",
      "acm:DeleteCertificate",
      "acm:UpdateCertificateOptions"
    ]
    resources = [
      "arn:aws:acm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:certificate*",
    ]
  }
}

resource "aws_iam_policy" "github_actions_iam_policy" {
  name        = "github-actions-iam-policy"
  description = "Scoped policy for GitHub Actions to deploy ${var.app_name} infrastructure"
  policy      = data.aws_iam_policy_document.github_iam_policy_document.json

  tags = {
    Environment = var.environment
    ManagedBy   = "terraform"
    Application = var.app_name
  }
}

resource "aws_iam_role_policy_attachment" "github_actions_role_policy_attach" {
  role       = aws_iam_role.github_actions_role.name
  policy_arn = aws_iam_policy.github_actions_iam_policy.arn
}

# ============================================================================
# Outputs
# ============================================================================

output "github_actions_role_arn" {
  value       = aws_iam_role.github_actions_role.arn
  description = "ARN of the GitHub Actions IAM role"
}

output "oidc_provider_arn" {
  value       = aws_iam_openid_connect_provider.github_actions.arn
  description = "ARN of the GitHub OIDC provider"
}

output "state_bucket_name" {
  value       = aws_s3_bucket.terraform_state.id
  description = "Name of the Terraform state bucket"
}
