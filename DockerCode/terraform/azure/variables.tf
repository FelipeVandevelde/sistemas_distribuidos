variable "subscription_id" {
  description = "ID da assinatura Azure. Se null, usa ARM_SUBSCRIPTION_ID."
  type        = string
  default     = null
}

variable "name_prefix" {
  description = "Prefixo dos nomes dos recursos."
  type        = string
  default     = "dockercode"
}

variable "location" {
  description = "Região do Azure. Se a SKU da VM não existir na região, troque a região ou a vm_size."
  type        = string
  default     = "brazilsouth"
}

variable "vm_size" {
  description = "Tamanho da VM (mínimo funcional: 2 vCPU / 4 GiB; recomendado: 2 vCPU / 8 GiB)."
  type        = string
  default     = "Standard_D2s_v5"
}

variable "os_disk_size_gb" {
  description = "Tamanho do disco do SO em GiB."
  type        = number
  default     = 64
}

variable "admin_username" {
  description = "Usuário administrador da VM."
  type        = string
  default     = "azureuser"
}

variable "ssh_public_key_path" {
  description = "Caminho da chave pública SSH usada para acessar a VM."
  type        = string
  default     = "~/.ssh/id_rsa.pub"
}

variable "ssh_allowed_cidr" {
  description = "CIDR autorizado a acessar SSH (22). Use o seu IP, ex.: 200.100.50.25/32."
  type        = string

  validation {
    condition     = can(cidrhost(var.ssh_allowed_cidr, 0)) && var.ssh_allowed_cidr != "0.0.0.0/0"
    error_message = "Informe um CIDR válido e diferente de 0.0.0.0/0 (restrinja o SSH ao seu IP)."
  }
}

variable "app_allowed_cidr" {
  description = "CIDR autorizado a acessar o front-end (8080)."
  type        = string
  default     = "0.0.0.0/0"
}

variable "repo_url" {
  description = "URL HTTPS do repositório Git com o projeto."
  type        = string
  default     = "https://github.com/FelipeVandevelde/sistemas_distribuidos.git"
}

variable "repo_ref" {
  description = "Branch ou tag a ser clonada."
  type        = string
  default     = "main"
}

variable "project_subdir" {
  description = "Subpasta do repositório onde está o docker-compose.yml."
  type        = string
  default     = "DockerCode"
}

variable "tags" {
  description = "Tags aplicadas aos recursos."
  type        = map(string)
  default     = { project = "dockercode" }
}
