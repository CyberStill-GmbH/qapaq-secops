output "instance_id" {
  value = aws_instance.soc.id
}

output "public_ip" {
  value = aws_eip.soc.public_ip
}

output "url" {
  value = "https://${var.domain_name}"
}

output "ssh_command" {
  value = "ssh -i <clave-privada> ubuntu@${aws_eip.soc.public_ip}"
}

output "evidence_bucket" {
  value = aws_s3_bucket.evidence.bucket
}

output "kms_key_arn" {
  value = aws_kms_key.data.arn
}
