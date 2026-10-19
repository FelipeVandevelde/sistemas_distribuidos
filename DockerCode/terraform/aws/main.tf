locals {
  cloud_init = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    admin_username = var.admin_username
    repo_url       = var.repo_url
    repo_ref       = var.repo_ref
    project_subdir = var.project_subdir
  })
}

# AMI Ubuntu 24.04 LTS mais recente, publicada pela Canonical via parâmetro público do SSM.
data "aws_ssm_parameter" "ubuntu_ami" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
}

data "aws_vpc" "default" {
  default = true
}

resource "aws_key_pair" "this" {
  key_name   = var.name_prefix
  public_key = file(pathexpand(var.ssh_public_key_path))
}

# Somente SSH (restrito) e o front-end (8080). 8081 (Submission API) e 15672 (RabbitMQ UI)
# ficam fechadas: o Security Group nega todo o tráfego de entrada que não esteja listado aqui.
resource "aws_security_group" "this" {
  name        = var.name_prefix
  description = "DockerCode: SSH restrito e front-end 8080"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.ssh_allowed_cidr]
  }

  ingress {
    description = "Front-end (Nginx)"
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = [var.app_allowed_cidr]
  }

  egress {
    description = "Saida liberada (pull de imagens, apt, git)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "this" {
  ami                         = data.aws_ssm_parameter.ubuntu_ami.value
  instance_type               = var.instance_type
  key_name                    = aws_key_pair.this.key_name
  vpc_security_group_ids      = [aws_security_group.this.id]
  associate_public_ip_address = true
  user_data                   = local.cloud_init
  user_data_replace_on_change = true

  root_block_device {
    volume_type = "gp3"
    volume_size = var.root_volume_size_gb
    encrypted   = true
  }

  # IMDSv2 obrigatório.
  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  tags = {
    Name = var.name_prefix
  }
}

resource "aws_eip" "this" {
  count    = var.use_elastic_ip ? 1 : 0
  instance = aws_instance.this.id
  domain   = "vpc"

  tags = {
    Name = var.name_prefix
  }
}
