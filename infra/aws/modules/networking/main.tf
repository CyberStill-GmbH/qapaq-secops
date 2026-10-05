locals {
  azs = length(var.availability_zones) > 0 ? var.availability_zones : slice(data.aws_availability_zones.available.names, 0, var.az_count)

  public_subnet_cidrs = length(var.public_subnet_cidrs) > 0 ? var.public_subnet_cidrs : [
    for index in range(length(local.azs)) : cidrsubnet(var.vpc_cidr, 8, index)
  ]
  app_subnet_cidrs = length(var.app_subnet_cidrs) > 0 ? var.app_subnet_cidrs : [
    for index in range(length(local.azs)) : cidrsubnet(var.vpc_cidr, 8, index + 16)
  ]
  data_subnet_cidrs = length(var.data_subnet_cidrs) > 0 ? var.data_subnet_cidrs : [
    for index in range(length(local.azs)) : cidrsubnet(var.vpc_cidr, 8, index + 32)
  ]
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${var.project}-${var.environment}-vpc"
  }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${var.project}-${var.environment}-igw"
  }
}

resource "aws_subnet" "public" {
  for_each = { for index, az in local.azs : az => index }

  vpc_id                  = aws_vpc.this.id
  availability_zone       = each.key
  cidr_block              = local.public_subnet_cidrs[each.value]
  map_public_ip_on_launch = false

  tags = {
    Name = "${var.project}-${var.environment}-public-${each.value + 1}"
    Tier = "public"
  }
}

resource "aws_subnet" "app" {
  for_each = { for index, az in local.azs : az => index }

  vpc_id                  = aws_vpc.this.id
  availability_zone       = each.key
  cidr_block              = local.app_subnet_cidrs[each.value]
  map_public_ip_on_launch = false

  tags = {
    Name = "${var.project}-${var.environment}-app-${each.value + 1}"
    Tier = "private-application"
  }
}

resource "aws_subnet" "data" {
  for_each = { for index, az in local.azs : az => index }

  vpc_id                  = aws_vpc.this.id
  availability_zone       = each.key
  cidr_block              = local.data_subnet_cidrs[each.value]
  map_public_ip_on_launch = false

  tags = {
    Name = "${var.project}-${var.environment}-data-${each.value + 1}"
    Tier = "private-data"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${var.project}-${var.environment}-public"
  }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "app" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${var.project}-${var.environment}-app-isolated"
  }
}

resource "aws_route_table_association" "app" {
  for_each = aws_subnet.app

  subnet_id      = each.value.id
  route_table_id = aws_route_table.app.id
}

resource "aws_route_table" "data" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${var.project}-${var.environment}-data-isolated"
  }
}

resource "aws_route_table_association" "data" {
  for_each = aws_subnet.data

  subnet_id      = each.value.id
  route_table_id = aws_route_table.data.id
}
