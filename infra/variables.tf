variable "aws_region" {
  description = "The AWS region to deploy resources in."
  type        = string
  default     = "eu-west-2"
}

variable "state_bucket" {
  description = "The name of the S3 bucket to store Terraform state."
  type        = string
}

variable "app_domain" {
  type        = string
  description = "The app's hoardwise.xyz hostname, served alongside the original budget.scgrid.xyz until that is retired."
  default     = "app.hoardwise.xyz"
}

variable "app_name" {
  # No default (matches state_bucket): this names/tags every resource in the
  # stack. A generic placeholder default here previously let a local
  # `tofu plan`/`apply` run without TF_VAR_app_name silently target "my-app"
  # instead of the real app, producing a plan that renamed and replaced the
  # entire production stack (Lambda functions, DynamoDB table, IAM roles).
  # CI always sets TF_VAR_app_name explicitly and was never at risk; this
  # only protected against that path, not local runs.
  description = "The name of the application."
  type        = string
}

variable "environment" {
  type    = string
  default = "production"
}

####################################################################
############## Variables from Claude Agent, reviewing ##############
####################################################################

variable "auth0_domain" {
  type        = string
  description = "Auth0 domain"
  sensitive   = true
}

variable "auth0_client_id" {
  type        = string
  description = "Auth0 client ID"
  sensitive   = true
}

variable "auth0_audience" {
  type        = string
  description = "Auth0 API audience identifier"
  sensitive   = true
}

# The public half of the VAPID key pair. Safe to expose in the browser (SEC-05); the
# private half lives only in SSM Parameter Store. Empty until the key pair is created.
variable "vapid_public_key" {
  type        = string
  description = "VAPID public key for web push. Leave empty until reminders are set up."
  default     = ""
}

# Who the push services can contact about this sender, as they require.
variable "vapid_subject" {
  type        = string
  description = "VAPID subject: an https address or mailto address that identifies this app."
  default     = "https://budget.scgrid.xyz"
}

# The gateway throttle on /mcp, shared by everyone (INFRA-01, AUTH-18). The per-user limit is in the handler.
variable "mcp_throttle_rate_limit" {
  type        = number
  description = "Steady requests per second allowed on /mcp, across all users."
  default     = 5
}

variable "mcp_throttle_burst_limit" {
  type        = number
  description = "Burst of requests allowed on /mcp, across all users."
  default     = 10
}
