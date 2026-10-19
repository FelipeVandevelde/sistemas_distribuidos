locals {
  public_ip = var.use_elastic_ip ? aws_eip.this[0].public_ip : aws_instance.this.public_ip
}

output "public_ip" {
  description = "IP público da instância."
  value       = local.public_ip
}

output "app_url" {
  description = "URL do front-end (disponível quando o bootstrap terminar, alguns minutos após o apply)."
  value       = "http://${local.public_ip}:8080"
}

output "ssh_command" {
  description = "Comando para acessar a instância (ajuste o caminho da chave privada)."
  value       = "ssh -i ~/.ssh/id_rsa ${var.admin_username}@${local.public_ip}"
}

output "bootstrap_log_command" {
  description = "Comando para acompanhar o bootstrap (Docker + docker compose up)."
  value       = "ssh -i ~/.ssh/id_rsa ${var.admin_username}@${local.public_ip} 'tail -f /var/log/dockercode-bootstrap.log'"
}

output "instance_id" {
  description = "ID da instância EC2."
  value       = aws_instance.this.id
}
