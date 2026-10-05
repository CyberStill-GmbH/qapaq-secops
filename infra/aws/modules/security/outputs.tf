output "security_group_ids" {
  value = {
    alb      = aws_security_group.alb.id
    krakend  = aws_security_group.krakend.id
    api      = aws_security_group.api.id
    worker   = aws_security_group.worker.id
    postgres = aws_security_group.postgres.id
    redis    = aws_security_group.redis.id
    wazuh    = aws_security_group.wazuh.id
  }
}
