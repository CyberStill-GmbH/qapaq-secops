terraform {
  backend "s3" {
    bucket       = "qapaq-secops-terraform-state-123456789012"
    key          = "demo/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}