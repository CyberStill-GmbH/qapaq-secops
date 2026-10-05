output "vpc_id" {
  value = aws_vpc.this.id
}

output "public_subnet_ids" {
  value = [for az in sort(keys(aws_subnet.public)) : aws_subnet.public[az].id]
}

output "app_subnet_ids" {
  value = [for az in sort(keys(aws_subnet.app)) : aws_subnet.app[az].id]
}

output "data_subnet_ids" {
  value = [for az in sort(keys(aws_subnet.data)) : aws_subnet.data[az].id]
}

output "availability_zones" {
  value = local.azs
}
