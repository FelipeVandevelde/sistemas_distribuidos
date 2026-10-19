output "public_ip" {
  description = "IP público da VM."
  value       = azurerm_public_ip.this.ip_address
}

output "app_url" {
  description = "URL do front-end (disponível quando o bootstrap terminar, alguns minutos após o apply)."
  value       = "http://${azurerm_public_ip.this.ip_address}:8080"
}

output "ssh_command" {
  description = "Comando para acessar a VM."
  value       = "ssh ${var.admin_username}@${azurerm_public_ip.this.ip_address}"
}

output "bootstrap_log_command" {
  description = "Comando para acompanhar o bootstrap (Docker + docker compose up)."
  value       = "ssh ${var.admin_username}@${azurerm_public_ip.this.ip_address} 'tail -f /var/log/dockercode-bootstrap.log'"
}

output "resource_group_name" {
  description = "Grupo de recursos criado."
  value       = azurerm_resource_group.this.name
}
