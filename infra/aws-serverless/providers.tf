# Proveedor por defecto: región de la carga de trabajo.
provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}

# CloudFront, sus certificados ACM y el WebACL de alcance CLOUDFRONT viven en us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = local.common_tags
  }
}
