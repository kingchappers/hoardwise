# Static file Lambda execution role (logs only — no data access)
resource "aws_iam_role" "lambda_role" {
  name = "${var.app_name}-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })

  description = "Role for the Lambda function of the budget-app"
}

# Attach basic Lambda execution policy
resource "aws_iam_role_policy_attachment" "lambda_basic_execution" {
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
  role       = aws_iam_role.lambda_role.name
}

# Archive the build output
data "archive_file" "lambda_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../build/client"
  output_path = "${path.module}/lambda_function.zip"
}

# Lambda function
resource "aws_lambda_function" "app" {
  filename         = data.archive_file.lambda_zip.output_path
  function_name    = var.app_name
  role             = aws_iam_role.lambda_role.arn
  handler          = "index.handler"
  runtime          = "nodejs24.x"
  timeout          = 30
  memory_size      = 512
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256

  environment {
    variables = {
      NODE_ENV             = "production"
      VITE_AUTH0_DOMAIN    = var.auth0_domain
      VITE_AUTH0_CLIENT_ID = var.auth0_client_id
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.static_lambda.name
  }

  tags = {
    Environment = var.environment
    ManagedBy   = "OpenTofu"
  }
}

# API Gateway REST API
resource "aws_apigatewayv2_api" "app" {
  name          = "${var.app_name}-api"
  description   = "API for the budget application"
  protocol_type = "HTTP"

  # No cors_configuration block: the SPA and the API share this same gateway
  # origin, so browser calls are same-origin and need no CORS grant. Adding
  # allow_origins = ["*"] here would let any external site call the API
  # cross-origin (HTTP-SECURITY, INFRA-05 review, 2026-09-12).

  api_key_selection_expression = "$request.header.x-api-key"
  version                      = 0.1

  tags = {
    Environment = var.environment
  }
}

# Integration between API Gateway and Lambda
resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.app.id
  integration_type       = "AWS_PROXY"
  integration_method     = "POST"
  payload_format_version = "2.0"
  integration_uri        = aws_lambda_function.app.invoke_arn
  description            = "Lambda integration for ${var.app_name}"
}

# Route all requests to Lambda
resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.app.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

# Stage (deployment)
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.app.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_rate_limit  = 100
    throttling_burst_limit = 50
  }

  # /mcp is for assistants, not browsers: a tighter throttle bounds a flood (INFRA-01, AUTH-18).
  # It is shared by everyone. Referencing the route makes the stage wait for it to exist.
  route_settings {
    route_key              = aws_apigatewayv2_route.mcp.route_key
    throttling_rate_limit  = var.mcp_throttle_rate_limit
    throttling_burst_limit = var.mcp_throttle_burst_limit
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_logs.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      routeKey       = "$context.routeKey"
      status         = "$context.status"
      protocol       = "$context.protocol"
      responseLength = "$context.responseLength"
    })
  }

  tags = {
    Environment = var.environment
  }
}

####################################################################################################
# DNS Config
# ↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓↓
####################################################################################################

# ACM Certificate 
resource "aws_acm_certificate" "budget" {
  domain_name       = "budget.scgrid.xyz"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# Output the validation record so you can copy it into Porkbun
output "acm_validation_cname" {
  value = {
    for dvo in aws_acm_certificate.budget.domain_validation_options :
    dvo.domain_name => {
      name  = dvo.resource_record_name
      value = dvo.resource_record_value
    }
  }
}

# Wait for cert validation to complete (one-time, after you add the CNAME)
resource "aws_acm_certificate_validation" "budget" {
  certificate_arn = aws_acm_certificate.budget.arn
  # Hardcode the FQDN you added in Porkbun after first apply,
  # or use a data source to look it up. See note below.
  validation_record_fqdns = ["_b1b248fd28f0182e40eb25fac9dc4eea.budget.scgrid.xyz."]
}

# ─── API Gateway v2 (HTTP API) ─────────────────────────────────────

# ─── Custom Domain (v2) ────────────────────────────────────────────
resource "aws_apigatewayv2_domain_name" "default" {
  domain_name = "budget.scgrid.xyz"

  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.budget.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

# ─── API Mapping (replaces base_path_mapping) ──────────────────────
resource "aws_apigatewayv2_api_mapping" "app" {
  api_id      = aws_apigatewayv2_api.app.id
  domain_name = aws_apigatewayv2_domain_name.default.id
  stage       = aws_apigatewayv2_stage.default.id
}

# ─── Output the CNAME target for Porkbun ───────────────────────────
output "api_gateway_cname_target" {
  value = aws_apigatewayv2_domain_name.default.domain_name_configuration[0].target_domain_name
}

# ─── hoardwise.xyz hostname (alongside budget.scgrid.xyz) ──────────
resource "aws_acm_certificate" "hoardwise" {
  domain_name       = var.app_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# Add this CNAME at the DNS provider for hoardwise.xyz after the first apply
output "hoardwise_acm_validation_cname" {
  value = {
    for dvo in aws_acm_certificate.hoardwise.domain_validation_options :
    dvo.domain_name => {
      name  = dvo.resource_record_name
      value = dvo.resource_record_value
    }
  }
}

resource "aws_acm_certificate_validation" "hoardwise" {
  certificate_arn         = aws_acm_certificate.hoardwise.arn
  validation_record_fqdns = [for dvo in aws_acm_certificate.hoardwise.domain_validation_options : dvo.resource_record_name]
}

resource "aws_apigatewayv2_domain_name" "hoardwise" {
  domain_name = var.app_domain

  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.hoardwise.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

resource "aws_apigatewayv2_api_mapping" "hoardwise" {
  api_id      = aws_apigatewayv2_api.app.id
  domain_name = aws_apigatewayv2_domain_name.hoardwise.id
  stage       = aws_apigatewayv2_stage.default.id
}

# CNAME target for app.hoardwise.xyz
output "hoardwise_api_gateway_cname_target" {
  value = aws_apigatewayv2_domain_name.hoardwise.domain_name_configuration[0].target_domain_name
}

####################################################################################################
# ↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑
# DNS Config
####################################################################################################

# CloudWatch logs for API Gateway
resource "aws_cloudwatch_log_group" "api_logs" {
  name              = "/aws/apigateway/${var.app_name}"
  retention_in_days = 7

  tags = {
    Environment = var.environment
  }
}

# Grant API Gateway permission to create log streams and put log events
# into the `api_logs` log group. Without this resource policy API Gateway
# may fail with "Insufficient permissions to enable logging" when creating
# the $default stage.
resource "aws_cloudwatch_log_resource_policy" "apigateway_write" {
  policy_name = "APIGatewayPushToCloudWatchLogs-${var.app_name}"

  policy_document = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect    = "Allow",
        Principal = { Service = "apigateway.amazonaws.com" },
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:CreateLogGroup"
        ],
        Resource = "${aws_cloudwatch_log_group.api_logs.arn}:*"
      }
    ]
  })
}

# Lambda permission to be invoked by API Gateway
resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.app.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.app.execution_arn}/*/*"
}

# Outputs
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

output "api_endpoint" {
  value       = aws_apigatewayv2_stage.default.invoke_url
  description = "API Gateway endpoint URL"
}