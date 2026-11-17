# SSH de administración sin depender de la IP pública del operador: EC2 Instance Connect Endpoint.
# El túnel se abre con la API de AWS (`aws ec2-instance-connect open-tunnel` / `ssh -o ProxyCommand`),
# autorizado por la sesión SSO del operador (ec2-instance-connect:OpenTunnel). No crea IAM, no
# expone el 22 a Internet y no requiere actualizar allowed_admin_cidrs cuando cambia la IP.
# Costo: el endpoint no tiene cargo por hora.

resource "aws_security_group" "eice" {
  name        = "${var.name}-eice"
  description = "EC2 Instance Connect Endpoint (salida SSH hacia el nodo)"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${var.name}-eice" }
}

resource "aws_vpc_security_group_egress_rule" "eice_to_node" {
  security_group_id            = aws_security_group.eice.id
  description                  = "SSH al nodo"
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
  referenced_security_group_id = aws_security_group.soc.id
}

resource "aws_vpc_security_group_ingress_rule" "node_ssh_from_eice" {
  security_group_id            = aws_security_group.soc.id
  description                  = "SSH desde EC2 Instance Connect Endpoint"
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
  referenced_security_group_id = aws_security_group.eice.id
}

resource "aws_ec2_instance_connect_endpoint" "admin" {
  subnet_id          = aws_subnet.public.id
  security_group_ids = [aws_security_group.eice.id]
  preserve_client_ip = false
  tags               = { Name = "${var.name}-eice" }
}

output "ssh_via_instance_connect" {
  description = "SSH al nodo por EC2 Instance Connect Endpoint (independiente de la IP pública)."
  value       = "ssh -i <clave> -o ProxyCommand='aws ec2-instance-connect open-tunnel --instance-id ${aws_instance.soc.id} --region ${var.aws_region}' ubuntu@${aws_instance.soc.id}"
}
