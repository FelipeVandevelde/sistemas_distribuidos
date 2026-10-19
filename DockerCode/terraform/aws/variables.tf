variable "region" {
  description = "Região da AWS."
  type        = string
  default     = "sa-east-1"
}

variable "name_prefix" {
  description = "Prefixo dos nomes dos recursos."
  type        = string
  default     = "dockercode"
}

variable "instance_type" {
  description = "Tipo da instância (mínimo funcional: 2 vCPU / 4 GiB; recomendado: 2 vCPU / 8 GiB)."
  type        = string
  default     = "t3.large"
}

variable "root_volume_size_gb" {
  description = "Tamanho do disco raiz (gp3) em GiB. O padrão de 8 GiB não comporta as imagens de sandbox."
  type        = number
  default     = 30
}

variable "admin_username" {
  description = "Usuário padrão da AMI Ubuntu."
  type        = string
  default     = "ubuntu"
}

variable "ssh_public_key_path" {
  description = "Caminho da chave pública SSH usada para acessar a instância."
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

variable "use_elastic_ip" {
  description = "Associa um Elastic IP para o endereço não mudar após stop/start."
  type        = bool
  default     = true
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
