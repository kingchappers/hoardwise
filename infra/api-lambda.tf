# ============================================================================
# API Lambda Function (separate from static file serving)
# ============================================================================

# API Lambda execution role (INFRA-01): DynamoDB access only
resource "aws_iam_role" "api_role" {
  name        = "${var.app_name}-api-role"
  description = "Execution role for the protected API Lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action    = "sts:AssumeRole"
        Effect    = "Allow"
        Principal = { Service = "lambda.amazonaws.com" }
      }
    ]
  })

  tags = {
    Environment = var.environment
    ManagedBy   = "OpenTofu"
  }
}

resource "aws_iam_role_policy_attachment" "api_basic_execution" {
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
  role       = aws_iam_role.api_role.name
}

# Archive the API handler
data "archive_file" "api_lambda_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../build/api"
  output_path = "${path.module}/api_lambda_function.zip"
}

# API Lambda function
resource "aws_lambda_function" "api" {
  filename         = data.archive_file.api_lambda_zip.output_path
  function_name    = "${var.app_name}-api"
  role             = aws_iam_role.api_role.arn
  handler          = "index.handler"
  runtime          = "nodejs24.x"
  timeout          = 30
  memory_size      = 512
  source_code_hash = data.archive_file.api_lambda_zip.output_base64sha256

  environment {
    variables = {
      NODE_ENV       = "production"
      AUTH0_DOMAIN   = var.auth0_domain
      AUTH0_AUDIENCE = var.auth0_audience
      DYNAMODB_TABLE = aws_dynamodb_table.budget_data.name
    }
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.api_lambda.name
  }

  tags = {
    Environment = var.environment
    ManagedBy   = "OpenTofu"
  }
}

# Integration between API Gateway and API Lambda
resource "aws_apigatewayv2_integration" "api_lambda" {
  api_id                 = aws_apigatewayv2_api.app.id
  integration_type       = "AWS_PROXY"
  integration_method     = "POST"
  payload_format_version = "2.0"
  integration_uri        = aws_lambda_function.api.invoke_arn
  description            = "API Lambda integration for ${var.app_name}"
}

# Route /api/* requests to the API Lambda
resource "aws_apigatewayv2_route" "api" {
  api_id    = aws_apigatewayv2_api.app.id
  route_key = "POST /api/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.api_lambda.id}"
}

resource "aws_apigatewayv2_route" "api_get" {
  api_id    = aws_apigatewayv2_api.app.id
  route_key = "GET /api/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.api_lambda.id}"
}

resource "aws_apigatewayv2_route" "api_head" {
  api_id    = aws_apigatewayv2_api.app.id
  route_key = "HEAD /api/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.api_lambda.id}"
}

resource "aws_apigatewayv2_route" "api_delete" {
  api_id    = aws_apigatewayv2_api.app.id
  route_key = "DELETE /api/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.api_lambda.id}"
}

resource "aws_apigatewayv2_route" "api_put" {
  api_id    = aws_apigatewayv2_api.app.id
  route_key = "PUT /api/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.api_lambda.id}"
}

# Route /mcp (access tokens only, scope checked per tool) to the API Lambda. Every method goes
# there, so GET and DELETE get the handler's 405 rather than the static Lambda's index.html.
resource "aws_apigatewayv2_route" "mcp" {
  api_id    = aws_apigatewayv2_api.app.id
  route_key = "ANY /mcp"
  target    = "integrations/${aws_apigatewayv2_integration.api_lambda.id}"
}

# Lambda permission for API Gateway to invoke API Lambda
resource "aws_lambda_permission" "api_gateway_api" {
  statement_id  = "AllowAPIGatewayInvokeApi"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.app.execution_arn}/*/*"
}
