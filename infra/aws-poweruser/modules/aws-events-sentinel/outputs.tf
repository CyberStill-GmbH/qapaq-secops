output "topic_arn" {
  value = aws_sns_topic.this.arn
}

output "region" {
  value = data.aws_region.this.region
}
